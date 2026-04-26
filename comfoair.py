#!/usr/bin/env python3
"""
ComfoAir 350 / Wernig Q350 serial protocol driver.

Hardware: RS-232, 9600 baud, 8N1, no flow control.
Connect to the ComfoAir's RJ-45 service port via a real RS-232 level converter.

Frame format (PC -> unit and unit -> PC):

    07 F0 | CMD_H CMD_L | LEN | DATA[LEN] | CHK | 07 0F

  - 07 F0 .................. start of frame
  - CMD_H CMD_L ............. 2-byte command id
  - LEN ..................... number of payload bytes (0..N)
  - DATA .................... payload
  - CHK ..................... (sum(CMD_H..last DATA byte) + 0xAD) & 0xFF
  - 07 0F ................... end of frame

Special bytes:
  - 07 F3 ................... ACK (single short frame, no body)
  - any 0x07 byte inside CMD/LEN/DATA/CHK is doubled (07 -> 07 07) on the wire.

Handshake for a request:
  PC  -> unit:  request frame
  unit -> PC:   ACK (07 F3)
  unit -> PC:   response frame
  PC  -> unit:  ACK (07 F3)
"""

from __future__ import annotations

import argparse
import struct
import sys
import time
from dataclasses import dataclass

import serial  # pyserial


START = b"\x07\xf0"
END = b"\x07\x0f"
ACK = b"\x07\xf3"

# Request command -> expected response command. Response command is request + 1.
CMD_GET_FIRMWARE = (0x00, 0x69)
CMD_GET_VENT_LEVELS = (0x00, 0xCD)        # 0xCE response: levels & current step
CMD_GET_TEMPERATURES = (0x00, 0xD1)       # 0xD2 response: comfort + 4 sensors
CMD_GET_FAN_STATE = (0x00, 0x0B)          # 0x0C response: fan % and RPM
CMD_GET_HOURS = (0x00, 0xDD)              # 0xDE response: operating hours
CMD_GET_BYPASS = (0x00, 0x0D)             # 0x0E response: bypass / preheater
CMD_GET_ERRORS = (0x00, 0xD9)             # 0xDA response: error flags
CMD_SET_LEVEL = (0x00, 0x99)              # data: 0x01..0x04
CMD_SET_COMFORT_TEMP = (0x00, 0xD3)       # data: 1 byte, raw = (T_C + 20) * 2
CMD_SET_VENT_LEVELS = (0x00, 0xCF)        # data: 8 bytes, % per level
CMD_RESET = (0x00, 0xDB)                  # data: [errors, settings, filter, selftest]

LEVEL_NAMES = {
    1: "away",
    2: "low",
    3: "medium",
    4: "high",
}


def _checksum(payload: bytes) -> int:
    return (sum(payload) + 0xAD) & 0xFF


def _escape(data: bytes) -> bytes:
    return data.replace(b"\x07", b"\x07\x07")


def _unescape(data: bytes) -> bytes:
    return data.replace(b"\x07\x07", b"\x07")


def build_frame(cmd: tuple[int, int], data: bytes = b"") -> bytes:
    body = bytes([cmd[0], cmd[1], len(data)]) + data
    body += bytes([_checksum(body)])
    return START + _escape(body) + END


def parse_frame(buf: bytes) -> tuple[tuple[int, int], bytes]:
    """Validate a frame and return ((cmd_h, cmd_l), payload)."""
    if not (buf.startswith(START) and buf.endswith(END)):
        raise ValueError(f"bad frame delimiters: {buf.hex(' ')}")
    body = _unescape(buf[len(START):-len(END)])
    if len(body) < 4:
        raise ValueError(f"frame too short: {body.hex(' ')}")
    cmd_h, cmd_l, length = body[0], body[1], body[2]
    payload = body[3:3 + length]
    chk = body[3 + length]
    expected = _checksum(body[:3 + length])
    if chk != expected:
        raise ValueError(f"checksum mismatch: got {chk:02x}, want {expected:02x}")
    return (cmd_h, cmd_l), payload


@dataclass
class Temperatures:
    comfort: float          # setpoint
    outside_air: float      # T1, intake from outside
    supply_air: float       # T2, into the building (post heat-exchanger)
    return_air: float       # T3, extracted from building
    exhaust_air: float      # T4, blown back outside

    @classmethod
    def from_payload(cls, p: bytes) -> "Temperatures":
        # Each byte: T = raw/2 - 20
        def t(b): return b / 2 - 20
        return cls(t(p[0]), t(p[1]), t(p[2]), t(p[3]), t(p[4]))


@dataclass
class FanState:
    supply_pct: int
    exhaust_pct: int
    supply_rpm: int
    exhaust_rpm: int

    @classmethod
    def from_payload(cls, p: bytes) -> "FanState":
        # Bytes 0,1: percentages. Bytes 2-3 / 4-5: RPM divisor (big-endian).
        sup_div = struct.unpack(">H", p[2:4])[0]
        exh_div = struct.unpack(">H", p[4:6])[0]
        sup_rpm = int(1875000 / sup_div) if sup_div else 0
        exh_rpm = int(1875000 / exh_div) if exh_div else 0
        return cls(p[0], p[1], sup_rpm, exh_rpm)


@dataclass
class VentLevels:
    """Fan percentages programmed for each step plus the current step."""
    exhaust_away: int
    exhaust_low: int
    exhaust_medium: int
    supply_away: int
    supply_low: int
    supply_medium: int
    current_exhaust: int   # current exhaust %
    current_supply: int    # current supply %
    current_level: int     # 1..4
    high_enabled: bool
    exhaust_high: int
    supply_high: int

    @classmethod
    def from_payload(cls, p: bytes) -> "VentLevels":
        return cls(
            exhaust_away=p[0],
            exhaust_low=p[1],
            exhaust_medium=p[2],
            supply_away=p[3],
            supply_low=p[4],
            supply_medium=p[5],
            current_exhaust=p[6],
            current_supply=p[7],
            current_level=p[8],
            high_enabled=bool(p[9]) if len(p) > 9 else False,
            exhaust_high=p[10] if len(p) > 10 else 0,
            supply_high=p[11] if len(p) > 11 else 0,
        )


@dataclass
class Hours:
    away: int
    low: int
    medium: int
    high: int
    filter: int

    @classmethod
    def from_payload(cls, p: bytes) -> "Hours":
        # 3-byte big-endian counters per level. Filter hours position differs
        # between firmware revs; the layout below matches CA350 v3.x.
        def u24(off): return (p[off] << 16) | (p[off + 1] << 8) | p[off + 2]
        return cls(
            away=u24(0),
            low=u24(3),
            medium=u24(6),
            high=u24(15) if len(p) >= 18 else 0,
            filter=struct.unpack(">H", p[15:17])[0] if len(p) >= 17 else 0,
        )


class ComfoAir:
    def __init__(self, port: str, timeout: float = 1.5, debug: bool = False):
        self.debug = debug
        self.ser = serial.Serial(
            port=port,
            baudrate=9600,
            bytesize=8,
            parity=serial.PARITY_NONE,
            stopbits=1,
            timeout=timeout,
        )

    def close(self) -> None:
        self.ser.close()

    def __enter__(self): return self
    def __exit__(self, *exc): self.close()

    # --- low-level I/O -------------------------------------------------

    def _log(self, direction: str, data: bytes) -> None:
        if self.debug and data:
            print(f"  {direction} {data.hex(' ')}", file=sys.stderr)

    def _read_frame(self) -> bytes:
        """Read bytes until a complete framed message is in hand."""
        deadline = time.monotonic() + (self.ser.timeout or 1.5) * 4
        buf = bytearray()
        while time.monotonic() < deadline:
            chunk = self.ser.read(64)
            if chunk:
                self._log("RX", chunk)
                buf.extend(chunk)
                # Look for the first START..END that isn't a bare ACK.
                while True:
                    if buf[:2] == ACK:
                        del buf[:2]
                        continue
                    s = buf.find(START)
                    if s < 0:
                        buf.clear()
                        break
                    if s > 0:
                        del buf[:s]
                    # Find END but skip escaped 07 07 sequences.
                    e = 2
                    while e < len(buf) - 1:
                        if buf[e] == 0x07:
                            if buf[e + 1] == 0x07:
                                e += 2
                                continue
                            if buf[e + 1] == 0x0F:
                                return bytes(buf[: e + 2])
                        e += 1
                    break
        if buf and self.debug:
            print(f"  -- partial buffer at timeout: {bytes(buf).hex(' ')}",
                  file=sys.stderr)
        raise TimeoutError(
            "no full frame received "
            "(check wiring, port, RS-232 levels, and TX/RX swap)"
        )

    def _await_response(self) -> bool:
        """Read whatever comes back after a set command. Accept ACK alone, a
        response frame alone, or ACK+frame — different firmware revs differ."""
        deadline = time.monotonic() + (self.ser.timeout or 1.5) * 2
        buf = bytearray()
        while time.monotonic() < deadline:
            chunk = self.ser.read(64)
            if chunk:
                self._log("RX", chunk)
                buf.extend(chunk)
                if ACK in buf or (START in buf and END in buf
                                  and buf.find(END) > buf.find(START)):
                    if START in buf and END in buf:
                        self._log("TX", ACK)
                        self.ser.write(ACK)
                        self.ser.flush()
                    return True
        if buf and self.debug:
            print(f"  -- partial buffer at timeout: {bytes(buf).hex(' ')}",
                  file=sys.stderr)
        return False

    def _send(self, frame: bytes) -> None:
        self.ser.reset_input_buffer()
        self._log("TX", frame)
        self.ser.write(frame)
        self.ser.flush()

    def _request(self, cmd: tuple[int, int], data: bytes = b"") -> bytes:
        self._send(build_frame(cmd, data))
        raw = self._read_frame()
        (rh, rl), payload = parse_frame(raw)
        expected = (cmd[0], (cmd[1] + 1) & 0xFF)
        if (rh, rl) != expected:
            raise ValueError(
                f"unexpected response cmd {rh:02x}{rl:02x}, "
                f"expected {expected[0]:02x}{expected[1]:02x}"
            )
        self._log("TX", ACK)
        self.ser.write(ACK)
        self.ser.flush()
        return payload

    def _command(self, cmd: tuple[int, int], data: bytes = b"") -> None:
        """Send a 'set' command and wait for any acknowledgement."""
        self._send(build_frame(cmd, data))
        if not self._await_response():
            raise TimeoutError("no ACK or response after set command")

    # --- high-level API -----------------------------------------------

    def firmware(self) -> str:
        p = self._request(CMD_GET_FIRMWARE)
        # Bytes 0..2 typically: major, minor, beta. Trailing bytes hold the
        # device name (ASCII, may be space-padded).
        ver = f"{p[0]}.{p[1]}.{p[2]}"
        name = p[3:13].rstrip(b" \x00").decode("ascii", errors="replace")
        return f"{ver} ({name})" if name else ver

    def temperatures(self) -> Temperatures:
        return Temperatures.from_payload(self._request(CMD_GET_TEMPERATURES))

    def fan_state(self) -> FanState:
        return FanState.from_payload(self._request(CMD_GET_FAN_STATE))

    def vent_levels(self) -> VentLevels:
        return VentLevels.from_payload(self._request(CMD_GET_VENT_LEVELS))

    def hours(self) -> Hours:
        return Hours.from_payload(self._request(CMD_GET_HOURS))

    def bypass_raw(self) -> bytes:
        return self._request(CMD_GET_BYPASS)

    def errors_raw(self) -> bytes:
        return self._request(CMD_GET_ERRORS)

    def set_level(self, level: int) -> None:
        if level not in (1, 2, 3, 4):
            raise ValueError("level must be 1 (away), 2 (low), 3 (medium), 4 (high)")
        self._command(CMD_SET_LEVEL, bytes([level]))

    def set_comfort_temperature(self, temp_c: float) -> None:
        if not 12.0 <= temp_c <= 28.0:
            raise ValueError("comfort temperature must be between 12 and 28 °C")
        raw = round((temp_c + 20.0) * 2)
        self._command(CMD_SET_COMFORT_TEMP, bytes([raw]))

    def reset_filter(self) -> None:
        # 4-byte payload: [reset_errors, reset_settings, reset_filter, run_self_test]
        self._command(CMD_RESET, bytes([0, 0, 1, 0]))

    def set_levels(self,
                   exhaust_away: int, exhaust_low: int,
                   exhaust_medium: int, exhaust_high: int,
                   supply_away: int, supply_low: int,
                   supply_medium: int, supply_high: int) -> None:
        """Reprogram the percentage setpoints for all four ventilation levels."""
        values = (exhaust_away, exhaust_low, exhaust_medium,
                  supply_away, supply_low, supply_medium,
                  exhaust_high, supply_high)
        for v in values:
            if not 0 <= v <= 100:
                raise ValueError(f"percentage out of range: {v}")
        self._command(CMD_SET_VENT_LEVELS, bytes(values))


def dump_all(ca: ComfoAir) -> None:
    print(f"Firmware:        {ca.firmware()}")

    t = ca.temperatures()
    print("Temperatures (°C):")
    print(f"  comfort        {t.comfort:5.1f}")
    print(f"  outside air    {t.outside_air:5.1f}")
    print(f"  supply air     {t.supply_air:5.1f}")
    print(f"  return air     {t.return_air:5.1f}")
    print(f"  exhaust air    {t.exhaust_air:5.1f}")

    f = ca.fan_state()
    print("Fans:")
    print(f"  supply         {f.supply_pct:3d} %   {f.supply_rpm:5d} rpm")
    print(f"  exhaust        {f.exhaust_pct:3d} %   {f.exhaust_rpm:5d} rpm")

    v = ca.vent_levels()
    print(f"Current level:   {v.current_level} ({LEVEL_NAMES.get(v.current_level, '?')})")
    print("Programmed level percentages (supply / exhaust):")
    print(f"  away    {v.supply_away:3d} / {v.exhaust_away:3d}")
    print(f"  low     {v.supply_low:3d} / {v.exhaust_low:3d}")
    print(f"  medium  {v.supply_medium:3d} / {v.exhaust_medium:3d}")
    print(f"  high    {v.supply_high:3d} / {v.exhaust_high:3d}")

    h = ca.hours()
    print("Operating hours:")
    print(f"  away   {h.away}")
    print(f"  low    {h.low}")
    print(f"  medium {h.medium}")
    print(f"  high   {h.high}")
    print(f"  filter {h.filter}")

    print(f"Bypass raw:      {ca.bypass_raw().hex(' ')}")
    print(f"Errors raw:      {ca.errors_raw().hex(' ')}")


def cmd_list_ports() -> None:
    from serial.tools import list_ports
    ports = list(list_ports.comports())
    if not ports:
        print("(no serial ports found)")
        return
    for p in ports:
        print(f"{p.device:30s}  {p.description}")


def cmd_probe(port: str, debug: bool) -> None:
    """Send a temperature request and print every byte that comes back for 3s."""
    print(f"Opening {port} at 9600 8N1, sending GetTemperatures, listening 3 s...")
    with ComfoAir(port, debug=debug) as ca:
        frame = build_frame(CMD_GET_TEMPERATURES)
        print(f"TX: {frame.hex(' ')}")
        ca.ser.reset_input_buffer()
        ca.ser.write(frame)
        ca.ser.flush()
        deadline = time.monotonic() + 3.0
        rx = bytearray()
        while time.monotonic() < deadline:
            chunk = ca.ser.read(64)
            if chunk:
                rx.extend(chunk)
        if rx:
            print(f"RX ({len(rx)} bytes): {bytes(rx).hex(' ')}")
        else:
            print("RX: (nothing)")
            print()
            print("Nothing came back. Likely causes:")
            print("  - wrong serial port (try `list-ports`)")
            print("  - TTL adapter instead of real RS-232 levels")
            print("  - TX/RX swapped or GND not connected")
            print("  - wrong RJ-45 pinout on the ComfoAir service port")


def main() -> int:
    ap = argparse.ArgumentParser(description="Wernig Q350 / Zehnder ComfoAir 350 driver")
    ap.add_argument("-p", "--port", help="serial port, e.g. /dev/tty.usbserial-XXXX or COM3")
    ap.add_argument("--debug", action="store_true",
                    help="print all serial TX/RX bytes to stderr")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("read", help="read all parameters")
    sub.add_parser("list-ports", help="list available serial ports")
    sub.add_parser("probe", help="send a single request and dump raw bytes (diagnostic)")

    s = sub.add_parser("level", help="set ventilation level")
    s.add_argument("level", choices=["away", "low", "medium", "high", "1", "2", "3", "4"])

    s = sub.add_parser("comfort-temp", help="set comfort temperature (12..28 °C)")
    s.add_argument("temp", type=float, help="target temperature in °C")

    sub.add_parser("reset-filter", help="reset the filter-change timer")

    s = sub.add_parser("set-level-pct",
                       help="reprogram the supply/exhaust % for one level "
                            "(reads the others, sends all four)")
    s.add_argument("level", choices=["away", "low", "medium", "high"])
    s.add_argument("exhaust", type=int, help="exhaust fan % (0..100)")
    s.add_argument("supply", type=int, help="supply fan % (0..100)")

    s = sub.add_parser("set-levels",
                       help="reprogram all four levels at once")
    s.add_argument("--exhaust", required=True,
                   help="exhaust %% per level: away,low,medium,high")
    s.add_argument("--supply", required=True,
                   help="supply %% per level: away,low,medium,high")

    args = ap.parse_args()

    if args.cmd == "list-ports":
        cmd_list_ports()
        return 0
    if not args.port:
        ap.error("--port is required for this command")
    if args.cmd == "probe":
        cmd_probe(args.port, args.debug)
        return 0

    with ComfoAir(args.port, debug=args.debug) as ca:
        if args.cmd == "read":
            dump_all(ca)
        elif args.cmd == "level":
            mapping = {"away": 1, "low": 2, "medium": 3, "high": 4,
                       "1": 1, "2": 2, "3": 3, "4": 4}
            lvl = mapping[args.level]
            ca.set_level(lvl)
            print(f"Level set to {lvl} ({LEVEL_NAMES[lvl]}).")
        elif args.cmd == "comfort-temp":
            ca.set_comfort_temperature(args.temp)
            print(f"Comfort temperature set to {args.temp:.1f} °C.")
        elif args.cmd == "reset-filter":
            ca.reset_filter()
            print("Filter timer reset.")
        elif args.cmd == "set-level-pct":
            v = ca.vent_levels()
            exh = [v.exhaust_away, v.exhaust_low, v.exhaust_medium, v.exhaust_high]
            sup = [v.supply_away, v.supply_low, v.supply_medium, v.supply_high]
            idx = {"away": 0, "low": 1, "medium": 2, "high": 3}[args.level]
            exh[idx] = args.exhaust
            sup[idx] = args.supply
            ca.set_levels(*exh, *sup)
            print(f"Level {args.level}: exhaust {args.exhaust}%, supply {args.supply}%.")
        elif args.cmd == "set-levels":
            exh = [int(x) for x in args.exhaust.split(",")]
            sup = [int(x) for x in args.supply.split(",")]
            if len(exh) != 4 or len(sup) != 4:
                ap.error("--exhaust and --supply each need 4 comma-separated values")
            ca.set_levels(*exh, *sup)
            print("Levels reprogrammed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

## Changelog

### 2026-10-12 – timers survive redeploys
- **Bug (latent, same as Database Storage):** a redeploy killed the node's pending timers but kept its state, so
  whatever waited for such a timer could stay stuck until the next Node-RED restart.
- **Fix:** pending timers are also kept in context; a start-up inject (`*_restore`) and the first message after a
  (re)start re-create them, overdue ones at once. Core logic unchanged. Test: `test/restore.test.js`.

### 2026-10-08 – gas and water meters switched off
- Both meters are offline. Their MQTT inputs and the water reset inject are disabled (logic unchanged).

### 2026-10-08 – live
- Switched to live at 01:07, with the decided changes. The shadow run saw no traffic on either side (gas and water meters offline, no shower), so the switch relied on the unit tests and the difftest against the old code.

### 2026-10-07 – decided changes (shipped with the switch to v2)
- **Humidity:** an escalation `medium` → `high` during a run is sent at once.
- **Shower gate:** the first drain value after a restart only primes the filter; it no longer closes the gate.

### 2026-10-07 – v2: rewrite (replaces the old tab 4d374e6a.8febd, now disabled)
- **Structure:** 72 nodes became one generated function node with tested logic.
- **Behaviour is identical** (differential test against the old code; the shadow run had no traffic).
- **Not ported:** the old heating control, whose outputs were unwired (no effect).

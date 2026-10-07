## Changelog

### 2026-10-07 – decided changes (shipped with the switch to v2)
- **Humidity:** an escalation `medium` → `high` during a run is sent at once.
- **Shower gate:** the first drain value after a restart only primes the filter; it no longer closes the gate.

### 2026-10-07 – v2: rewrite (replaces the old tab 4d374e6a.8febd, now disabled)
- **Structure:** 72 nodes became one generated function node with tested logic.
- **Behaviour is identical** (shadow run plus a differential test against the old code).
- **Not ported:** the old heating control, whose outputs were unwired (no effect).

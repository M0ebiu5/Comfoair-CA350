## KWL Heizung – ventilation and meters

Rewrite of the old tab `4d374e6a.8febd` (2026-10-07): 72 nodes, of which only these parts had an
effect.

| # | Input | Logic | Output |
|---|---|---|---|
| 1 | bath humidity `sensor/status/humidity/eg_bad/ht/9` | ≥ 73 % → `high`, ≥ 63 % → `medium`; an escalation to `high` during a run is sent at once; `low` 20 min after the last trigger. Blocked while the shower gate is closed. | `red/cmd/comfoair/level` |
| 1b | shower drain `…/tr1/friwarue` | a change of ≥ 25 % closes the gate; it reopens 55 min after the last close (the first value after a start only primes) | – |
| 2 | PV balance, outdoor `undef/w3/0`, indoor `undef/ws/0`, 5-min pulse | ventilation time cycle: `medium` 10 min, `low` 120 min (day 8–19 h) / 180 min, `medium` 60 min at 11:00 | `red/cmd/comfoair/level`, `red/event/kwl` |
| 3 | `gasmeter/main/json` | changed value, `error == "no error"`, spike filter ±2 | `sensor/status/gas/kg_tr/gas` |
| 4 | `watermeter/main/json` | changed value, no error, rising only, spike filter ±100 (reset Mo/We/Fr/Su 03:00) | `sensor/status/water/kg_tr/water` |

### Decided 2026-10-07
- **Kept** (user decision, no change): the ventilation time cycle stays dormant while the
  outdoor sensor `undef/w3/0` doesn't report.
- **Fixed:** an escalation `medium` → `high` during a humidity run is sent at once. Before, it
  waited for the run to end.
- **Fixed:** the first drain value after a restart no longer closes the shower gate.
- **Not ported:** the old heating control, whose outputs were unwired.

### Proof
- **Shadow run** for gas, water and humidity.
- **`tools/difftest.js`** runs the old tab's own function code (aggregator, `check ventilation`,
  `Gate v2`) and Node-RED's real `rbe` against this core: 300 random runs with a mocked Vienna
  clock, 6221 comparisons, 0 differences (with the intended gate fix modelled on the old side). The mutation check finds 93 and 56 differences.

### Code
`src/core.js` (pure), `src/node.js` (glue), `node --test test/`, `node build.js`, `nr-deploy.sh flows.json`.

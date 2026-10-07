## KWL Heizung – ventilation and meters

Rewrite of the old tab `4d374e6a.8febd` (2026-10-07): 72 nodes, of which only these parts had an
effect.

| # | Input | Logic | Output |
|---|---|---|---|
| 1 | bath humidity `sensor/status/humidity/eg_bad/ht/9` | ≥ 73 % → `high`, ≥ 63 % → `medium`; only the first level of a run is sent; `low` 20 min after the last trigger. Blocked while the shower gate is closed. | `red/cmd/comfoair/level` |
| 1b | shower drain `…/tr1/friwarue` | a change of ≥ 25 % closes the gate; it reopens 55 min after the last close (the first value after a start counts as a change) | – |
| 2 | PV balance, outdoor `undef/w3/0`, indoor `undef/ws/0`, 5-min pulse | ventilation time cycle: `medium` 10 min, `low` 120 min (day 8–19 h) / 180 min, `medium` 60 min at 11:00 | `red/cmd/comfoair/level`, `red/event/kwl` |
| 3 | `gasmeter/main/json` | changed value, `error == "no error"`, spike filter ±2 | `sensor/status/gas/kg_tr/gas` |
| 4 | `watermeter/main/json` | changed value, no error, rising only, spike filter ±100 (reset Mo/We/Fr/Su 03:00) | `sensor/status/water/kg_tr/water` |

### Known problems, kept on purpose (decide one by one)
1. **The ventilation time cycle (2) is dormant.** It needs the outdoor sensor `undef/w3/0`, which
   doesn't report (no flow publishes it, and the old aggregator had never received it). If the
   sensor reports again, the cycle starts switching the ventilation.
2. **While a humidity run is active, an escalation (medium → high) is not sent.**
3. **The gate closes on the first drain value after every restart.**
4. **The heating control of the old tab is not ported:** both of its outputs were unwired, so it
   never switched anything.

### Proof
- **Shadow run** for gas, water and humidity.
- **`tools/difftest.js`** runs the old tab's own function code (aggregator, `check ventilation`,
  `Gate v2`) and Node-RED's real `rbe` against this core: 300 random runs with a mocked Vienna
  clock, 6221 comparisons, 0 differences. The mutation check finds 93 and 56 differences.

### Code
`src/core.js` (pure), `src/node.js` (glue), `node --test test/`, `node build.js`, `nr-deploy.sh flows.json`.

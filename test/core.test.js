'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core.js');

const T0 = Date.UTC(2026, 9, 7, 10, 0);
const MIN = 60;

function rig(hour = 14) {
  let state = core.initialState(), now = T0;
  const r = {
    out: [], timers: [], hour,
    get state() { return state; },
    at(sec) { now = T0 + sec * 1000; return r; },
    ev(ev) {
      const res = core.decide(state, { at: now, hour: r.hour, ...ev });
      state = res.state; r.out.push(...res.out); r.timers.push(...res.timers);
      return r;
    },
    mqtt(topic, payload) { return r.ev({ type: 'mqtt', topic, payload, retain: false }); },
    fire() {
      const due = r.timers.filter(t => t.at <= now).sort((a, b) => a.at - b.at);
      r.timers = r.timers.filter(t => t.at > now);
      for (const t of due) r.ev({ type: 'timer', key: t.key });
      return r;
    },
    take() { const o = r.out.map(x => [x.msg.topic, x.msg.payload]); r.out = []; return o; },
  };
  return r;
}
const HUM = 'sensor/status/humidity/eg_bad/ht/9', DRAIN = 'sensor/status/heating/kg_tr/tr1/friwarue';

test('humidity: >= 73 high, >= 63 medium, below nothing; low 20 min after the last trigger', () => {
  const r = rig().mqtt(HUM, { value: 60 });
  assert.deepEqual(r.take(), []);
  r.mqtt(HUM, { value: 65 });
  assert.deepEqual(r.take(), [['red/cmd/comfoair/level', 'medium']]);
  r.at(10 * MIN).mqtt(HUM, { value: 80 });
  assert.deepEqual(r.take(), [['red/cmd/comfoair/level', 'high']], 'escalation is sent at once (fix 2026-10-07)');
  r.at(12 * MIN).mqtt(HUM, { value: 65 });
  assert.deepEqual(r.take(), [], 'no step back to medium during the run');
  r.at(29 * MIN).fire();
  assert.deepEqual(r.take(), []);
  r.at(31 * MIN).fire();
  assert.deepEqual(r.take(), [], 'the 65 % at 12 min extended the run');
  r.at(32 * MIN).fire();
  assert.deepEqual(r.take(), [['red/cmd/comfoair/level', 'low']]);
});

test('shower gate: the first drain value only primes (fix 2026-10-07); a jump closes it for 55 min', () => {
  const r = rig().mqtt(DRAIN, '30.0').mqtt(HUM, { value: 90 });
  assert.deepEqual(r.take(), [['red/cmd/comfoair/level', 'high']], 'gate still open after the first value');
  r.at(21 * MIN).fire().take();
  r.at(25 * MIN).mqtt(DRAIN, '40.0');   // +33 %: closes
  r.mqtt(HUM, { value: 90 });
  assert.deepEqual(r.take(), [], 'gate closed');
  r.at(50 * MIN).mqtt(DRAIN, '41.0');   // +2.5 %: no new close
  r.at(80 * MIN).fire().mqtt(HUM, { value: 90 });
  assert.deepEqual(r.take(), [['red/cmd/comfoair/level', 'high']]);
});

test('ventilation cycle: dormant without the outdoor sensor; with all four topics medium 10 min, then low', () => {
  const r = rig(14)
    .mqtt('sensor/status/power/power/eme/balance', -17).mqtt('sensor/status/temperature/undef/ws/0', { value: 24 })
    .ev({ type: 'inject', name: 'pulse' });
  assert.deepEqual(r.take(), [], '3 of 4 topics: nothing (the situation on 2026-10-07)');
  r.mqtt('sensor/status/temperature/undef/w3/0', '12');
  assert.deepEqual(r.take(), [], 'first complete set only initialises');
  r.at(1).ev({ type: 'inject', name: 'pulse' });
  assert.deepEqual(r.take(), [], 'second call only measures the runtime (runtime 0 > runfor 0 is false)');
  r.at(2).ev({ type: 'inject', name: 'pulse' });
  assert.deepEqual(r.take(), [['red/cmd/comfoair/level', 'medium'], ['red/event/kwl', { value: 'medium', reason: 'default', label: '' }]]);
  r.at(11 * MIN).ev({ type: 'inject', name: 'pulse' });
  assert.deepEqual(r.take(), [], 'runtime is measured one call late (old code)');
  r.at(11 * MIN + 1).ev({ type: 'inject', name: 'pulse' });
  assert.deepEqual(r.take(), [['red/cmd/comfoair/level', 'low'], ['red/event/kwl', { value: 'low', reason: 'time limit', label: 'Lüftung (zeitgesteuert).' }]]);
});

test('gas meter: changed + no error -> number; spike filter +-2', () => {
  const r = rig()
    .mqtt('gasmeter/main/json', { value: '100.5', error: 'no error' })
    .mqtt('gasmeter/main/json', { value: '100.5', error: 'no error' })
    .mqtt('gasmeter/main/json', { value: '101.0', error: 'no error' })
    .mqtt('gasmeter/main/json', { value: '150.0', error: 'no error' })
    .mqtt('gasmeter/main/json', { value: '102.0', error: 'E1' });
  assert.deepEqual(r.take(), [['sensor/status/gas/kg_tr/gas', 100.5], ['sensor/status/gas/kg_tr/gas', 101]]);
});

test('water meter: first value only primes "previous", then rising values within +-100; reset clears the band', () => {
  const r = rig()
    .mqtt('watermeter/main/json', { value: 500, error: 'no error' })
    .mqtt('watermeter/main/json', { value: 510, error: 'no error' })
    .mqtt('watermeter/main/json', { value: 505, error: 'no error' })
    .mqtt('watermeter/main/json', { value: 700, error: 'no error' });
  assert.deepEqual(r.take(), [['sensor/status/water/kg_tr/water', 510]]);
  r.ev({ type: 'inject', name: 'water-reset' }).mqtt('watermeter/main/json', { value: 900, error: 'no error' });
  assert.deepEqual(r.take(), [['sensor/status/water/kg_tr/water', 900]]);
});

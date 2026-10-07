// Differential test: the OLD tab's function code (from the live flows) vs the new core, on random
// event sequences with a mocked clock (Europe/Vienna, like the Node-RED container).
// Covers the parts real traffic does not exercise: the dormant ventilation cycle and the shower gate.
// Usage: TZ=Europe/Vienna node tools/difftest.js <flows.json> [runs]
'use strict';
const fs = require('fs');
const core = require('../src/core.js');

if (process.env.TZ !== 'Europe/Vienna') { console.error('run with TZ=Europe/Vienna'); process.exit(2); }
const flows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const RUNS = Number(process.argv[3] || 300);
const OLD = '4d374e6a.8febd';
const code = (name, idPrefix) => flows.find(n => n.z === OLD && n.type === 'function' && n.name === name && (!idPrefix || n.id.startsWith(idPrefix))).func;

let NOW = 0, timers = [];
class FakeDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
const fakeSetInterval = (fn, ms) => { const t = { at: NOW + ms, ms, fn }; timers.push(t); return t; };
const fakeClear = t => { timers = timers.filter(x => x !== t); };
function advance(to) {
  for (;;) {
    const due = timers.filter(t => t.at <= to).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    NOW = due.at; due.at += due.ms; due.fn();
  }
  NOW = to;
}
function oldNode(src) {
  const ctx = {};
  const fn = new Function('msg', 'context', 'node', 'Date', 'setInterval', 'clearTimeout', 'RED', src);
  const sent = [];
  const node = { status() {}, warn() {}, send: m => sent.push(m) };
  const RED = { util: { cloneMessage: m => JSON.parse(JSON.stringify(m)) } };
  return { run: m => fn(JSON.parse(JSON.stringify(m)), { get: k => ctx[k], set: (k, v) => { ctx[k] = v; } }, node, FakeDate, fakeSetInterval, fakeClear, RED), sent };
}

// Node-RED's own rbe node, loaded behind a minimal fake RED (path given as 3rd arg or env RBE_JS)
function realRbe(config) {
  let Ctor;
  const RED = {
    nodes: { createNode() {}, registerType(name, c) { Ctor = c; } },
    util: {
      getMessageProperty: (m, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), m),
      compareObjects: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      cloneMessage: m => JSON.parse(JSON.stringify(m)),
    },
    _: k => k,
  };
  require(process.env.RBE_JS)(RED);
  const handlers = {}, sent = [];
  const self = Object.create(Ctor.prototype);
  self.on = (ev, fn) => { handlers[ev] = fn; };
  self.send = m => sent.push(m);
  self.warn = () => {};
  Ctor.call(self, config);
  return { run: m => { sent.length = 0; handlers.input.call(self, m); return sent.length > 0; } };
}

let rnd = 42;
const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
const TOPICS = core.CYCLE_TOPICS;
let compared = 0, diffs = 0;

for (let run = 0; run < RUNS; run++) {
  NOW = Date.UTC(2026, 0, 1) + Math.floor(rand() * 365) * 86400e3 + Math.floor(rand() * 86400e3);
  timers = [];
  const agg = oldNode(code('AJV10_1', '36c865')), vent = oldNode(code('check ventilation')), gate = oldNode(code('Gate v2', 'a91f36'));
  const drainCfg = flows.find(n => n.z === OLD && n.type === 'rbe' && n.id.startsWith('7e892a'));
  const drainRbe = realRbe(drainCfg);
  let seenDrain = false;
  let state = core.initialState();
  const newOut = [], oldOut = [];
  const step = ev => {
    const hour = new FakeDate(NOW).getHours();
    const r = core.decide(state, { at: NOW, hour, ...ev });
    state = r.state;
    for (const o of r.out) newOut.push([o.msg.topic, o.msg.payload]);
    for (const t of r.timers) pending.push(t);
  };
  let pending = [];
  const fireNew = () => {
    for (const t of pending.filter(t => t.at <= NOW).sort((a, b) => a.at - b.at)) step({ type: 'timer', key: t.key });
    pending = pending.filter(t => t.at > NOW);
  };
  const steps = 40 + Math.floor(rand() * 200);
  for (let i = 0; i < steps; i++) {
    advance(NOW + Math.floor(rand() * 40 * 60e3));   // up to 40 min between events
    fireNew();
    const k = rand();
    if (k < 0.7) {   // ventilation cycle inputs (sometimes without the outdoor sensor)
      const topic = TOPICS[Math.floor(rand() * (run % 5 === 0 ? 3 : 4))];
      const payload = topic === 'timestamp' ? NOW : String(Math.round(rand() * 40));
      const o = agg.run({ topic, payload });
      if (o) { const r = vent.run(o); if (r) for (const m of r) if (m) oldOut.push([m.topic, m.payload]); }
      if (topic === 'timestamp') step({ type: 'inject', name: 'pulse' }); else step({ type: 'mqtt', topic, payload, retain: false });
    } else if (k < 0.85) {   // shower gate closes
      const t = 'sensor/status/heating/kg_tr/tr1/friwarue', v = String(20 + Math.round(rand() * 20));
      const closed = drainRbe.run({ topic: t, payload: v });
      // intended change 2026-10-07: the first drain value after a start no longer closes the gate
      if (closed && seenDrain) gate.run({ topic: 'control', payload: 'close' });   // old: rbe -> close
      seenDrain = true;
      if (process.env.DEBUG && run === 0) console.log(new Date(NOW).toISOString().slice(5,16), 'drain', v, closed ? 'CLOSE' : '');
      step({ type: 'mqtt', topic: t, payload: v });
    } else {   // humidity through the gate: compare open/closed
      const passedOld = gate.run({ topic: 'sensor/status/humidity/eg_bad/ht/9', payload: { value: 10 } }) !== null;
      if (process.env.DEBUG && run === 0) console.log(new Date(NOW).toISOString().slice(5,16), 'humidity: old', passedOld ? 'open' : 'closed', '| new', state.gateClosed ? 'closed' : 'open', '| core timers pending', pending.filter(x => x.key.startsWith('gate')).map(x => new Date(x.at).toISOString().slice(11,16)));
      compared++;
      if (passedOld === state.gateClosed) { diffs++; if (diffs <= 5) console.log(`GATE DIFF run ${run}: old ${passedOld ? 'open' : 'closed'}, new ${state.gateClosed ? 'closed' : 'open'}`); }
    }
  }
  compared++;
  if (JSON.stringify(oldOut) !== JSON.stringify(newOut.filter(([t]) => t === 'red/cmd/comfoair/level' || t === 'red/event/kwl'))) {
    diffs++;
    if (diffs <= 5) console.log(`CYCLE DIFF run ${run}\n old ${JSON.stringify(oldOut).slice(0, 300)}\n new ${JSON.stringify(newOut).slice(0, 300)}`);
  }
}
console.log(`${RUNS} random runs, ${compared} comparisons, ${diffs} differences`);
process.exit(diffs ? 1 : 0);

// KWL Heizung (ventilation + gas/water meters) - decision core.
//
// Pure logic: decide(state, event) -> { state, out, timers, logs }; no Node-RED APIs, no clock
// (events carry `at` and the local Vienna hour `hour`). Faithful port of the live part of the old
// tab 4d374e6a.8febd. Its heating control is not ported: both of its outputs were unwired (no effect).
//
//   event: {type:'mqtt', topic, payload, retain, at, hour} | {type:'inject', name, at, hour} | {type:'timer', key, at, hour}
//   out:   {to:'mqtt', msg:{topic, payload, retain}}

'use strict';

const MIN = 60e3;
const LEVEL = 'red/cmd/comfoair/level';
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const get = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const publish = (ctx, topic, payload, retain, extra = {}) => ctx.out.push({ to: 'mqtt', msg: { topic, payload, retain: !!retain, ...extra } });
const token = s => String((s.seq = (s.seq || 0) + 1));

// Node-RED rbe node subset used here (per topic): 'rbe' and the numeric band modes with inout 'out'
function rbe(s, node, opt, topic, value) {
  if (value === undefined) return false;
  const prev = (s.rbe[node] = s.rbe[node] || {});
  const t = topic || '_no_topic';
  if (!opt.func) {
    const same = typeof value === 'object' ? JSON.stringify(value) === JSON.stringify(prev[t]) : value === prev[t];
    if (same) return false;
    prev[t] = clone(value);
    return true;
  }
  const n = parseFloat(value);
  if (isNaN(n)) return false;
  const pc = String(opt.gap).endsWith('%');
  if (prev[t] === undefined && (opt.func === 'narrowband' || opt.func === 'narrowbandEq')) prev[t] = n;
  const gap = pc ? (Math.abs(prev[t] * parseFloat(opt.gap) / 100) || 0) : Number(opt.gap);
  if (prev[t] === undefined) prev[t] = n - gap - 1;
  const d = Math.abs(n - prev[t]);
  const pass = d === gap ? (opt.func === 'deadbandEq' || opt.func === 'narrowband')
    : d > gap ? (opt.func === 'deadband' || opt.func === 'deadbandEq')
      : (opt.func === 'narrowband' || opt.func === 'narrowbandEq');
  if (pass) prev[t] = n;   // inout 'out'
  return pass;
}

// ---- 1. bath humidity -> ventilation level, unless the shower gate is closed -----------------
// "Gate v2": closed by a shower-drain temperature jump, reopened 55 min after the last close.
function humidity(s, ctx, now, m) {
  if (s.gateClosed) return;
  const v = get(m.payload, 'value');
  let level;
  if (v >= '73') level = 'high';        // old switch: string "73" (JS comparison semantics kept)
  else if (v >= 63) level = 'medium';
  else return;
  // trigger: this level at once, 'low' 20 min after the last message. An escalation during a run
  // (medium -> high) is sent at once too (2026-10-07; before, only the first level of a run was sent).
  const msg = { topic: LEVEL, payload: level, retain: m.retain };
  const running = s.kwlTrigger;
  if (!running || (running.level === 'medium' && level === 'high')) publish(ctx, LEVEL, level, m.retain);
  const tk = token(s);
  s.kwlTrigger = { token: tk, msg, level: running && running.level === 'high' ? 'high' : level };
  ctx.timers.push({ key: `kwl:${tk}`, at: now + 20 * MIN });
}

function showerDrain(s, ctx, now, m) {
  // the first value after a start only primes the filter (2026-10-07; before, it closed the gate
  // after every restart because Node-RED's deadband treats an unknown previous value as a jump)
  const primed = s.rbe.drain && s.rbe.drain[m.topic] !== undefined;
  if (!primed) {
    const n = parseFloat(m.payload);
    if (!isNaN(n)) (s.rbe.drain = s.rbe.drain || {})[m.topic] = n;
    return;
  }
  if (!rbe(s, 'drain', { func: 'deadbandEq', gap: '25%' }, m.topic, m.payload)) return;
  s.gateClosed = true;
  const tk = token(s);
  s.gateToken = tk;
  ctx.timers.push({ key: `gate:${tk}`, at: now + 55 * MIN });
}

// ---- 2. ventilation time cycle (dormant: needs the outdoor sensor undef/w3/0) ------------------
const CYCLE_TOPICS = ['sensor/status/power/power/eme/balance', 'sensor/status/temperature/undef/w3/0',
  'sensor/status/temperature/undef/ws/0', 'timestamp'];

function cycleInput(s, ctx, now, hour, topic) {
  s.cycleSeen[topic] = true;
  if (!CYCLE_TOPICS.every(t => s.cycleSeen[t])) return;   // old aggregator: all 4 topics present
  const v = s.vent || (s.vent = { runtime: 0, runfor: 0, start: now, state: 'undef', reason: 'default', label: '' });
  let oldstate = v.state;
  const day = hour > 7 && hour < 20;
  if (v.runtime > v.runfor * 60e3) {
    if (hour === 11) { v.runfor = 60; v.state = 'medium'; oldstate = ''; }
    else if (v.state === 'medium' || v.state === 'high') {
      v.state = 'low'; v.reason = 'time limit'; v.label = 'Lüftung (zeitgesteuert).';
      v.runfor = day ? 120 : 180; v.start = now;
    } else { v.runfor = 10; v.start = now; v.state = 'medium'; }
  }
  if (v.state === oldstate) { v.runtime = now - v.start; return; }
  v.runtime = 0;
  v.start = now;
  publish(ctx, LEVEL, v.state, false, { reason: v.reason });
  publish(ctx, 'red/event/kwl', { value: v.state, reason: v.reason, label: v.label }, false, { tst: now });
}

// ---- 3./4. gas and water meters ---------------------------------------------------------------
function meter(s, ctx, m, kind) {
  if (!rbe(s, `${kind}-changed`, {}, m.topic, get(m.payload, 'value'))) return;
  if (get(m.payload, 'error') != 'no error') return;   // eslint-disable-line eqeqeq
  const raw = get(m.payload, 'value');
  const value = typeof raw === 'number' ? raw : Number(raw);   // JSONata $number
  if (raw === undefined || isNaN(value)) return;               // $number error -> dropped
  const topic = kind === 'gas' ? 'sensor/status/gas/kg_tr/gas' : 'sensor/status/water/kg_tr/water';
  if (kind === 'water') {
    const prev = s.waterPrev;   // switch "gt previous value": previous is updated on every message
    s.waterPrev = value;
    if (!(value > prev)) return;
  }
  if (!rbe(s, `${kind}-band`, { func: 'narrowband', gap: kind === 'gas' ? '2' : '100' }, topic, value)) return;
  publish(ctx, topic, value, m.retain);
}

// ---- entry -------------------------------------------------------------------------------------
const RULES = {
  'sensor/status/humidity/eg_bad/ht/9': humidity,
  'sensor/status/heating/kg_tr/tr1/friwarue': showerDrain,
  'gasmeter/main/json': (s, ctx, now, m) => meter(s, ctx, m, 'gas'),
  'watermeter/main/json': (s, ctx, now, m) => meter(s, ctx, m, 'water'),
};

function initialState() { return { rbe: {}, cycleSeen: {}, seq: 0 }; }

function decide(prev, ev) {
  const s = clone(prev);
  const ctx = { out: [], timers: [], logs: [] };
  const now = ev.at;
  if (ev.type === 'mqtt') {
    const m = { topic: ev.topic, payload: clone(ev.payload), retain: !!ev.retain };
    if (RULES[ev.topic]) RULES[ev.topic](s, ctx, now, m);
    if (CYCLE_TOPICS.includes(ev.topic)) cycleInput(s, ctx, now, ev.hour, ev.topic);
  } else if (ev.type === 'inject') {
    if (ev.name === 'pulse') cycleInput(s, ctx, now, ev.hour, 'timestamp');
    if (ev.name === 'water-reset') delete (s.rbe['water-band'] || {})['sensor/status/water/kg_tr/water'];
  } else if (ev.type === 'timer') {
    const [kind, tk] = ev.key.split(':');
    if (kind === 'kwl' && s.kwlTrigger && s.kwlTrigger.token === tk) {
      const { msg } = s.kwlTrigger;
      delete s.kwlTrigger;
      publish(ctx, msg.topic, 'low', msg.retain);
    }
    if (kind === 'gate' && s.gateToken === tk) s.gateClosed = false;
  }
  return { state: s, ...ctx };
}

if (typeof module !== 'undefined') module.exports = { initialState, decide, CYCLE_TOPICS };

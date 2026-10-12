// node --test test/  -  adapter: pending timers survive a redeploy (2026-10-12)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const fs = require('node:fs');
const os = require('node:os');

// Build in a temporary copy: the other test files rebuild flows.json in parallel.
const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-test-'));
fs.cpSync(root, tmp, { recursive: true, filter: f => !/[/](\.git|node_modules)$/.test(f) });
execFileSync(process.execPath, [path.join(tmp, 'build.js')]);
const flows = JSON.parse(fs.readFileSync(path.join(tmp, 'flows.json'), 'utf8'));
fs.rmSync(tmp, { recursive: true, force: true });
const core = flows.find(n => n.id === 'kwl2_core');

function sandbox(ctx) {
  const scheduled = [];
  const fakeSet = (fn, ms) => { const h = { fn, ms }; scheduled.push(h); return h; };
  const context = { get: k => ctx[k], set: (k, v) => { ctx[k] = v; } };
  const store = { get: () => undefined, set: () => {}, keys: () => [] };
  const node = { send: () => {}, warn: () => {}, error: () => {}, status: () => {}, log: () => {} };
  const env = { get: () => undefined };
  const fn = new Function('msg', 'context', 'flow', 'global', 'node', 'env', 'setTimeout', 'clearTimeout', core.func);
  return { scheduled, run: msg => fn(msg, context, store, store, node, env, fakeSet, () => {}) };
}

test('start-up inject wired to the core, firing once', () => {
  const inj = flows.find(n => n.id === 'kwl2_restore');
  assert.equal(inj.once, true);
  assert.deepEqual(inj.wires, [['kwl2_core']]);
});

test('after a redeploy the pending timers are re-armed (overdue at once) and the marker message stops', () => {
  const now = Date.now();
  const ctx = { pending: [{ key: 'x:1:a', at: now - 5000 }, { key: 'x:2:b', at: now + 60000 }] };   // timers undefined = fresh node
  const s = sandbox(ctx);
  assert.equal(s.run({ topic: '__restore_timers__', payload: 0 }), null);
  assert.equal(s.scheduled.length, 2);
  assert.equal(s.scheduled[0].ms, 0, 'overdue timer fires immediately');
  assert.ok(s.scheduled[1].ms > 55000 && s.scheduled[1].ms <= 60000);
  assert.equal(ctx.pending.length, 2);
  s.scheduled[0].fn();                                   // unknown token: the core ignores it, the entry is gone
  assert.deepEqual(ctx.pending.map(p => p.key), ['x:2:b']);
  s.run({ topic: '__restore_timers__', payload: 0 });
  assert.equal(s.scheduled.length, 2, 'restored only once per start');
});

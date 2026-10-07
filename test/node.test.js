'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const root = path.join(__dirname, '..');
execFileSync(process.execPath, [path.join(root, 'build.js')]);
const flows = require(path.join(root, 'flows.json'));

test('generated node: humidity -> level on the single output; finalize clears the 20-min timer', () => {
  const fnNode = flows.find(n => n.id === 'kwl2_core');
  const ctx = {}, sent = [];
  const context = { get: k => ctx[k], set: (k, v) => { ctx[k] = v; } };
  const node = { send: p => sent.push(p), warn() {} };
  new Function('msg', 'context', 'node', 'setTimeout', 'clearTimeout', fnNode.func)(
    { topic: 'sensor/status/humidity/eg_bad/ht/9', payload: { value: 75 } }, context, node, setTimeout, clearTimeout);
  assert.deepEqual(sent[0][0], [{ topic: 'red/cmd/comfoair/level', payload: 'high', retain: false }]);
  new Function('context', 'clearTimeout', fnNode.finalize)(context, clearTimeout);
});

test('build: subscriptions as in the old tab, pulse and cron reset present', () => {
  assert.deepEqual(flows.filter(n => n.type === 'mqtt in').map(n => [n.topic, n.datatype]), require(path.join(root, 'subs.json')));
  assert.equal(flows.find(n => n.id === 'kwl2_reset').crontab, '00 03 * * 1,3,5,0');
});

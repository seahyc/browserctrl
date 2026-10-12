import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createActivityMonitor } from '../lib/activity.mjs';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-activity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  return { file, monitor: createActivityMonitor(9223, { file }) };
}
test('pause persists across monitor instances and resume restores actions', t => {
  const { file, monitor } = fixture(t);
  monitor.control('describe', { owner: 'reviewer', intent: 'Review 91 guide links', completed: 2, total: 91 });
  monitor.control('pause', { owner: 'reviewer' });
  const other = createActivityMonitor(9223, { file });
  assert.throws(() => other.assertRunning('reviewer'), { code: 'AGENT_PAUSED' });
  other.assertRunning('other');
  other.control('resume', { owner: 'reviewer' });
  monitor.assertRunning('reviewer');
  assert.equal(monitor.snapshot().agents[0].intent, 'Review 91 guide links');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
test('rapid navigation warns at threshold, throttles and expires separately per owner', t => {
  const { file } = fixture(t);
  let now = 1000;
  const monitor = createActivityMonitor(9223, { file, clock: () => now });
  for (let i = 0; i < 4; i++) assert.deepEqual(monitor.observe({ owner: 'a', method: 'Page.navigate' }), []);
  assert.match(monitor.observe({ owner: 'a', method: 'Page.reload' })[0], /Agent a: 5 navigation/);
  assert.deepEqual(monitor.observe({ owner: 'a', method: 'Page.navigate' }), []);
  monitor.observe({ owner: 'b', method: 'Target.activateTarget' });
  monitor.observe({ owner: 'b', method: 'dia-focus' });
  monitor.observe({ owner: 'b', method: 'page_interactions' });
  const rows = monitor.snapshot().agents;
  assert.equal(rows.find(row => row.owner === 'b').activationCount, 2);
  assert.equal(rows.find(row => row.owner === 'a').warnings.length, 1);
  now += 15000;
  assert.equal(monitor.snapshot().agents.find(row => row.owner === 'a').navigationCount, 0);
});
test('snapshot merges controls with claims without storing page metadata', t => {
  const { monitor, file } = fixture(t);
  monitor.control('describe', { owner: 'a', label: 'Reviewer', intent: 'Review guide' });
  monitor.observe({ owner: 'a', method: 'Page.navigate', targetId: 'tab-a', url: 'secret' });
  const snapshot = monitor.snapshot([
    { port: 9223, owner: 'a', targetId: 'tab-a' },
    { port: 9223, owner: 'a', targetId: 'tab-b' },
    { port: 9224, owner: 'a', targetId: 'not-here' },
    { port: 9223, owner: 'b', label: 'Second', targetId: 'tab-c' },
  ]);
  assert.deepEqual(snapshot.agents[0].tabIds, ['tab-a', 'tab-b']);
  assert.equal(snapshot.agents[1].label, 'Second');
  assert.equal(JSON.stringify(snapshot).includes('secret'), false);
  assert.equal(fs.readFileSync(file, 'utf8').includes('secret'), false);
});
test('invalid controls are rejected and corrupted state fails closed', t => {
  const { monitor, file } = fixture(t);
  for (const options of [{ owner: '' }, { owner: 'a', intent: 'x'.repeat(241) }, { owner: 'a', completed: -1 }, { owner: 'a', completed: 2, total: 1 }]) {
    assert.throws(() => monitor.control('describe', options));
  }
  fs.writeFileSync(file, '{broken');
  assert.throws(() => monitor.assertRunning('a'), /Cannot read activity state/);
  assert.throws(() => monitor.control('resume', { owner: 'a' }), /Cannot read activity state/);
});
test('observation eviction preserves persisted pause controls', t => {
  const { monitor } = fixture(t);
  monitor.control('pause', { owner: 'paused' });
  for (let i = 0; i < 140; i++) monitor.observe({ owner: `owner-${i}`, method: 'Page.navigate' });
  assert.equal(monitor.snapshot().agents.length, 129);
  assert.throws(() => monitor.assertRunning('paused'), { code: 'AGENT_PAUSED' });
});

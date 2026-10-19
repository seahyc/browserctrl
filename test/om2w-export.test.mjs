import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { exportOm2w } from '../bench/om2w/export.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-om2w-test-'));
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function fakeRecording() {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'trajectory'));
  const steps = [
    { step: 0, at: 1000, url: 'https://a.test/', action: 'start recording', status: null, screenshot: '0000.jpg' },
    { step: null, at: 1500, action: 'click ref_9', status: 'SUCCESS', error: 'capture timed out' },
    { step: 1, at: 2000, url: 'https://a.test/x', action: 'do: click "Sort"', status: 'SUCCESS', screenshot: '0001.jpg' },
    { step: 2, at: 3000, url: 'https://a.test/x', action: 'stop recording', status: null, screenshot: '0002.jpg' },
  ];
  fs.writeFileSync(path.join(dir, 'steps.jsonl'), steps.map(s => JSON.stringify(s)).join('\n') + '\n');
  for (const n of ['0000', '0001', '0002']) fs.writeFileSync(path.join(dir, 'trajectory', `${n}.jpg`), jpeg);
  return dir;
}

const check = (resultFile, root) => {
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.equal(result.schema_version, 'online-mind2web-v2');
  assert.equal(result.task_id, 'abc');
  assert.equal(result.agent_final_answer, 'done');
  // The failed capture reuses the previous still; the final stop row is dropped.
  assert.deepEqual(result.action_history.map(h => [h.step, h.screenshot, h.action]), [
    [0, '0000.jpg', 'start recording'], [1, '0000.jpg', 'click ref_9'], [2, '0001.jpg', 'do: click "Sort"'],
  ]);
  for (const h of result.action_history) assert.ok(fs.existsSync(path.join(root, 'abc', 'trajectory', h.screenshot)));
};

test('the export writes a v2 result the Online-Mind2Web judge can read', () => {
  const root = tmp();
  check(exportOm2w(fakeRecording(), { taskId: 'abc', task: 'Find a sofa', answer: 'done', root }).result, root);
  assert.throws(() => exportOm2w(fakeRecording(), { task: 'x' }), /task-id/);
});

test('node bench/om2w/export.mjs <recdir> <out> does the same from the command line', () => {
  const root = tmp();
  const out = JSON.parse(execFileSync(process.execPath, ['bench/om2w/export.mjs', fakeRecording(), root, '--task-id', 'abc', '--task', 'Find a sofa', '--answer', 'done'], { encoding: 'utf8' }));
  check(out.result, root);
});

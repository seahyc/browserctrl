import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepResult, stepRecordingOptions } from '../lib/step-recording.mjs';

test('step results keep observed text, zero and typed evidence', () => {
  assert.equal(stepResult({ extracted: { value: 'Download Python 3.15.0' } }), 'Download Python 3.15.0');
  assert.equal(stepResult({ binding: { value: 40300, raw: '40.3k forks', type: 'number' } }), '40300 from “40.3k forks”');
  assert.equal(stepResult({ extracted: { value: 0 } }), '0');
  assert.equal(stepResult({ answer: 'Ready' }), 'Ready');
  assert.equal(stepResult({ extracted: { value: null } }), undefined);
});

test('failed results prefer a short stop reason over partial evidence', () => {
  const row = { stopped: true, stop: 'Required extraction is missing or uncertain; needs group p >= 0.75; candidates: "Python 3.15.0" (p=0.49)', extracted: { value: 'partial' } };
  assert.equal(stepResult(row), 'no line clearly answers it (best: "Python 3.15.0", 49%)');
  assert.equal(stepResult({ stopped: true, stop: 'x'.repeat(200) }).length, 120);
  assert.equal(stepResult({ stopped: true }), undefined);
});

test('recording options preserve statuses and Jev metadata alongside result', () => {
  assert.deepEqual(stepRecordingOptions({ answer: 'ok', how: 'jev p=0.9', target: 'Go' }), {
    status: 'SUCCESS', extra: { result: 'ok', jev: { target: 'Go', p: .9 } },
  });
  assert.equal(stepRecordingOptions({ stopped: true, stop: 'blocked' }).status, 'FAILED');
  assert.equal(stepRecordingOptions({ skipped: 'missing' }).status, 'SKIPPED');
  assert.deepEqual(stepRecordingOptions({}).extra, {});
});

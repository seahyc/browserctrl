import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {stopManagedRecording, recoverClosedRecording, recoverUnusedRecording} from '../lib/recording-lifecycle.mjs';

function fixture(t, {changed = false, stopped = true, remove = true} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-rec-stop-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(dir, 'meta.json'), '{}');
  const calls = []; let trees = 0, removed = false;
  const send = async (method, params) => {
    calls.push(method);
    if (method === 'Page.getFrameTree') return {frameTree: {frame: {id: 'frame', loaderId: changed && ++trees > 1 ? 'new' : 'old'}}};
    if (method === 'Page.removeScriptToEvaluateOnNewDocument') { assert.equal(params.identifier, 'script'); return {}; }
    if (method === 'Page.createIsolatedWorld') return {executionContextId: 1};
    if (method === 'Runtime.evaluate') { if (stopped) fs.writeFileSync(path.join(dir, 'rrweb.end'), 'done'); return {result: {value: stopped}}; }
    throw Error(method);
  };
  const options = {targetId: dir, row: {managed: true, recordingId: 'recording-1', startedAt: 1, scriptId: 'script', dir}, send,
    waitMs: 10, patch: () => true, remove: () => { removed = remove; return remove; }, finish: () => ({recording: dir}), reason: 'idle'};
  return {options, calls, isRemoved: () => removed, dir};
}

test('verified teardown removes navigation hook and page recorder without a final screenshot', async t => {
  const f = fixture(t);
  await stopManagedRecording(f.options);
  assert.equal(f.isRemoved(), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'meta.json'))).stopReason, 'idle');
  assert.equal(f.calls.includes('Page.captureScreenshot'), false);
  assert.deepEqual(f.calls, ['Page.getFrameTree', 'Page.removeScriptToEvaluateOnNewDocument', 'Page.getFrameTree', 'Page.createIsolatedWorld', 'Runtime.evaluate', 'Page.getFrameTree']);
});

test('unverified recorder stop or concurrent navigation preserves the blocking row', async t => {
  for (const options of [{stopped: false}, {changed: true}]) {
    const f = fixture(t, options);
    await assert.rejects(stopManagedRecording(f.options), /recording_teardown_unverified/);
    assert.equal(f.isRemoved(), false);
  }
});

test('unmanaged or changed recordings never clear their blocking row', async t => {
  const f = fixture(t, {remove: false});
  await assert.rejects(stopManagedRecording({...f.options, row: {...f.options.row, managed: false}}), /recording_teardown_unverified/);
  await assert.rejects(stopManagedRecording(f.options), /recording_changed/);
  assert.equal(f.isRemoved(), false);
});


test('a recorder with uncertain setup or reinstrumentation stays blocking', async t => {
  const f = fixture(t);
  for (const key of ['startFailed', 'teardownUnverified']) {
    await assert.rejects(stopManagedRecording({...f.options, row: {...f.options.row, [key]: true}}), /recording_teardown_unverified/);
    assert.equal(f.isRemoved(), false);
  }
});

test('hook removal failures preserve the blocking row', async t => {
  const f = fixture(t);
  const send = async (method, params) => {
    if (method === 'Page.removeScriptToEvaluateOnNewDocument') throw Error('transport failure');
    return f.options.send(method, params);
  };
  await assert.rejects(stopManagedRecording({...f.options, send}), /transport failure/);
  assert.equal(f.isRemoved(), false);
});


test('missing final event acknowledgement retains the blocking row', async t => {
  const f = fixture(t);
  const send = async (method, params) => {
    const result = await f.options.send(method, params);
    if (method === 'Runtime.evaluate') fs.rmSync(path.join(f.dir, 'rrweb.end'), {force: true});
    return result;
  };
  await assert.rejects(stopManagedRecording({...f.options, send}), /recording_drain_unverified/);
  assert.equal(f.isRemoved(), false);
});


test('a late acknowledged batch can finish a previously stopped recorder without stopping twice', async t => {
  const f = fixture(t);
  const row = {...f.options.row, teardown: {frameId: 'frame', loaderId: 'old', stopped: true}};
  fs.writeFileSync(path.join(f.dir, 'rrweb.end'), 'done');
  await stopManagedRecording({...f.options, row});
  assert.equal(f.isRemoved(), true);
  assert.equal(f.calls.includes('Page.removeScriptToEvaluateOnNewDocument'), false);
  assert.equal(f.calls.includes('Runtime.evaluate'), false);
});


test('finalization failure preserves the directory reservation', async t => {
  const f = fixture(t);
  await assert.rejects(stopManagedRecording({...f.options, finish: () => { throw Error('disk full'); }}), /disk full/);
  assert.equal(f.isRemoved(), false);
});


test('a tainted tab stays protected while an unrelated idle recording can stop', async t => {
  const f = fixture(t);
  const isTainted = target => target === 'sensitive-tab';
  await assert.rejects(stopManagedRecording({...f.options, targetId: 'sensitive-tab', isTainted}), /recording_target_tainted/);
  assert.equal(f.isRemoved(), false);
  await stopManagedRecording({...f.options, targetId: 'other-tab', isTainted});
  assert.equal(f.isRemoved(), true);
});


test('finalization retry does not wait for an already consumed acknowledgement', async t => {
  const f = fixture(t);
  let current = {...f.options.row}, finishes = 0;
  const patch = (_target, _id, value) => { current = {...current, ...value}; return true; };
  const finish = () => {
    fs.rmSync(path.join(f.dir, 'rrweb.end'), {force: true});
    if (++finishes === 1) throw Error('late finalization failure');
    return {recording: f.dir};
  };
  await assert.rejects(stopManagedRecording({...f.options, patch, finish}), /late finalization failure/);
  assert.equal(current.teardown.drained, true);
  assert.equal(f.isRemoved(), false);
  await stopManagedRecording({...f.options, row: current, patch, finish});
  assert.equal(f.isRemoved(), true);
  assert.equal(finishes, 2);
});


test('closed-target recovery keeps incomplete data and refuses a live target', async t => {
  const f = fixture(t);
  const base = {targetId: f.options.targetId, row: {...f.options.row, startFailed: true}, remove: f.options.remove, finish: f.options.finish};
  await assert.rejects(recoverClosedRecording({...base, absent: async () => false}), /recording_target_still_present/);
  assert.equal(f.isRemoved(), false);
  const result = await recoverClosedRecording({...base, absent: async () => true});
  assert.equal(result.finalBatch, 'unverified');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'meta.json'))).stopReason, 'target_closed');
  assert.equal(f.isRemoved(), true);
});


test('only a never-installed failed start may be cleaned while its tab remains open', async t => {
  const f = fixture(t);
  const row = {...f.options.row, scriptId: null, startFailed: true, startPhase: 'reserved'};
  const oldMeta = fs.readFileSync(path.join(f.dir, 'meta.json'));
  assert.throws(() => recoverUnusedRecording({targetId: f.options.targetId, row: {...row, startPhase: 'hook_installing'}, remove: f.options.remove, finish: f.options.finish}), /recording_teardown_unverified/);
  assert.equal(f.isRemoved(), false);
  const result = recoverUnusedRecording({targetId: f.options.targetId, row, remove: f.options.remove, finish: f.options.finish});
  assert.equal(result.finalBatch, 'not_started');
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'meta.json')), oldMeta);
  assert.equal(f.isRemoved(), true);
});

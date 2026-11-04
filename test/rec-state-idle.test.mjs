import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-rec-state-'));
process.env.BROWSERCTRL_HOME = home;
process.env.BROWSERCTRL_REC_STATE = path.join(home, 'rec-tabs.json');
const { update, all, idleRecordings, removeIfSame, patchIfSame, touchOwner, start, stop, insertIfAbsent, reinstrument } = await import('../lib/rec.mjs');
test.after(() => fs.rmSync(home, {recursive: true, force: true}));

test('concurrent processes preserve all recording state updates', async () => {
  const module = new URL('../lib/rec.mjs', import.meta.url).href;
  const workers = Array.from({length: 6}, (_, n) => new Promise((resolve, reject) => {
    const script = `import {update} from ${JSON.stringify(module)}; for(let i=0;i<10;i++) update('t${n}x'+i,{port:1});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {env: process.env, stdio: ['ignore', 'ignore', 'pipe']});
    let error = ''; child.stderr.on('data', data => error += data);
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error(error)));
  }));
  await Promise.all(workers);
  assert.equal(Object.keys(all()).length, 60);
});

test('concurrent starts reserve a target only once', async () => {
  const module = new URL('../lib/rec.mjs', import.meta.url).href;
  const workers = Array.from({length: 6}, (_, n) => new Promise((resolve, reject) => {
    const script = `import {insertIfAbsent} from ${JSON.stringify(module)}; console.log(insertIfAbsent('shared-target',{owner:'agent-${n}'}));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {env: process.env, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '', error = '';
    child.stdout.on('data', data => output += data); child.stderr.on('data', data => error += data);
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(output.trim()) : reject(Error(error)));
  }));
  const results = await Promise.all(workers);
  assert.equal(results.filter(value => value === 'true').length, 1);
  assert.equal(results.filter(value => value === 'false').length, 5);
});

test('updates refuse corrupt state without replacing it', () => {
  const file = process.env.BROWSERCTRL_REC_STATE;
  for (const text of ['{bad json', '[]', '{"bad":null}']) {
    fs.writeFileSync(file, text);
    assert.throws(() => all());
    assert.throws(() => update('new', {port: 1}));
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
  fs.rmSync(file);
});

test('only managed recordings with their own idle owner become eligible', () => {
  const managed = (owner, lastOwnerActivityAt, port = 1) => ({owner, lastOwnerActivityAt, port, managed: true});
  const rows = {
    idle: managed('one', 100), active: managed('two', 100), otherPort: managed('one', 100, 2),
    missingOwner: managed('', 100), invalidTime: managed('one', null),
    legacy: {port: 1, owner: 'one', lastOwnerActivityAt: 100},
    unmanaged: {...managed('one', 100), managed: false},
  };
  assert.deepEqual(idleRecordings(rows, {port: 1, now: 1000, timeoutMs: 500, activity: {two: 800, unrelated: 999}}), ['idle']);
  assert.deepEqual(idleRecordings(rows, {port: 1, now: 600, timeoutMs: 500, activity: {}}), []);
  assert.deepEqual(idleRecordings(rows, {port: 1, now: 1000, timeoutMs: 0}), []);
});

test('verified removal never deletes an unmanaged or replaced recording', () => {
  update('tab', {managed: true, startedAt: 10, recordingId: 'a'});
  assert.equal(removeIfSame('tab', 'wrong'), false);
  assert.equal(removeIfSame('tab', 'a'), true);
  update('tab', {managed: false, startedAt: 10});
  assert.equal(removeIfSame('tab', 'a'), false);
  update('tab', {managed: true, startedAt: 11, recordingId: 'b'});
  assert.equal(removeIfSame('tab', 'a'), false);
  assert.equal(all().tab.startedAt, 11);
});


test('owner activity renews only that owner’s managed recordings in the same port', () => {
  update('own', {managed: true, owner: 'one', port: 1, lastOwnerActivityAt: 100});
  update('other', {managed: true, owner: 'two', port: 1, lastOwnerActivityAt: 100});
  update('unmanaged', {managed: false, owner: 'one', port: 1, lastOwnerActivityAt: 100});
  update('elsewhere', {managed: true, owner: 'one', port: 2, lastOwnerActivityAt: 100});
  assert.equal(touchOwner(1, 'one', 200), 1);
  const rows = all();
  assert.equal(rows.own.lastOwnerActivityAt, 200);
  assert.equal(rows.other.lastOwnerActivityAt, 100);
  assert.equal(rows.unmanaged.lastOwnerActivityAt, 100);
  assert.equal(rows.elsewhere.lastOwnerActivityAt, 100);
  const before = fs.readFileSync(process.env.BROWSERCTRL_REC_STATE, 'utf8');
  assert.equal(touchOwner(1, 'unknown', 300), 0);
  assert.equal(fs.readFileSync(process.env.BROWSERCTRL_REC_STATE, 'utf8'), before);
});


test('failed managed starts retain blocking state while legacy failures clean up', async () => {
  const conn = {port: 1, send: async () => { throw Error('synthetic transport failure'); }};
  await assert.rejects(start(conn, 'managed-tab', {out: path.join(home, 'managed'), owner: 'agent', managed: true}), /synthetic transport failure/);
  assert.equal(all()['managed-tab'].startFailed, true);
  assert.equal(all()['managed-tab'].owner, 'agent');
  assert.equal(all()['managed-tab'].managed, true);
  await assert.rejects(start(conn, 'legacy-tab', {out: path.join(home, 'legacy')}), /synthetic transport failure/);
  assert.equal(all()['legacy-tab'], undefined);
});


test('active recordings cannot share an output directory', () => {
  const dir = path.join(home, 'shared-output');
  assert.equal(insertIfAbsent('a-dir', {dir, port: 1}), true);
  assert.equal(insertIfAbsent('b-dir', {dir, port: 1}), false);
  assert.equal(all()['b-dir'], undefined);
});

test('legacy stop refuses a managed replacement', async () => {
  update('replacement', {managed: true, owner: 'other', port: 1, dir: path.join(home, 'replacement')});
  await assert.rejects(stop({port: 1}, 'replacement'), /Managed recordings must be stopped by the daemon/);
  assert.equal(all().replacement.owner, 'other');
});


test('teardown stages cannot modify a replacement recording', () => {
  update('stage', {managed: true, recordingId: 'new', port: 1});
  assert.equal(patchIfSame('stage', 'old', {teardown: {stopped: true}}), false);
  assert.equal(all().stage.teardown, undefined);
  assert.equal(patchIfSame('stage', 'new', {teardown: {stopped: true}}), true);
  assert.equal(all().stage.teardown.stopped, true);
});


function fakeReinstrument(target, failAt, calls) {
  return async (method, params) => {
    calls.push(method);
    assert.equal(all()[target].teardownUnverified, true);
    if (method === failAt) throw Error('synthetic failure');
    if (method === 'Page.removeScriptToEvaluateOnNewDocument') { assert.equal(params.identifier, 'old-script'); return {}; }
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return {identifier: 'new-script'};
    if (method === 'Page.getFrameTree') return {frameTree: {frame: {id: 'frame'}}};
    if (method === 'Page.createIsolatedWorld') return {executionContextId: 99};
    if (method === 'Runtime.evaluate') return {result: {value: undefined}};
    throw Error('unexpected method');
  };
}

test('managed reinstrumentation replaces the hook before declaring teardown safe', async () => {
  const target = 're-instrument-ok', calls = [];
  update(target, {managed: true, recordingId: 'run-ok', scriptId: 'old-script'});
  await reinstrument(target, fakeReinstrument(target, null, calls), target);
  assert.deepEqual(calls, ['Page.removeScriptToEvaluateOnNewDocument', 'Page.addScriptToEvaluateOnNewDocument',
    'Page.getFrameTree', 'Page.createIsolatedWorld', 'Runtime.evaluate']);
  assert.equal(all()[target].scriptId, 'new-script');
  assert.equal(all()[target].teardownUnverified, false);
});

test('managed reinstrumentation failures retain the unsafe marker', async () => {
  for (const [i, failAt] of ['Page.removeScriptToEvaluateOnNewDocument', 'Page.addScriptToEvaluateOnNewDocument',
    'Page.getFrameTree', 'Page.createIsolatedWorld', 'Runtime.evaluate'].entries()) {
    const target = `re-instrument-fail-${i}`, calls = [];
    update(target, {managed: true, recordingId: `run-${i}`, scriptId: 'old-script'});
    await assert.rejects(reinstrument(target, fakeReinstrument(target, failAt, calls), target), /synthetic failure/);
    assert.equal(all()[target].teardownUnverified, true, failAt);
  }
});

test('managed reinstrumentation rejects a missing hook identifier', async () => {
  const target = 're-instrument-no-id';
  update(target, {managed: true, recordingId: 'run-no-id', scriptId: 'old-script'});
  await assert.rejects(reinstrument(target, async method => method === 'Page.addScriptToEvaluateOnNewDocument' ? {} : {}, target), /recording_teardown_unverified/);
  assert.equal(all()[target].teardownUnverified, true);
});

test('managed reinstrumentation never patches a replacement recording', async () => {
  const target = 're-instrument-replaced';
  update(target, {managed: true, recordingId: 'old-run', scriptId: 'old-script'});
  const calls = [];
  await assert.rejects(reinstrument(target, async method => {
    calls.push(method);
    if (method === 'Page.removeScriptToEvaluateOnNewDocument') {
      update(target, {recordingId: 'replacement', scriptId: 'replacement-script', teardownUnverified: true});
      return {};
    }
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return {identifier: 'new-script'};
    throw Error('unexpected method');
  }, target), /recording_changed/);
  assert.equal(all()[target].recordingId, 'replacement');
  assert.equal(all()[target].scriptId, 'replacement-script');
  assert.equal(all()[target].teardownUnverified, true);
  assert.deepEqual(calls, ['Page.removeScriptToEvaluateOnNewDocument', 'Page.addScriptToEvaluateOnNewDocument']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// Set isolation before importing state/recstore; never touch the real home.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-recording-owner-'));
process.env.BROWSERCTRL_HOME = home;
const store = await import('../lib/recstore.mjs');
test.after(() => fs.rmSync(home, {recursive:true, force:true}));

function save(row) {
  fs.mkdirSync(store.ROOT, {recursive:true});
  fs.writeFileSync(store.activePath, JSON.stringify(row));
}
function assertInactivePreserved(row) {
  save(row);
  const before = fs.readFileSync(store.activePath, 'utf8');
  assert.equal(store.readActive(), null);
  assert.equal(fs.readFileSync(store.activePath, 'utf8'), before);
}

test('legacy active recording has no provable owner and remains unchanged on disk', () => {
  assertInactivePreserved({id:'legacy', port:9223, script:'old script'});
});

test('exited recording owner is inactive without deleting its recording file', async () => {
  const child = spawn(process.execPath, ['-e', ''], {stdio:'ignore'});
  await once(child, 'exit');
  assertInactivePreserved({id:'dead', port:9223, script:'old script', ownerPid:child.pid, ownerStart:'old start'});
});

test('matching PID with a different start identity is inactive', () => {
  assertInactivePreserved({id:'reused', port:9223, script:'old script', ownerPid:process.pid, ownerStart:'wrong start identity'});
});

test('live write records actual owner identity and preserves the recording fields', () => {
  const recording = {id:'live', port:9223, script:'recording script'};
  store.writeActive(recording);
  const row = store.readActive();
  assert.equal(row.ownerPid, process.pid);
  assert.equal(typeof row.ownerStart, 'string');
  assert.ok(row.ownerStart.length > 0);
  assert.deepEqual({id:row.id, port:row.port, script:row.script}, recording);
  assert.deepEqual(row, JSON.parse(fs.readFileSync(store.activePath, 'utf8')));
});

test('missing owner start or invalid owner PID fails closed', () => {
  for (const owner of [{ownerPid:process.pid}, {ownerPid:-1, ownerStart:'start'}, {ownerPid:'1', ownerStart:'start'}]) {
    assertInactivePreserved({id:'invalid', port:9223, script:'old script', ...owner});
  }
});

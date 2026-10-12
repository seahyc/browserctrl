import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createTelemetry, telemetryDirectory } from '../lib/telemetry.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-telemetry-test-'));
  const previousDir = process.env.CDP_TELEMETRY_DIR;
  const previousEnabled = process.env.CDP_TELEMETRY;
  process.env.CDP_TELEMETRY_DIR = directory;
  delete process.env.CDP_TELEMETRY;
  t.after(() => {
    if (previousDir === undefined) delete process.env.CDP_TELEMETRY_DIR;
    else process.env.CDP_TELEMETRY_DIR = previousDir;
    if (previousEnabled === undefined) delete process.env.CDP_TELEMETRY;
    else process.env.CDP_TELEMETRY = previousEnabled;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, filename: path.join(directory, `lifecycle-9222-${process.pid}.jsonl`) };
}

test('telemetry writes only allowed metadata, hashes identities, and protects permissions', t => {
  const { directory, filename } = fixture(t);
  const write = createTelemetry(9222);
  const sensitive = 'private-owner@example.test';
  const fields = { owner: sensitive, method: 'Runtime.evaluate', op: 'cdp', reason: 'failed',
    params: { expression: sensitive }, error: sensitive, url: sensitive, result: sensitive,
    clientId: 2, requestId: 5, durationMs: 12, pendingCount: 1, codeVersion: '1234', attempt: 1 };
  write('request_failed', fields);
  write('request_complete', { owner: sensitive, method: 'Runtime.evaluate\nsecret', op: sensitive, reason: sensitive });
  write(sensitive, fields);
  const text = fs.readFileSync(filename, 'utf8');
  const rows = text.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.ok(!text.includes(sensitive));
  assert.ok(!text.includes('secret'));
  assert.equal(rows[0].ownerHash, rows[1].ownerHash);
  assert.match(rows[0].ownerHash, /^[a-f0-9]{24}$/);
  assert.equal(rows[0].method, 'Runtime.evaluate');
  assert.equal(rows[1].method, undefined);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['time', 'event', 'pid', 'parent', 'port', 'clientId', 'requestId', 'durationMs', 'pendingCount', 'attempt', 'reason', 'op', 'codeVersion', 'method', 'ownerHash'].sort());
  if (process.platform !== 'win32') assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  if (process.platform !== 'win32') assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  assert.equal(telemetryDirectory(), directory);
});

test('rotation bounds files to 1MiB and retains at most 32 matching files', t => {
  const { directory, filename } = fixture(t);
  for (let i = 0; i < 40; i++) {
    const file = path.join(directory, `lifecycle-1000-${i}.jsonl`);
    fs.writeFileSync(file, '{}\n');
    fs.utimesSync(file, new Date(1000 + i), new Date(1000 + i));
  }
  fs.writeFileSync(path.join(directory, 'keep.txt'), 'unrelated');
  const write = createTelemetry(9222);
  write('daemon_start');
  assert.equal(fs.readdirSync(directory).filter(name => name.startsWith('lifecycle-')).length, 32);
  fs.writeFileSync(filename, 'x'.repeat(1024 * 1024 - 1));
  write('shutdown', { reason: 'requested' });
  assert.equal(fs.statSync(`${filename}.1`).size, 1024 * 1024 - 1);
  assert.ok(fs.statSync(filename).size < 1024 * 1024);
  assert.equal(fs.readdirSync(directory).filter(name => name.startsWith('lifecycle-')).length, 32);
  assert.equal(fs.readFileSync(path.join(directory, 'keep.txt'), 'utf8'), 'unrelated');
});

test('disabled telemetry and filesystem failures do not interrupt callers', t => {
  const { directory } = fixture(t);
  process.env.CDP_TELEMETRY = '0';
  createTelemetry(9222)('daemon_start');
  assert.deepEqual(fs.readdirSync(directory), []);
  delete process.env.CDP_TELEMETRY;
  const file = path.join(directory, 'not-a-directory');
  fs.writeFileSync(file, 'keep');
  process.env.CDP_TELEMETRY_DIR = file;
  assert.doesNotThrow(() => createTelemetry(9222)('daemon_start'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
});

test('telemetry refuses a symlink log file', t => {
  const { directory, filename } = fixture(t);
  const target = path.join(directory, 'private');
  fs.writeFileSync(target, 'unchanged');
  fs.symlinkSync(target, filename);
  assert.doesNotThrow(() => createTelemetry(9222)('daemon_start'));
  assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged');
});

 test('request lifecycle preserves daemon request IDs for start and completion', t => {
  const { filename } = fixture(t);
  const write = createTelemetry(9222);
  write('request_started', { requestId: 1, clientId: 2, method: 'Runtime.evaluate' });
  write('request_complete', { requestId: 1, clientId: 2, durationMs: 20 });
  const rows = fs.readFileSync(filename, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => [row.event, row.requestId, row.clientId]),
    [['request_started', 1, 2], ['request_complete', 1, 2]]);
});

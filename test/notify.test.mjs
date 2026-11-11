import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { noticeWhileWaiting, debugPromptNotice, notifier, postNotice } from '../lib/notify.mjs';

const later = (ms, value, fail = false) => new Promise((resolve, reject) => setTimeout(() => (fail ? reject(new Error(value)) : resolve(value)), ms));

test('a wait that outlasts the delay posts a notice and withdraws it when it ends', async () => {
  const calls = [];
  const result = await noticeWhileWaiting(() => later(80, 'connected'), {
    delayMs: 20, key: 'k', post: () => (calls.push('post'), true), clear: key => calls.push(`clear:${key}`),
  });
  assert.equal(result, 'connected');
  assert.deepEqual(calls, ['post', 'clear:k']);
});

test('a wait that ends in time never notifies', async () => {
  const calls = [];
  await noticeWhileWaiting(() => later(5, 'ok'), { delayMs: 60, key: 'k', post: () => calls.push('post'), clear: () => calls.push('clear') });
  await later(80);
  assert.deepEqual(calls, [], 'the timer is cancelled, so nothing posts afterwards either');
});

test('a wait that fails still withdraws its notice', async () => {
  const calls = [];
  await assert.rejects(noticeWhileWaiting(() => later(60, 'refused', true), {
    delayMs: 10, key: 'k', post: () => (calls.push('post'), true), clear: () => calls.push('clear'),
  }), /refused/);
  assert.deepEqual(calls, ['post', 'clear']);
});

test('the debugging-prompt notice names the browser and brings it forward', () => {
  const runs = [];
  const notice = debugPromptNotice(9223, { program: '/bin/agent-notify', runner: (program, args) => runs.push([program, args]) });
  assert.equal(notice.key, 'allow-debugging-9223');
  assert.equal(notice.post(), true);
  const [program, args] = runs[0];
  assert.equal(program, '/bin/agent-notify');
  assert.deepEqual(args.slice(0, 5), ['post', '--source', 'browserctrl', '--title', '🔌 Dia wants you to allow debugging']);
  assert.deepEqual(args.slice(args.indexOf('--urgency')), ['--urgency', 'urgent', '--key', 'allow-debugging-9223', '--kind', 'browser-debug',
    '--activate', 'company.thebrowser.dia', '--button', 'go=🔌 Switch to Dia', '--button', 'snooze']);
  notice.clear();
  assert.deepEqual(runs[1][1], ['clear', '--source', 'browserctrl', '--key', 'allow-debugging-9223']);
});

test('no notices off macOS, when turned off, or without agent-notify', () => {
  assert.equal(notifier({ platform: 'linux', env: { PATH: '/usr/bin' } }), null);
  assert.equal(notifier({ platform: 'darwin', env: { PATH: '/usr/bin', BROWSERCTRL_NOTIFY: '0' } }), null);
  assert.equal(notifier({ platform: 'darwin', env: { PATH: '/nonexistent' }, home: '/nonexistent' }), null);
  assert.equal(postNotice(['--title', 'x'], { program: null, runner: () => assert.fail('must not run') }), false);
});

test('notifier prefers kaypoh, falls back to agent-notify, and looks in ~/.local/bin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-notifier-'));
  const bin = path.join(dir, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  try {
    fs.writeFileSync(path.join(bin, 'agent-notify'), '');
    assert.equal(notifier({ platform: 'darwin', env: { PATH: '/nonexistent' }, home: dir }), path.join(bin, 'agent-notify'));
    fs.writeFileSync(path.join(bin, 'kaypoh'), '');
    assert.equal(notifier({ platform: 'darwin', env: { PATH: '/nonexistent' }, home: dir }), path.join(bin, 'kaypoh'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

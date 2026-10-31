// Server browsers: `browserctrl launch <browser> --headless`, its planning helpers, and a real
// foreground launch (Chromium's headless mode) against the test harness's browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  resolveHeadlessMode, headlessArgs, desktopUserAgent, playwrightChromiumCandidates, freeDisplay,
  diagnoseEarlyExit, apparmorProfile, userNamespacesRestricted, startVnc, writeVncInfo,
} from '../lib/server-browser.mjs';
import { findBrowserExecutable, planDirectLaunch, startDetached } from '../lib/launch.mjs';
import { chromeBinary } from './helpers.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'browserctrl.mjs');

test('--headless picks the virtual display on Linux with Xvfb, Chromium headless otherwise', () => {
  assert.equal(resolveHeadlessMode(undefined), null);
  assert.equal(resolveHeadlessMode(true, { platform: 'linux', hasXvfb: () => true }), 'virtual');
  assert.equal(resolveHeadlessMode(true, { platform: 'linux', hasXvfb: () => false }), 'new');
  assert.equal(resolveHeadlessMode(true, { platform: 'darwin', hasXvfb: () => false }), 'new');
  assert.equal(resolveHeadlessMode('new', { platform: 'linux', hasXvfb: () => true }), 'new');
  assert.throws(() => resolveHeadlessMode('virtual', { platform: 'darwin' }), /needs Linux/);
  assert.throws(() => resolveHeadlessMode('virtual', { platform: 'linux', hasXvfb: () => false }), /needs Xvfb/);
  assert.throws(() => resolveHeadlessMode('old', { platform: 'linux', hasXvfb: () => true }), /virtual or new/);
});

test('headless arguments: virtual is a normal window, new hides "Headless" from the user agent', () => {
  const virtual = headlessArgs('virtual');
  assert.ok(virtual.includes('--window-size=1280,900'));
  assert.ok(!virtual.some(a => a.startsWith('--headless')));
  const fresh = headlessArgs('new', { version: 'Chromium 148.0.7778.0', platform: 'linux' });
  assert.ok(fresh.includes('--headless=new'));
  const ua = fresh.find(a => a.startsWith('--user-agent='));
  assert.equal(ua, '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36');
  assert.match(desktopUserAgent('Google Chrome 148.0.7778.0', 'darwin'), /\(Macintosh; Intel Mac OS X 10_15_7\)/);
  assert.equal(desktopUserAgent('no version here'), null);
  assert.deepEqual(headlessArgs(null), []);
});

test('Playwright Chromium builds are found newest first, and only as the last resort on Linux', () => {
  const dirs = ['chromium-1100', 'chromium_headless_shell-1223', 'chromium-1223', 'ffmpeg-1011'];
  const found = playwrightChromiumCandidates({ home: '/h', env: {}, readdir: () => dirs });
  assert.equal(found[0], '/h/.cache/ms-playwright/chromium-1223/chrome-linux/chrome');
  assert.ok(found.indexOf('/h/.cache/ms-playwright/chromium-1100/chrome-linux/chrome') > 0);
  const exe = '/h/.cache/ms-playwright/chromium-1223/chrome-linux/chrome';
  const pick = key => findBrowserExecutable(key, { platform: 'linux', env: {}, exists: p => p === exe, which: () => null, playwright: () => found });
  assert.equal(pick('chromium'), exe);
  assert.equal(pick('chrome'), null, 'only the chromium key falls back to Playwright');
});

test('plan: port override, explicit --no-sandbox only, headless arguments, no extension in headless', () => {
  const meta = { label: 'Chromium', port: 9226 };
  const base = { key: 'chromium', meta, userDataDir: '/p', platform: 'linux', env: {}, exists: () => true, which: () => null };
  const plain = planDirectLaunch(base);
  assert.ok(plain.args.includes('--remote-debugging-port=9226'));
  assert.ok(!plain.args.includes('--no-sandbox'));
  const server = planDirectLaunch({ ...base, port: 9555, headless: 'new', noSandbox: true, version: 'Chromium 148.0.1.2' });
  assert.equal(server.port, 9555);
  assert.ok(server.args.includes('--remote-debugging-port=9555'));
  assert.ok(server.args.includes('--no-sandbox'));
  assert.ok(server.args.includes('--headless=new'));
});

test('a free X display skips sockets and lock files', () => {
  const taken = new Set(['/tmp/.X11-unix/X90', '/tmp/.X91-lock']);
  assert.equal(freeDisplay({ exists: p => taken.has(p) }), 92);
  assert.throws(() => freeDisplay({ from: 1, to: 1, exists: () => true }), /no free X display/);
});

test('an early sandbox failure explains the AppArmor fix and writes the profile', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-sandbox-'));
  const logFile = path.join(dir, 'browserctrl-launch.log');
  fs.writeFileSync(logFile, 'FATAL:zygote_host_impl_linux.cc No usable sandbox! If you are running on Ubuntu 23.10+\n');
  const exits = [];
  const fake = () => ({ on(event, fn) { if (event === 'exit') exits.push(fn); }, unref() {} });
  let tick = 0;
  const pending = startDetached({
    plan: { exe: '/opt/chrome/chrome', args: [], userDataDir: dir, logFile }, probe: async () => null,
    spawnFn: fake, openLog: () => 'ignore', now: () => tick, wait: async () => { tick += 100; exits.forEach(f => f(1)); },
  });
  await assert.rejects(pending, err => /AppArmor/.test(err.message) && /--no-sandbox/.test(err.message));
  const profile = fs.readFileSync(path.join(dir, 'apparmor-browser-profile'), 'utf8');
  assert.match(profile, /profile browserctrl-chrome-chrome \/opt\/chrome\/chrome flags=\(unconfined\)/);
  assert.match(profile, /userns,/);
  assert.equal(apparmorProfile('/a b/chrome').includes('/a b/chrome'), true);
  assert.match(diagnoseEarlyExit('Missing X server or $DISPLAY'), /--headless/);
  assert.equal(typeof userNamespacesRestricted({ read: () => '1\n' }), 'boolean');
  assert.equal(userNamespacesRestricted({ read: () => { throw new Error('no file'); } }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('launch --headless=new --foreground: a real browser that hides Headless and stops with the command', { timeout: 90000 }, async t => {
  const exe = chromeBinary();
  if (!exe) return t.skip('no Chrome or Chromium found (set CHROME_BIN)');
  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-headless-'));
  const args = [BIN, 'launch', 'chrome', '--headless=new', '--port', String(port), '--user-data-dir', profile, '--foreground'];
  if (process.env.CHROME_TEST_NO_SANDBOX === '1') args.push('--no-sandbox');
  const child = spawn(process.execPath, args, { env: { ...process.env, BROWSERCTRL_CHROME_BIN: exe }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  try {
    const deadline = Date.now() + 60000;
    while (!/"ready": true/.test(stdout)) {
      if (Date.now() > deadline || child.exitCode !== null) assert.fail(`not ready: ${stdout}\n${stderr}`);
      await new Promise(r => setTimeout(r, 200));
    }
    const report = JSON.parse(stdout);
    assert.equal(report.headless, 'new');
    assert.equal(report.port, port);
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    assert.ok(!/Headless/.test(version['User-Agent']), version['User-Agent']);
  } finally {
    child.kill('SIGTERM');
    const code = await new Promise(r => (child.exitCode !== null ? r(child.exitCode) : child.once('exit', c => r(c))));
    assert.equal(code, 0, stderr);
    const closed = await fetch(`http://127.0.0.1:${port}/json/version`).then(() => false, () => true);
    assert.ok(closed, 'the browser stopped with the foreground command');
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('--stop ends exactly the browser and display a detached launch recorded', async () => {
  const { recordLaunch, stopLaunched, LAUNCH_STATE } = await import('../lib/launch.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-stop-'));
  const info = path.join(dir, 'vnc.json');
  fs.writeFileSync(info, '{}');
  recordLaunch(dir, { pid: 111, displayPid: 222, vncPid: 333, vncInfo: info, display: ':90', port: 9450 });
  const live = new Set([111, 222, 333]);
  const signals = [];
  const r = await stopLaunched(dir, {
    alive: pid => live.has(pid), wait: async () => {},
    kill: (pid, sig) => { signals.push([pid, sig]); live.delete(pid); },
  });
  assert.deepEqual(r.ended, ['browser', 'vnc', 'display']);
  assert.deepEqual(signals, [[111, 'SIGTERM'], [333, 'SIGTERM'], [222, 'SIGTERM']]);
  assert.equal(fs.existsSync(info), false, 'the VNC handoff file goes with it');
  assert.equal(fs.existsSync(path.join(dir, LAUNCH_STATE)), false);
  const none = await stopLaunched(dir);
  assert.equal(none.stopped, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('VNC handoff: loopback only, no password, port parsed from x11vnc, info file for relays', async () => {
  const { EventEmitter } = await import('node:events');
  let seen;
  const fake = (cmd, args) => {
    seen = { cmd, args };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => child.stdout.emit('data', 'The VNC desktop is: localhost:0\nPORT=5901\n'));
    return child;
  };
  const vnc = await startVnc({ display: ':90', spawnFn: fake });
  assert.equal(vnc.port, 5901);
  assert.equal(seen.cmd, 'x11vnc');
  assert.ok(seen.args.includes('-localhost') && seen.args.includes('-nopw'));
  assert.deepEqual(seen.args.slice(0, 2), ['-display', ':90']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-vnc-'));
  writeVncInfo(path.join(dir, 'v.json'), { port: 5901, display: ':90' });
  const info = JSON.parse(fs.readFileSync(path.join(dir, 'v.json'), 'utf8'));
  assert.equal(info.port, 5901);
  assert.equal(info.display, ':90');
  fs.rmSync(dir, { recursive: true, force: true });
  const broken = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); setImmediate(() => c.emit('exit', 1)); return c; };
  await assert.rejects(startVnc({ display: ':90', spawnFn: broken, detached: false }), /exited before listening/);
});

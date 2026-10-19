import test from 'node:test';
import assert from 'node:assert/strict';
import { relaunchWithDebugPort } from '../lib/launch.mjs';

// A fake clock: wait() advances time instantly.
function clock() {
  let t = 0;
  return { now: () => t, wait: async ms => { t += ms; } };
}

test('reports ready only once the debug port answers', async () => {
  const c = clock();
  let running = true, opens = 0;
  const r = await relaunchWithDebugPort({
    ...c,
    quit: async () => { running = false; },
    isRunning: async () => running,
    open: async () => { opens += 1; running = true; },
    probe: async () => (c.now() >= 3000 ? { Browser: 'Dia/1' } : null),
  });
  assert.equal(r.ready, true);
  assert.equal(r.version.Browser, 'Dia/1');
  assert.equal(opens, 1);
  assert.equal(r.reopened, false);
});

test('reopens once when the first open was swallowed by a quitting instance', async () => {
  const c = clock();
  let running = true, opens = 0;
  const r = await relaunchWithDebugPort({
    ...c,
    quit: async () => { running = false; },
    isRunning: async () => running,
    // First open is swallowed (app stays down); second one works.
    open: async () => { opens += 1; if (opens >= 2) running = true; },
    probe: async () => (running ? { Browser: 'Dia/1' } : null),
  });
  assert.equal(opens, 2);
  assert.equal(r.reopened, true);
});

test('throws instead of claiming success when the browser never starts', async () => {
  const c = clock();
  let running = true;
  await assert.rejects(relaunchWithDebugPort({
    ...c,
    quit: async () => { running = false; },
    isRunning: async () => running,
    open: async () => {},
    probe: async () => null,
  }), /did not start within 45s \(reopened once\)/);
});

test('refuses to open while the old instance is still quitting', async () => {
  const c = clock();
  let opens = 0;
  await assert.rejects(relaunchWithDebugPort({
    ...c,
    quit: async () => {},
    isRunning: async () => true,
    open: async () => { opens += 1; },
    probe: async () => null,
  }), /did not quit within 30s/);
  assert.equal(opens, 0);
});

test('distinguishes running-but-no-port from not-started', async () => {
  const c = clock();
  let running = true;
  await assert.rejects(relaunchWithDebugPort({
    ...c,
    quit: async () => { running = false; },
    isRunning: async () => running,
    open: async () => { running = true; },
    probe: async () => null,
  }), /running but its debug port did not answer/);
});

import { planLaunch } from '../lib/launch.mjs';
import { BROWSERS } from '../lib/env.mjs';

test('Chrome real profile is refused before anything is quit, with both ways out', () => {
  // Off macOS the enable hint is the generic one (automatic relaunch is macOS-only).
  const enable = process.platform === 'darwin' ? 'chrome:\\/\\/inspect' : 'Enable browser debugging';
  assert.throws(() => planLaunch({ name: 'chrome', meta: BROWSERS.chrome }),
    new RegExp(`refuses --remote-debugging-port on your real profile, so nothing was quit.*${enable}.*--user-data-dir`));
});

test('every browser can launch a separate instance with --user-data-dir', () => {
  for (const [name, meta] of Object.entries(BROWSERS)) {
    const plan = planLaunch({ name, meta, userDataDir: '/tmp/x', extension: '/ext' });
    assert.equal(plan.separateInstance, true, name);
    assert.deepEqual(plan.args, [`--remote-debugging-port=${meta.port}`, '--load-extension=/ext', '--user-data-dir=/tmp/x'], name);
    assert.equal(plan.processMatch, '--user-data-dir=/tmp/x', name);
  }
});

test('non-Chrome browsers relaunch their real profile', () => {
  for (const name of ['dia', 'brave', 'edge', 'chromium', 'arc']) {
    const plan = planLaunch({ name, meta: BROWSERS[name] });
    assert.equal(plan.separateInstance, false, name);
    assert.deepEqual(plan.args, [`--remote-debugging-port=${BROWSERS[name].port}`], name);
  }
});

import path from 'node:path';
import { planDirectLaunch, findBrowserExecutable, browserCandidates, startDetached } from '../lib/launch.mjs';

const meta = { label: 'Chrome', port: 9222 };

test('Linux: finds a browser in the usual places, then on PATH', () => {
  const env = {};
  const a = findBrowserExecutable('chrome', { platform: 'linux', env, exists: p => p === '/usr/bin/google-chrome-stable', which: () => null });
  assert.equal(a, '/usr/bin/google-chrome-stable');
  const b = findBrowserExecutable('brave', { platform: 'linux', env, exists: () => false, which: n => (n === 'brave-browser' ? '/opt/x/brave-browser' : null) });
  assert.equal(b, '/opt/x/brave-browser');
  assert.equal(findBrowserExecutable('edge', { platform: 'linux', env, exists: () => false, which: () => null }), null);
});

test('Windows: looks under Program Files and LocalAppData', () => {
  const env = { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' };
  const c = browserCandidates('edge', { platform: 'win32', env });
  assert.deepEqual(c, ['C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Users\\a\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe']);
  assert.deepEqual(browserCandidates('dia', { platform: 'win32', env }), []);
});

test('an explicit BROWSERCTRL_<BROWSER>_BIN wins, and is not second-guessed when missing', () => {
  const env = { BROWSERCTRL_CHROME_BIN: '/custom/chrome' };
  assert.equal(findBrowserExecutable('chrome', { platform: 'linux', env, exists: () => true, which: () => '/x' }), '/custom/chrome');
  assert.equal(findBrowserExecutable('chrome', { platform: 'linux', env, exists: () => false, which: () => '/x' }), null);
});

test('plan: separate profile, debug port, never the real profile', () => {
  const plan = planDirectLaunch({ key: 'chrome', meta, userDataDir: '/tmp/prof', extension: '/ext', platform: 'linux', env: {}, exists: p => p === '/usr/bin/google-chrome', which: () => null });
  assert.equal(plan.exe, '/usr/bin/google-chrome');
  assert.ok(plan.args.includes('--remote-debugging-port=9222'));
  assert.ok(plan.args.includes('--user-data-dir=/tmp/prof'));
  assert.ok(plan.args.includes('--load-extension=/ext'));
  const dflt = planDirectLaunch({ key: 'chrome', meta, platform: 'linux', env: {}, exists: () => true, which: () => null });
  assert.match(dflt.userDataDir, new RegExp(`profiles${path.sep.replace('\\', '\\\\')}chrome$`));
  assert.throws(() => planDirectLaunch({ key: 'chrome', meta, platform: 'linux', env: {}, exists: () => false, which: () => null }), /BROWSERCTRL_CHROME_BIN/);
});

test('startDetached spawns once, waits for the port, and leaves a running browser alone', async () => {
  const c = clock();
  const spawned = [];
  const fake = (exe, args, opts) => { spawned.push({ exe, args, opts }); return { on() {}, unref() {} }; };
  const plan = { exe: '/b', args: ['--x'], userDataDir: '/d' };
  const r = await startDetached({ plan, ...c, spawnFn: fake, probe: async () => (c.now() >= 2000 ? { Browser: 'Chrome/1' } : null) });
  assert.equal(r.ready, true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].opts.detached, true);
  const again = await startDetached({ plan, ...c, spawnFn: fake, probe: async () => ({ Browser: 'Chrome/1' }) });
  assert.equal(again.alreadyRunning, true);
  assert.equal(spawned.length, 1);
  await assert.rejects(startDetached({ plan, ...c, readyTimeoutMs: 1000, spawnFn: fake, probe: async () => null }), /did not answer/);
});

import { alertCommands } from '../lib/captcha.mjs';

test('notifications pick the right tool per system without running anything', () => {
  const mac = alertCommands('hi', { platform: 'darwin', env: {} });
  assert.deepEqual(mac.map(c => c[0]), ['osascript', 'afplay']);
  assert.deepEqual(alertCommands('hi', { platform: 'darwin', env: { BROWSERCTRL_NOTIFY_SOUND: '0' } }).map(c => c[0]), ['osascript']);
  assert.deepEqual(alertCommands('hi', { platform: 'darwin', env: { CDP_NOTIFY: '0' } }), []);
  const lin = alertCommands('hi', { platform: 'linux', env: {}, has: n => n === 'notify-send' });
  assert.deepEqual(lin.map(c => c[0]), ['notify-send']);
  assert.deepEqual(alertCommands('hi', { platform: 'linux', env: {}, has: () => false }), []);
  assert.deepEqual(alertCommands('hi', { platform: 'linux', env: { BROWSERCTRL_NOTIFY_SOUND: '/s.wav' }, has: n => n === 'aplay' }).map(c => c[0]), ['aplay']);
  const win = alertCommands('say "x"; ZZQ', { platform: 'win32', env: {} });
  assert.equal(win[0][0], 'powershell');
  assert.ok(!win[0][1].join(' ').includes('ZZQ'), 'message travels in the environment, not the script');
  assert.equal(win[0][2].BROWSERCTRL_ALERT_TEXT, 'say "x"; ZZQ');
});

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
  assert.throws(() => planLaunch({ name: 'chrome', meta: BROWSERS.chrome }),
    /refuses --remote-debugging-port on your real profile, so nothing was quit.*chrome:\/\/inspect.*--user-data-dir/);
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

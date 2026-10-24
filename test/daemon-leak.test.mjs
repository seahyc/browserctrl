// Daemons never outlive the tests that started them, and SIGTERM always stops one.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { connect } from '../lib/daemon.mjs';
import { SOCK, runtimePath } from '../lib/env.mjs';
import { startHeadlessBrowser, chromeBinary, stopLoggedDaemons } from './helpers.mjs';

const exec = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const options = { skip: !chromeBinary() || process.platform === 'win32', timeout: 600000 };

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

// Counting by command line is fine for an assertion; nothing here is signalled by pattern.
function daemonPids(port) {
  const out = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return out.split('\n').filter(line => line.trim().endsWith(`/lib/daemon-run.mjs ${port}`))
    .map(line => Number(line.trim().split(/\s+/)[0]));
}

async function waitFor(check, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return check();
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a daemon whose home is removed exits even when a new browser takes its port', options, async t => {
  const port = await freePort();
  const first = await startHeadlessBrowser(port);
  const client = await connect(port);
  const { pid } = await client.health();
  client.close();
  await first.close();
  // The next test file's browser on the same port: the daemon reattaches to it.
  const next = await startHeadlessBrowser(port);
  t.after(async () => { stopLoggedDaemons({ port }); await next.close(); });
  // The test that started the daemon exits and its home, with the socket, goes.
  fs.rmSync(SOCK(port));
  assert.ok(await waitFor(() => !alive(pid), 20000), `daemon ${pid} outlived its socket`);
});

test('SIGTERM exits a daemon holding a vault taint marker, and the marker stays on disk', options, async t => {
  const port = await freePort();
  const browser = await startHeadlessBrowser(port);
  t.after(async () => { stopLoggedDaemons({ port }); await browser.close(); });
  const setup = await connect(port);
  const { targetId } = await setup.browser('Target.createTarget', { url: 'about:blank' });
  const { pid: firstPid } = await setup.health();
  setup.close();
  process.kill(firstPid, 'SIGTERM');
  assert.ok(await waitFor(() => !alive(firstPid), 5000));
  // The marker a protected fill leaves: the next daemon holds the tab as tainted.
  const marker = runtimePath(`vault-taint-${port}.json`);
  const body = JSON.stringify({ version: 2, tabs: { [targetId]: { browser: 'chrome', owner: 'leak-test', origins: ['http://127.0.0.1'] } } });
  fs.writeFileSync(marker, body, { mode: 0o600 });
  const client = await connect(port);
  const status = await client.status();
  client.close();
  assert.ok(status.taintedTabs >= 1, 'the daemon holds the taint');
  const started = Date.now();
  process.kill(status.pid, 'SIGTERM');
  assert.ok(await waitFor(() => !alive(status.pid), 5000), `daemon ${status.pid} ignored SIGTERM`);
  assert.ok(Date.now() - started < 5000);
  assert.equal(fs.readFileSync(marker, 'utf8'), body, 'the protection marker survives the exit');
});

// Seen in practice: orphaned daemons from a removed worktree. SIGTERM must still end one whose
// whole home is gone, without recreating that home.
test('SIGTERM exits a daemon whose home was deleted, and does not recreate it', options, async t => {
  const port = await freePort();
  const browser = await startHeadlessBrowser(port);
  t.after(async () => { stopLoggedDaemons({ port }); await browser.close(); });
  const home = fs.mkdtempSync('/tmp/bc-gone-');
  const child = await exec(process.execPath, ['--input-type=module', '-e',
    `import {connect} from ${JSON.stringify(new URL('../lib/daemon.mjs', import.meta.url).href)}; const c=await connect(${port}); console.log((await c.status()).pid); c.close();`],
    { env: { ...process.env, BROWSERCTRL_HOME: home, BROWSERCTRL_CAPTURE: '1' } });
  const pid = Number(child.stdout.trim());
  assert.ok(alive(pid));
  // Stop the socket check from ending it first: SIGTERM is what is under test.
  process.kill(pid, 'SIGSTOP');
  fs.rmSync(home, { recursive: true, force: true });
  process.kill(pid, 'SIGTERM');
  process.kill(pid, 'SIGCONT');
  assert.ok(await waitFor(() => !alive(pid), 5000), `daemon ${pid} ignored SIGTERM after its home was deleted`);
  assert.equal(fs.existsSync(home), false, 'shutdown must not recreate a deleted home');
});

// A test froze a daemon (SIGSTOP) and stopped before resuming it: a stopped process cannot act
// on SIGTERM, so the harness resumes it first.
test('the harness stops a frozen daemon it started, by PID', options, async t => {
  const port = await freePort();
  const browser = await startHeadlessBrowser(port);
  t.after(async () => { await browser.close(); });
  const client = await connect(port);
  const { pid } = await client.health();
  client.close();
  process.kill(pid, 'SIGSTOP');
  assert.deepEqual(stopLoggedDaemons({ port }), [pid]);
  // It was this process's child: gone once reaped.
  assert.ok(await waitFor(() => !alive(pid), 5000));
});

// The leak this guards against: one overnight run left 34 daemons on the test port.
test('a run of daemon-using test files leaves no daemon behind', options, async () => {
  const port = await freePort();
  const files = ['find-and-fields', 'read-snapshot', 'thaw', 'plan-use3-notices'].map(name => `test/${name}.test.mjs`);
  const env = { ...process.env, BROWSERCTRL_TEST_PORT: String(port) };
  // NODE_TEST_CONTEXT would make the inner run report to this runner instead of printing.
  for (const key of ['NODE_TEST_CONTEXT', 'BROWSERCTRL_HOME', 'BROWSERCTRL_TEST_DAEMON_LOG', 'BROWSERCTRL_AGENT_ID', 'BROWSERCTRL_BROWSER']) delete env[key];
  let output = '';
  try {
    ({ stdout: output } = await exec(process.execPath, ['--import', './test/helpers.mjs', '--test', '--test-concurrency=1', '--test-reporter=tap', ...files],
      { cwd: ROOT, env, maxBuffer: 64 * 1024 * 1024, timeout: 540000 }));
  } catch (error) { output = `${error.stdout}\n${error.stderr}`; }
  const left = await waitFor(() => daemonPids(port).length === 0, 15000) ? [] : daemonPids(port);
  // On failure, stop what the run left, by the PIDs found on this run's private port.
  for (const pid of left) { try { process.kill(pid, 'SIGCONT'); process.kill(pid, 'SIGKILL'); } catch {} }
  assert.deepEqual(left, [], `daemons left on port ${port}`);
  assert.match(output, /# fail 0/, output.slice(-4000));
});

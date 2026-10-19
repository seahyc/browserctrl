// Solver plugins: none ship; one listed in BROWSERCTRL_CAPTCHA_PLUGINS is loaded, detects
// its kind, makes its attempt, and answers its own CLI commands.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.BROWSERCTRL_CAPTCHA_PLUGINS = path.join(HERE, 'fixtures', 'fake-solver.mjs');
process.env.BROWSERCTRL_NOTIFY = '0';
const { connect } = await import('../lib/daemon.mjs');
const ops = await import('../lib/ops.mjs');
const { plugins, detect, solve } = await import('../lib/captcha.mjs');
const { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } = await import('./helpers.mjs');

test('a listed plugin loads; the CLI lists it and passes it its commands', async () => {
  const list = await plugins();
  assert.deepEqual(list.map(p => [p.name, p.kinds]), [['fake', ['fake-challenge']]]);
  const cli = (...a) => execFileSync(process.execPath, [path.join(HERE, '..', 'bin', 'browserctrl.mjs'), 'captcha', ...a], { encoding: 'utf8', env: process.env });
  assert.match(cli('plugins'), /fake\s+fake-challenge/);
  assert.deepEqual(JSON.parse(cli('fake', 'status', 'x')), { args: ['status', 'x'] });
  assert.throws(() => cli('solver', 'status'), /optional plugin/);
});

const haveBrowser = Boolean(chromeBinary());
let fixture, browser, conn;
before(async () => {
  if (!haveBrowser) return;
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => {
  try { await conn?.stop(); } catch {}
  try { conn?.close(); } catch {}
  await browser?.close();
  await fixture?.close();
});

test('the plugin detects its kind and clears it in one attempt', { skip: !haveBrowser && 'no Chromium-family browser installed' }, async () => {
  const { targetId } = await ops.newTab(conn, fixture.url + 'fixtures/fake-challenge.html');
  await ops.waitForReady(conn, targetId);
  assert.deepEqual(await detect(conn, targetId), { kind: 'fake-challenge' });
  const r = await solve(conn, targetId, { timeoutMs: 3000, pollMs: 200, handoff: false });
  assert.equal(r.solvedBy, 'fake');
  assert.equal(await detect(conn, targetId), null);
});

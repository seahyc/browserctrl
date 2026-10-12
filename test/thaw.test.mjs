// A frozen background tab answers synchronous evaluates but never settles a
// promise. The daemon must thaw the page before commands that need its event loop.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const haveBrowser = Boolean(chromeBinary());
let fixture, browser, conn, tabId;

before(async () => {
  if (!haveBrowser) return;
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
  tabId = (await ops.newTab(conn, fixture.url)).targetId;
  await ops.waitForReady(conn, tabId, { waitUntil: 'load' });
});

after(async () => {
  try { conn?.close(); } catch {}
  await browser?.close();
  await fixture?.close();
});

const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);

t('an awaited evaluate completes in a frozen tab', async () => {
  await conn.send(tabId, 'Page.setWebLifecycleState', { state: 'frozen' });
  const value = await ops.evaluate(conn, tabId, 'new Promise(r => setTimeout(() => r("thawed"), 20))', { timeoutMs: 8000 });
  assert.equal(value, 'thawed');
});

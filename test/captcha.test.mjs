// Captchas: the plain drag-to-end slider is solved once; anything else waits
// for the human and reports who cleared it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { detect, solve } from '../lib/captcha.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT, clearAfterFocus, scaled, describeLoad } from './helpers.mjs';

process.env.BROWSERCTRL_NOTIFY = '0';
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
const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
const open = async p => { const { targetId } = await ops.newTab(conn, fixture.url + p); await ops.waitForReady(conn, targetId); return targetId; };

t('a page without a challenge reports none', async () => {
  assert.equal(await detect(conn, await open('')), null);
  assert.deepEqual(await solve(conn, await open('')), { captcha: null });
});

t('the drag-to-end slider is solved with a gradual trusted drag', async () => {
  const tab = await open('captcha-slider');
  assert.equal((await detect(conn, tab)).kind, 'alibaba-slider');
  assert.deepEqual(await solve(conn, tab, { timeoutMs: 2000 }), { captcha: 'alibaba-slider', solvedBy: 'auto' });
  assert.equal(await ops.evaluate(conn, tab, "document.getElementById('msg').textContent"), '验证通过');
});

t('a puzzle challenge waits for the human and reports who cleared it', async () => {
  const tab = await open('verify/captcha?x=1');
  assert.equal((await detect(conn, tab)).kind, 'verification-page');
  const r = await clearAfterFocus(conn, () => solve(conn, tab, { timeoutMs: 5000, pollMs: 200 }), "history.replaceState(null, '', '/done')", 600);
  assert.equal(r.captcha, 'verification-page');
  assert.equal(r.solvedBy, 'human');
  assert.ok(r.waitedMs >= 400 && r.waitedMs < scaled(4000), `waited ${r.waitedMs}; ${describeLoad()}`);
});

t('an uncleared challenge times out with an error', async () => {
  const tab = await open('verify/captcha?x=2');
  await assert.rejects(solve(conn, tab, { timeoutMs: 600, pollMs: 200 }), /was not cleared within/);
});

t('an invisible captcha frame (as Stripe embeds) is not a challenge', async () => {
  const id = (await ops.newTab(conn, fixture.url + 'fixtures/invisible-captcha.html')).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  assert.equal(await detect(conn, id), null);
  await ops.closeTab(conn, id);
});

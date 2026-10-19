// What the page is waited on for: loading pages, markers that never change, pages that never
// complete, recorder stills after a click, progress bars, and sites that keep stalling.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import * as rec from '../lib/rec.mjs';
import { settle, waitForContent } from '../lib/steps.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-memo-'));
process.env.CDP_AGENT_ID = 'test-settle-and-waiting';
process.env.BROWSERCTRL_NOTIFY = '0';
process.env.BROWSERCTRL_TRACES = TRACES;
process.env.BROWSERCTRL_NOTES = 'off';
process.env.BROWSERCTRL_READ_TOKENS = path.join(MEMO, 'read-tokens.json');
process.env.BROWSERCTRL_SETTLE_MEMORY = path.join(MEMO, 'never.json');
process.env.BROWSERCTRL_SITE_TROUBLE = path.join(MEMO, 'trouble.json');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliRun = (args, env = process.env, timeout = 120000) => promisify(execFile)(process.execPath, [path.join(ROOT, 'bin/browserctrl.mjs'), ...args], { env, timeout });
const cli = (...args) => cliRun([...args, '--port', String(TEST_PORT)]);

const haveBrowser = Boolean(chromeBinary());
let fixture, browser, conn;
before(async () => {
  if (!haveBrowser) return;
  delete process.env.TYPESAFE_API_KEY;
  process.env.BROWSERCTRL_JEV_ENV = path.join(os.tmpdir(), 'no-such-jev.env');
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => {
  try { conn?.close(); } catch {}
  await browser?.close();
  await fixture?.close();
  fs.rmSync(TRACES, { recursive: true, force: true });
  fs.rmSync(MEMO, { recursive: true, force: true });
});
const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
const url = (page) => fixture.url + 'fixtures/' + page;
const open = async (page, waitUntil = 'load') => {
  const id = (await ops.newTab(conn, url(page))).targetId;
  await ops.waitForReady(conn, id, { waitUntil });
  return id;
};
const js = (id, expr) => ops.evaluate(conn, id, expr);
const click = (id, sel) => ops.evaluate(conn, id, `document.querySelector(${JSON.stringify(sel)}).click(), Date.now()`);
const outDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-slice-c-'));
const stepsOf = (dir) => rec.readJsonl(path.join(dir, 'steps.jsonl')).filter(s => s.screenshot);

t('read waits for a loading page to fill in, and says how long it waited', async () => {
  const id = await open('slice-loading.html');
  const { stdout } = await cli('read', id.slice(0, 8));
  assert.match(stdout, /^wait: waited \d+\.\d s for the page to finish loading$/m, stdout);
  assert.match(stdout, /Condo B · \$2,100/);
  assert.doesNotMatch(stdout, /^loading:.*skeleton/m);
  const quick = await cli('read', id.slice(0, 8));
  assert.doesNotMatch(quick.stdout, /^wait:/m, 'a loaded page is read at once');
});

t('a page whose loading markers never change is read once they hold still; --no-wait reads at once', async () => {
  const id = await open('read-skeleton.html');
  const { stdout } = await cli('read', id.slice(0, 8));
  assert.match(stdout, /^wait: waited .* stopped changing, so the page is read as loaded$/m, stdout);
  const st = await ops.settle(conn, id, { timeoutMs: 600, stableMs: 5000 });
  assert.equal(st.cleared, false);
  assert.match(ops.describeSettle(st), /still loading .*skeleton/);
  const raw = await cli('read', id.slice(0, 8), '--no-wait');
  assert.doesNotMatch(raw.stdout, /^wait:/m);
});

t('a still after a click waits for skeletons to give way to results', async () => {
  const id = await open('slice-c-results.html');
  const dir = outDir();
  await rec.start(conn, id, { out: dir });
  const at = await click(id, '#show');
  const row = await rec.still(conn, id, 'click "Show places"');
  assert.ok(row, 'a still was taken');
  assert.ok(row.at - at >= 1200, `the still waited for the results (${row.at - at} ms after the click)`);
  assert.equal(row.wait?.cleared, true, JSON.stringify(row.wait));
  await rec.stop(conn, id);
  await ops.closeTab(conn, id);
});

t('a still after a click waits while the clicked button shows its loading state', async () => {
  const id = await open('slice-c-results.html');
  const dir = outDir();
  await rec.start(conn, id, { out: dir });
  const at = await click(id, '#add-slow');
  const row = await rec.still(conn, id, 'click "Add to cart"');
  assert.ok(row.at - at >= 1200, `the still waited for the cart to answer (${row.at - at} ms after the click)`);
  assert.equal(row.wait?.cleared, true, JSON.stringify(row.wait));
  assert.equal(await ops.evaluate(conn, id, `document.getElementById('bag').textContent`), 'Sofa was added to your cart');
  await rec.stop(conn, id);
  await ops.closeTab(conn, id);
});

t('a read adds a still when the page changed without a navigation, and only then', async () => {
  const id = await open('slice-c-results.html');
  const dir = outDir();
  await rec.start(conn, id, { out: dir });
  assert.equal(await rec.still(conn, id, 'read', { ifChanged: true }), null, 'nothing changed since the start still');
  await click(id, '#add');
  const row = await rec.still(conn, id, 'read', { ifChanged: true });
  assert.ok(row, 'the in-page change ("added to your bag") gets a still though the URL is the same');
  assert.equal(await rec.still(conn, id, 'read', { ifChanged: true }), null, 'no duplicate still');
  await rec.stop(conn, id);
  assert.deepEqual(stepsOf(dir).map(s => s.action), ['start recording', 'read', 'stop recording']);
  await ops.closeTab(conn, id);
});

t('stopping a recording settles before its final still', async () => {
  const id = await open('slice-c-results.html');
  const dir = outDir();
  await rec.start(conn, id, { out: dir });
  const at = await click(id, '#show');
  await rec.stop(conn, id);
  const last = stepsOf(dir).at(-1);
  assert.equal(last.action, 'stop recording');
  assert.ok(last.at - at >= 1200, `the final still waited for the results (${last.at - at} ms)`);
  await ops.closeTab(conn, id);
});

t('a page that never reaches readyState complete is read once it holds still, and remembered', async () => {
  const id = await open('slice-c-never.html', 'domcontentloaded');
  const ready = await ops.evaluate(conn, id, 'document.readyState');
  assert.notEqual(ready, 'complete', 'the fixture keeps loading');
  const first = await ops.settle(conn, id);
  // Stopped because nothing on screen was loading any more, not at the read's 8 s cap.
  assert.equal(first.neverCompletes, true, JSON.stringify(first));
  assert.ok(first.stable || first.cleared, JSON.stringify(first));
  const again = await ops.settle(conn, id);
  // Known now: settle returns cleared at once, without the 1 s of holding still.
  assert.equal(again.cleared, true, JSON.stringify(again));
  assert.equal(again.neverCompletes, true, JSON.stringify(again));
  await ops.closeTab(conn, id);
});

t('a settle is not held by a keepalive beacon or by a style-only animation', async () => {
  const id = await open('slice-r1.html?settle');
  await js(id, 'document.getElementById("go").click()');
  const ms = await settle(conn, id, {});
  // Why the wait ended, not how long it took: 'quiet' means the beacon and the animation did not
  // hold it; held by either, it would run to the 4 s cap and say so.
  assert.equal(settle.why, 'quiet', `settled in ${ms} ms (${settle.why})`);
  await ops.closeTab(conn, id);
});

t('a short page that has finished loading is not waited on as a loading shell', async () => {
  const id = await open('steps-friction5.html');
  const t0 = Date.now();
  await waitForContent(conn, id, { timeoutMs: 10000, minChars: 5000, stable: false });
  // Guards against waiting out the shell wait, which gives up at 10 s; a normal run takes 1-3 s.
  assert.ok(Date.now() - t0 < 9000, `waited ${Date.now() - t0} ms`);
  await ops.closeTab(conn, id);
});

t('a <progress> element holds a read until it goes', async () => {
  const id = await open('steps-general.html?progress=1');
  // What matters is that the read waited for the bar, not how long: a slow runner may
  // already be most of the way through the page's load when the wait starts.
  const before = await ops.evaluate(conn, id, '!!document.querySelector("progress")');
  const st = await ops.settle(conn, id);
  assert.equal(st.cleared, true, JSON.stringify(st));
  if (before) assert.equal(await ops.evaluate(conn, id, '!!document.querySelector("progress")'), false, 'the bar is gone when the wait ends');
  assert.equal(await ops.evaluate(conn, id, 'document.querySelector("#state").textContent'), 'loaded');
  await ops.closeTab(conn, id);
});

test('a site that keeps stalling is named as slowing or blocking automated browsing', () => {
  const href = 'https://shop.example.net/p/123';
  assert.equal(ops.siteTrouble(href), null);
  ops.noteSiteTrouble(href, 'never_complete');
  ops.noteSiteTrouble('https://www.shop.example.net/p/456', 'timeout');
  assert.equal(ops.siteTrouble(href), null, 'two signs are not yet a pattern');
  ops.noteSiteTrouble(href, 'slow');
  const msg = ops.siteTrouble(href);
  assert.match(msg, /shop\.example\.net seems to be slowing or blocking automated browsing/);
  assert.match(msg, /1 page that never finished loading/);
  assert.match(msg, /1 command that timed out/);
  assert.equal(ops.siteTrouble('https://other.example.org/'), null);
  // The read's wait line carries it.
  assert.match(ops.describeSettle({ waitedMs: 8100, cleared: false, why: 'readyState interactive', href }), /slowing or blocking/);
});

// Friction found by the Online-Mind2Web round 3 runs: the recorder's stills were taken
// before the page finished loading (the judge saw skeletons and spinners on pages that
// had loaded), an agent's final read added no still when the URL had not changed, and
// read waited the full 8 s on every read of a page that never reaches readyState complete.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import * as rec from '../lib/rec.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

process.env.CDP_AGENT_ID = 'test-slice-c';
process.env.BROWSERCTRL_NOTIFY = '0';
process.env.BROWSERCTRL_SETTLE_MEMORY = path.join(os.tmpdir(), `browserctrl-test-never-complete-${process.pid}.json`);

const haveBrowser = Boolean(chromeBinary());
let fixture, browser, conn;
before(async () => {
  if (!haveBrowser) return;
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => {
  try { conn?.close(); } catch {}
  await browser?.close();
  await fixture?.close();
  fs.rmSync(process.env.BROWSERCTRL_SETTLE_MEMORY, { force: true });
});

const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
const open = async (page, waitUntil = 'load') => {
  const id = (await ops.newTab(conn, fixture.url + 'fixtures/' + page)).targetId;
  await ops.waitForReady(conn, id, { waitUntil });
  return id;
};
const click = (id, sel) => ops.evaluate(conn, id, `document.querySelector(${JSON.stringify(sel)}).click(), Date.now()`);
const outDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-slice-c-'));
const stepsOf = (dir) => rec.readJsonl(path.join(dir, 'steps.jsonl')).filter(s => s.screenshot);

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

// Best Buy's filter read "Sam ung Galaxy S25+": the page-side label cleanup was written
// /\s+/ inside a template string, which the page received as /s+/.
t('a field named by its <label for> keeps every letter', async () => {
  const id = await open('slice-c-results.html');
  const snap = await ops.readPage(conn, id, {});
  const box = snap.elements.find(e => e.role === 'checkbox');
  assert.equal(box?.name, 'Samsung Galaxy S25+ (12)', JSON.stringify(box));
  await ops.closeTab(conn, id);
});

t('a page that never reaches readyState complete is read once it holds still, and remembered', async () => {
  const id = await open('slice-c-never.html', 'domcontentloaded');
  const ready = await ops.evaluate(conn, id, 'document.readyState');
  assert.notEqual(ready, 'complete', 'the fixture keeps loading');
  const first = await ops.settle(conn, id);
  assert.ok(first.waitedMs < 3500, `stopped waiting once nothing was left to load on screen (${first.waitedMs} ms)`);
  assert.ok(first.stable || first.cleared, JSON.stringify(first));
  const again = await ops.settle(conn, id);
  assert.ok(again.waitedMs < 600, `a page known never to complete is not waited on again (${again.waitedMs} ms)`);
  await ops.closeTab(conn, id);
});

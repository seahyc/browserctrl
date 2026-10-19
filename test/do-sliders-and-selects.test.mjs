// Sliders and selects: native and ARIA sliders, ranges with two ends, a slider beside a box,
// and selects inside shadow roots or laid over a styled button.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { parseStep, runSteps, formatSteps } from '../lib/steps.mjs';
import { fakeJev, planJev } from './fake-jev.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-memo-'));
process.env.CDP_AGENT_ID = 'test-do-sliders-and-selects';
process.env.BROWSERCTRL_NOTIFY = '0';
process.env.BROWSERCTRL_TRACES = TRACES;
process.env.BROWSERCTRL_NOTES = 'off';
process.env.BROWSERCTRL_READ_TOKENS = path.join(MEMO, 'read-tokens.json');
process.env.BROWSERCTRL_SETTLE_MEMORY = path.join(MEMO, 'never.json');
process.env.BROWSERCTRL_SITE_TROUBLE = path.join(MEMO, 'trouble.json');

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
const state = (id) => ops.evaluate(conn, id, `document.querySelector('#state').textContent`);
const outState = async (id) => Object.fromEntries(String(await ops.evaluate(conn, id, 'document.querySelector("#out").dataset.s || ""')).split(';').filter(Boolean).map(x => x.split('=')));
const js = (id, expr) => ops.evaluate(conn, id, expr);
const run = async (id, steps) => { const r = await runSteps(conn, id, steps, { jev: fakeJev(), noNotes: true }); console.log(formatSteps(r)); return r; };

test('set steps parse a value or a range in any currency or separator', () => {
  assert.deepEqual(parseStep('set "Distance" = 40'), { action: 'set', target: 'Distance', value: '40', values: [40] });
  assert.deepEqual(parseStep('set "Price" = $300–$900').values, [300, 900]);
  assert.deepEqual(parseStep('set Price = 1,200 to 2,500').values, [1200, 2500]);
  assert.deepEqual(parseStep('set ref_4 = 7').ref, 'ref_4');
  assert.throws(() => parseStep('set "Price" = cheap'), /set <slider> = <value>/);
});

t('a native range input is set by value and reports where it ended', async () => {
  const id = await open('?sliders=1');
  const r = await run(id, ['set "Distance" = 40']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal((await outState(id)).dist, '40');
  assert.match(formatSteps(r), /now 40/);
  await ops.closeTab(conn, id);
});

t('an ARIA slider named by aria-labelledby is moved with keys to the value', async () => {
  const id = await open('?sliders=1');
  const r = await run(id, ['set "Speaker volume" = 37']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal((await outState(id)).vol, '37');
  await ops.closeTab(conn, id);
});

t('a two-thumb range under a group heading takes both ends, in an order the thumbs allow', async () => {
  const id = await open('?sliders=1');
  // 600 is above the current maximum (400): the maximum must move first.
  const r = await run(id, ['set "Nightly budget" = $600-$900']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal((await outState(id)).budget, '600-900');
  assert.match(formatSteps(r), /now 600[–-]900/);
  await ops.closeTab(conn, id);
});

t('a pair of native ranges forming one range is set end by end', async () => {
  const id = await open('?sliders=1');
  const r = await run(id, ['set "Model year" = 2018-2023']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal((await outState(id)).year, '2018-2023');
  await ops.closeTab(conn, id);
});

t('ends that bound each other move in an order their live limits allow, both ways', async () => {
  const id = await open('?sliders=1');
  let r = await run(id, ['set "Room rate" = 300-350']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal((await outState(id)).rate, '300-350');
  r = await run(id, ['set "Room rate" = 20-60']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal((await outState(id)).rate, '20-60');
  assert.ok(!r.steps[0].unsure, 'reached exactly');
  await ops.closeTab(conn, id);
});

t('fill on a slider sets it', async () => {
  const id = await open('?sliders=1');
  const r = await run(id, ['fill "Distance" = 65']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal((await outState(id)).dist, '65');
  await ops.closeTab(conn, id);
});

t('a slider that will not move stops the plan with where it is', async () => {
  const id = await open('?sliders=1');
  const r = await run(id, ['set "Locked dial" = 8']);
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /Locked dial.*3/s);
  await ops.closeTab(conn, id);
});

t('a number filled into a field that is also a slider goes into the text box', async () => {
  const id = await open('slice-r2.html?price=1');
  const r = await runSteps(conn, id, ['fill "Maximum Price" = "39.99"'], { jev: planJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await state(id), 'box 39.99');
  await ops.closeTab(conn, id);
});

t('a slider that rounds the value is marked unsure with what was asked', async () => {
  const id = await open('slice-r2.html?slideronly=1');
  const r = await runSteps(conn, id, ['fill "Maximum Price" = "39.99"'], { jev: planJev(), noNotes: true });
  const out = formatSteps(r);
  console.log(out);
  assert.equal(r.steps[0].unsure, true);
  assert.match(out, /set 40, asked 39\.99/);
  await ops.closeTab(conn, id);
});

t('a combobox in a shadow root is named by its shadow-root label, and select picks the option in its own list', async () => {
  const id = await open('slice-r1.html?sel');
  const snap = await ops.readPage(conn, id, { maxText: 0, max: 1500, all: true });
  const names = snap.elements.filter(e => e.role === 'combobox').map(e => e.name);
  assert.deepEqual(names, ['Min. Year', 'Max. Year']);
  const r = await run(id, ['select "Min. Year" = "2019"']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await js(id, 'document.getElementById("state").textContent'), 'Min. Year=2019');
  await ops.closeTab(conn, id);
});

t('select uses a transparent native select laid over a styled button', async () => {
  const id = await open('slice-r1.html?overlay');
  const r = await run(id, ['select "Relevance" = "Price - Low to High"']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await js(id, 'document.getElementById("state").textContent'), 'sort=Price - Low to High');
  await ops.closeTab(conn, id);
});

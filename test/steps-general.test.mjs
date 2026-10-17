// General controls, worded unlike any site the steps were tuned on: sliders (native, ARIA,
// two-thumb ARIA and native pairs, one that ignores input), calendars that show a pick in
// different ways (or not at all), order-entry and checkout guards, an error announced in
// another language, a <progress> load, and a site that keeps stalling. Jev is a fake.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { runSteps, formatSteps, parseStep } from '../lib/steps.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-memo-'));
process.env.BROWSERCTRL_TRACES = TRACES;
process.env.BROWSERCTRL_NOTES = 'off';
process.env.BROWSERCTRL_SETTLE_MEMORY = path.join(MEMO, 'never.json');
process.env.BROWSERCTRL_SITE_TROUBLE = path.join(MEMO, 'trouble.json');

function fakeJev() {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      if (q.type === 'noul') answers[id] = { type: 'noul', noul: 0.04 };
      else answers[id] = { type: 'choice', choice: 'none', probabilities: { none: 0.9 }, confidence: 0.9 };
    }
    return { ok: true, status: 200, json: async () => ({ answers, model: 'fake' }) };
  };
  return { cfg: { key: 'fake', model: 'fake' }, fetchImpl };
}

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
const open = async (q) => {
  const id = (await ops.newTab(conn, fixture.url + 'fixtures/steps-general.html' + q)).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  return id;
};
const state = async (id) => Object.fromEntries(String(await ops.evaluate(conn, id, 'document.querySelector("#out").dataset.s || ""')).split(';').filter(Boolean).map(x => x.split('=')));
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
  assert.equal((await state(id)).dist, '40');
  assert.match(formatSteps(r), /now 40/);
  await ops.closeTab(conn, id);
});

t('an ARIA slider named by aria-labelledby is moved with keys to the value', async () => {
  const id = await open('?sliders=1');
  const r = await run(id, ['set "Speaker volume" = 37']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal((await state(id)).vol, '37');
  await ops.closeTab(conn, id);
});

t('a two-thumb range under a group heading takes both ends, in an order the thumbs allow', async () => {
  const id = await open('?sliders=1');
  // 600 is above the current maximum (400): the maximum must move first.
  const r = await run(id, ['set "Nightly budget" = $600-$900']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal((await state(id)).budget, '600-900');
  assert.match(formatSteps(r), /now 600[–-]900/);
  await ops.closeTab(conn, id);
});

t('a pair of native ranges forming one range is set end by end', async () => {
  const id = await open('?sliders=1');
  const r = await run(id, ['set "Model year" = 2018-2023']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal((await state(id)).year, '2018-2023');
  await ops.closeTab(conn, id);
});

t('ends that bound each other move in an order their live limits allow, both ways', async () => {
  const id = await open('?sliders=1');
  let r = await run(id, ['set "Room rate" = 300-350']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal((await state(id)).rate, '300-350');
  r = await run(id, ['set "Room rate" = 20-60']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal((await state(id)).rate, '20-60');
  assert.ok(!r.steps[0].unsure, 'reached exactly');
  await ops.closeTab(conn, id);
});

t('fill on a slider sets it', async () => {
  const id = await open('?sliders=1');
  const r = await run(id, ['fill "Distance" = 65']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal((await state(id)).dist, '65');
  await ops.closeTab(conn, id);
});

t('a slider that will not move stops the plan with where it is', async () => {
  const id = await open('?sliders=1');
  const r = await run(id, ['set "Locked dial" = 8']);
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /Locked dial.*3/s);
  await ops.closeTab(conn, id);
});

for (const mode of ['aria', 'class', 'closes', 'hidden', 'numbers']) {
  t(`a date pick is confirmed when the calendar shows it (${mode})`, async () => {
    const id = await open(`?cal=${mode}`);
    const steps = mode === 'closes' ? ['click "Arrival"', 'date 2026-10-17'] : ['date 2026-10-17'];
    const r = await run(id, steps);
    assert.equal(r.done, true, JSON.stringify(r.stopped));
    assert.equal((await state(id)).picked, '2026-10-17');
    await ops.closeTab(conn, id);
  });
}

t('a date click the calendar ignores stops instead of passing as done', async () => {
  const id = await open('?cal=dead');
  const r = await run(id, ['date 2026-10-17']);
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /doesn't show it selected/);
  await ops.closeTab(conn, id);
});

t('a collapsed control that opens a dialog with a grid is opened for a date step, whatever its words', async () => {
  const id = await open('?cal=opener');
  const r = await run(id, ['date 2026-10-17']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(r.steps[0].how, /opened/);
  await ops.closeTab(conn, id);
});

t('entry buttons that only start an order or booking run until the page asks for payment', async () => {
  let id = await open('?guards=1');
  let r = await run(id, ['click "Reserve now"', 'click "Start a booking"']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(r.steps[0].how, /starts an order/);
  r = await run(id, ['click "Complete purchase"']);
  assert.equal(r.done, false, 'a purchase still needs click!');
  await ops.closeTab(conn, id);
  id = await open('?guards=1&checkout=1');
  r = await run(id, ['click "Reserve now"']);
  assert.equal(r.done, false, 'with a card field on the page, Reserve now commits');
  await ops.closeTab(conn, id);
});

t('an alert tied to a field by aria-errormessage is an error in any language', async () => {
  const id = await open('?guards=1');
  const r = await run(id, ['click "Valider"']);
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /error.*obligatoire/s);
  await ops.closeTab(conn, id);
});

t('a <progress> element holds a read until it goes', async () => {
  const id = await open('?progress=1');
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

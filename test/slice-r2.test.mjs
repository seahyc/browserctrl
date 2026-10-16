// Friction found in held-out rotation 2: a newsletter popup and a quiz drawn in shadow
// roots (Speedo, Healthline), duplicate sort radios read from the hidden copy, a radius
// radio skipped as "already on", a slider filled instead of the box beside it, swatch
// sizes behind hidden radios, a ref lost to the page redrawing itself (Wine Access), results
// left out of view, a bot check that clears on reload, and a stuck page on navigation.
// Jev is a deterministic fake.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import * as jev from '../lib/jev.mjs';
import * as captcha from '../lib/captcha.mjs';
import { deepTextExpression } from '../lib/refs.mjs';
import { itemsExpression, formatItems } from '../lib/items.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
const NOTES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-notes-'));
process.env.BROWSERCTRL_TRACES = TRACES;
process.env.BROWSERCTRL_NOTES_DIR = NOTES;
process.env.BROWSERCTRL_NOTES = 'off';
process.env.BROWSERCTRL_NOTIFY = '0';

// targets: intent -> [pattern for the picked name, probability]. A blocker answers yes when
// the page has overlay text.
function fakeJev(targets = {}) {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      if (q.type === 'noul') answers[id] = { type: 'noul', noul: id === 'blocker' && body.state.page?.overlay ? 0.93 : 0.04 };
      else if (q.type === 'choice') {
        const intent = Object.keys(targets).find(k => q.instructions.includes(`"${k}"`));
        const [re, p] = intent ? targets[intent] : [null, 0.9];
        const key = (re && Object.keys(q.criteria).find(k => k !== 'none' && re.test(q.criteria[k].name || ''))) || 'none';
        const keys = Object.keys(q.criteria);
        answers[id] = { type: 'choice', choice: key, probabilities: Object.fromEntries(keys.map(k => [k, k === key ? p : (1 - p) / (keys.length - 1)])), confidence: p };
      }
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
  fs.rmSync(NOTES, { recursive: true, force: true });
});
const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
const page = (q = '') => fixture.url + 'fixtures/slice-r2.html' + q;
const open = async (q) => {
  const id = (await ops.newTab(conn, page(q))).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  return id;
};
const state = (id) => ops.evaluate(conn, id, `document.querySelector('#state').textContent`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

t('a popup in a shadow root is seen as an overlay, its icon close button is named Close, and closing it works', async () => {
  const id = await open('?shadowpop=1');
  const v = await ops.evaluate(conn, id, jev.VIEW_TEXT);
  assert.match(v.overlay, /Sign up to our emails/, `overlay text: ${JSON.stringify(v.overlay)}`);
  const snap = await ops.readPage(conn, id, { maxText: 0, max: 1500, all: true });
  const close = snap.elements.find(e => e.role === 'button' && /close/i.test(e.name || ''));
  assert.ok(close, `no Close button: ${JSON.stringify(snap.elements.map(e => [e.role, e.name]))}`);
  assert.doesNotMatch(close.name, /unnamed/);
  const r = await runSteps(conn, id, ['click "Close"'], { jev: fakeJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await state(id), 'closed');
  await ops.closeTab(conn, id);
});

t('a web component popup over a cookie dialog is named as the cover, and closing it lets the dialog be answered', async () => {
  const id = await open('?stacked=1');
  const r1 = await runSteps(conn, id, ['click "Reject All"'], { jev: fakeJev(), noNotes: true });
  console.log(formatSteps(r1));
  assert.equal(r1.done, false);
  // The stop names the popup on top and its way out (as the cover, or as the blocking overlay).
  assert.match(formatSteps(r1), /Are you in the right place/);
  assert.match(formatSteps(r1), /Close/);
  assert.doesNotMatch(formatSteps(r1), /covered by body/);
  const r2 = await runSteps(conn, id, ['click "Close"', 'click "Reject All"'], { jev: fakeJev(), noNotes: true });
  console.log(formatSteps(r2));
  assert.equal(r2.done, true, JSON.stringify(r2.stopped));
  assert.equal(await state(id), 'closed rejected');
  await ops.closeTab(conn, id);
});

t('a made-up row name does not make a plain icon button commit; a submit in a sign-up form still does', async () => {
  const id = await open('?derived=1');
  const snap = await ops.readPage(conn, id, { maxText: 0, max: 1500, all: true });
  const tour = snap.elements.find(e => /app tour/i.test(e.name || ''));
  const send = snap.elements.find(e => /mailing list/i.test(e.name || ''));
  assert.ok(tour && send, JSON.stringify(snap.elements.map(e => [e.role, e.name])));
  assert.equal(jev.commits(tour.name, tour), false, `tour: ${JSON.stringify(tour)}`);
  assert.equal(jev.commits(send.name, send), true, `send: ${JSON.stringify(send)}`);
  const r = await runSteps(conn, id, [`click "${tour.name}"`], { jev: fakeJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await state(id), 'tour');
  await ops.closeTab(conn, id);
});

t('text, read and items see a quiz drawn in a shadow root, and a plan can answer it', async () => {
  const id = await open('?shadowquiz=1');
  const text = await ops.evaluate(conn, id, deepTextExpression());
  assert.match(text, /How often do you exercise\?/);
  assert.match(text, /Most days/);
  assert.match(text, /Weight quiz/);
  assert.ok(text.indexOf('Weight quiz') < text.indexOf('How often'), 'light text before the component that follows it');
  const snap = await ops.readPage(conn, id, { maxText: 20000, max: 1500, all: true });
  assert.match(snap.text, /How often do you exercise\?/);
  const items = await ops.evaluate(conn, id, itemsExpression({}));
  assert.match(formatItems(items, { full: true }), /Most days/, formatItems(items, { full: true }));
  const r = await runSteps(conn, id, ['click "Most days"'], { jev: fakeJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(r.steps[0].checked, true);
  assert.equal(await state(id), 'Most days');
  await ops.closeTab(conn, id);
});

t('a sort radio drawn twice is judged by the copy on screen after the page redraws', async () => {
  const id = await open('?dupsort=1');
  const r = await runSteps(conn, id, ['click "Price - Low to High"'], { jev: fakeJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.ok(r.steps[0].checked === true || /in its address/.test(r.steps[0].how), JSON.stringify(r.steps[0]));
  assert.match(await state(id), /sorted Price - Low to High/);
  await ops.closeTab(conn, id);
});

t('a radio named by the step is clicked even when it already reads as chosen', async () => {
  const id = await open('?radius=1');
  const r = await runSteps(conn, id, ['click "10mi"'], { jev: fakeJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await state(id), 'clicked 10mi');
  assert.doesNotMatch(r.steps[0].how, /not clicked/);
  await ops.closeTab(conn, id);
});

t('a number filled into a field that is also a slider goes into the text box', async () => {
  const id = await open('?price=1');
  const r = await runSteps(conn, id, ['fill "Maximum Price" = "39.99"'], { jev: fakeJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await state(id), 'box 39.99');
  await ops.closeTab(conn, id);
});

t('a slider that rounds the value is marked unsure with what was asked', async () => {
  const id = await open('?slideronly=1');
  const r = await runSteps(conn, id, ['fill "Maximum Price" = "39.99"'], { jev: fakeJev(), noNotes: true });
  const out = formatSteps(r);
  console.log(out);
  assert.equal(r.steps[0].unsure, true);
  assert.match(out, /set 40, asked 39\.99/);
  await ops.closeTab(conn, id);
});

t('sizes drawn as labels over hidden radios are clicked through their labels', async () => {
  const id = await open('?swatch=1');
  let r = await runSteps(conn, id, ['click "L"'], { jev: fakeJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await state(id), 'size L');
  r = await runSteps(conn, id, ['click "40"'], { jev: fakeJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await state(id), 'size 40');
  await ops.closeTab(conn, id);
});

t('a ref whose element the page redrew is found again by role and name', async () => {
  const id = await open('?redraw=1');
  let snap = await ops.readPage(conn, id, { maxText: 0, max: 1500, all: true });
  let ref = snap.elements.find(e => e.name === 'Max Price').ref;
  await ops.evaluate(conn, id, 'redrawSoon()');
  await sleep(500);
  const r = await runSteps(conn, id, [`fill ${ref} = "40"`], { jev: fakeJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await state(id), 'max 40');
  // A direct command too: the snapshot's token still names the old element.
  snap = await ops.readPage(conn, id, { maxText: 0, max: 1500, all: true });
  ref = snap.elements.find(e => e.name === 'Max Price').ref;
  await ops.evaluate(conn, id, 'redrawSoon()');
  await sleep(500);
  await ops.fill(conn, id, { ref, token: snap.token, value: '55' });
  assert.equal(await state(id), 'max 55');
  await ops.closeTab(conn, id);
});

t('a plan that ends with its results out of view scrolls them into view for --then items', async () => {
  const id = await open('?results=1');
  await ops.evaluate(conn, id, 'scrollTo(0, 0)');
  const r = await runSteps(conn, id, ['click "Red"'], { jev: fakeJev(), noNotes: true, then: 'items', prefetch: false });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  const y = await ops.evaluate(conn, id, 'scrollY');
  assert.ok(y > 800, `results should be in view, scrollY=${y}`);
  assert.match(formatSteps(r), /scrolled the results into view/);
  await ops.closeTab(conn, id);
});

t('a bot check that outlasts the wait gets one reload before giving up', async () => {
  const id = await open('?challenge=1');
  await ops.evaluate(conn, id, 'sessionStorage.removeItem("loads")');
  await ops.reload(conn, id);
  const found = await captcha.detect(conn, id);
  assert.ok(found, 'the first load shows a challenge');
  const r = await captcha.handoff(conn, id, { found, timeoutMs: 1500, pollMs: 300, focus: false });
  assert.equal(r.solvedBy, 'reload', JSON.stringify(r));
  await ops.closeTab(conn, id);
});

t('navigating away from a stuck page recovers it and lands on the new address', async () => {
  const id = (await ops.newTab(conn, fixture.url + 'fixtures/slice-b2-hang-always.html')).targetId;
  await sleep(1500); // the loop starts after load
  const to = page('?radius=1');
  const r = await ops.navigate(conn, id, to, { timeoutMs: 12000 });
  assert.ok(r.recovered || r.url === to, JSON.stringify(r));
  const tab = r.targetId || id;
  assert.equal(await ops.evaluate(conn, tab, 'location.href'), to);
  await ops.closeTab(conn, tab);
});

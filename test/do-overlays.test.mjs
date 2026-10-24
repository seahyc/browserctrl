// Overlays and covered controls: dialogs, popups and notices that block a step, dismissing the
// listed kinds, and controls under a pinned footer or a popup iframe.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import * as jev from '../lib/jev.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { planJev, scenarioJev } from './fake-jev.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-memo-'));
process.env.CDP_AGENT_ID = 'test-do-overlays';
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
const text = (id, sel) => ops.evaluate(conn, id, `document.querySelector(${JSON.stringify(sel)}).textContent`);
const state = (id) => ops.evaluate(conn, id, `document.querySelector('#state').textContent`);

t('a popup in a shadow root is seen as an overlay, its icon close button is named Close, and closing it works', async () => {
  const id = await open('slice-r2.html?shadowpop=1');
  const v = await ops.evaluate(conn, id, jev.VIEW_TEXT);
  assert.match(v.overlay, /Sign up to our emails/, `overlay text: ${JSON.stringify(v.overlay)}`);
  const snap = await ops.readPage(conn, id, { maxText: 0, max: 1500, all: true });
  const close = snap.elements.find(e => e.role === 'button' && /close/i.test(e.name || ''));
  assert.ok(close, `no Close button: ${JSON.stringify(snap.elements.map(e => [e.role, e.name]))}`);
  assert.doesNotMatch(close.name, /unnamed/);
  const r = await runSteps(conn, id, ['click "Close"'], { jev: planJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await state(id), 'closed');
  await ops.closeTab(conn, id);
});

t('a web component popup over a cookie dialog is named as the cover, and closing it lets the dialog be answered', async () => {
  const id = await open('slice-r2.html?stacked=1');
  const r1 = await runSteps(conn, id, ['click "Reject All"'], { jev: planJev(), noNotes: true });
  console.log(formatSteps(r1));
  assert.equal(r1.done, false);
  // The stop names the popup on top and its way out (as the cover, or as the blocking overlay).
  assert.match(formatSteps(r1), /Are you in the right place/);
  assert.match(formatSteps(r1), /Close/);
  assert.doesNotMatch(formatSteps(r1), /covered by body/);
  const r2 = await runSteps(conn, id, ['click "Close"', 'click "Reject All"'], { jev: planJev(), noNotes: true });
  console.log(formatSteps(r2));
  assert.equal(r2.done, true, JSON.stringify(r2.stopped));
  assert.equal(await state(id), 'closed rejected');
  await ops.closeTab(conn, id);
});

t('a dialog\'s own buttons are allowed, even duplicated or inside a shadow root', async () => {
  const id = await open('steps-friction.html');
  const jev = planJev();
  const r = await runSteps(conn, id, ['click "Show alerts"', 'click OK', 'click OK'], { jev: jev });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal((await text(id, '#oks')).trim().split(' ').length, 2);
  const r2 = await runSteps(conn, id, ['click "Open shadow modal"', 'click "Got it"'], { jev: jev });
  console.log(formatSteps(r2));
  assert.equal(r2.done, true, JSON.stringify(r2.stopped));
  assert.equal(await text(id, '#shadowDone'), 'type confirmed');
  await ops.closeTab(conn, id);
});

t('a stop under a popup iframe says the page is covered', async () => {
  const id = (await ops.newTab(conn, fixture.url + 'fixtures/steps-covered.html')).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  const r = await runSteps(conn, id, ['fill "the recipient email box" = a@b.co'], { jev: planJev() });
  console.log(formatSteps(r));
  assert.match(r.stopped.covered, /controls are covered by an iframe, likely a sign-up or chat popup/);
  assert.match(formatSteps(r), /^Covered: /m);
  await ops.closeTab(conn, id);
});

t('a toggle under a pinned footer is offered and clicked clear of it', async () => {
  const id = await open('steps-friction4.html?filters=open');
  const snap = await ops.readPage(conn, id, { maxText: 0, max: 1500, all: true });
  const gym = snap.elements.find(e => e.name === 'Gym');
  assert.ok(gym?.covered, `Gym should sit under the footer: ${JSON.stringify(gym)}`);
  assert.equal(gym.coverPinned, true);
  const r = await runSteps(conn, id, ['click "Gym"'], { jev: planJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(r.steps[0].how, 'exact');
  assert.equal(await text(id, '#state'), 'Gym');
  await ops.closeTab(conn, id);
});

t('a toggle clipped by its scrolling list under a static footer is offered and scrolled into view', async () => {
  const id = await open('steps-friction4.html?filters=list');
  const snap = await ops.readPage(conn, id, { maxText: 0, max: 1500, all: true });
  const gym = snap.elements.find(e => e.name === 'Gym');
  assert.ok(gym?.covered && gym.coverPinned, `Gym should be clipped and reachable: ${JSON.stringify(gym)}`);
  const r = await runSteps(conn, id, ['click "Gym"'], { jev: planJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await text(id, '#state'), 'Gym');
  await ops.closeTab(conn, id);
});

t('a notice on top that only closes (Got it, ×) is closed and reported, then the step runs', async () => {
  const id = await open('steps-friction4.html?notice=1');
  const r = await runSteps(conn, id, ['click "Filters"'], { jev: planJev({ Filters: [/^Filters$/, 0.9] }, { blocks: false }), noNotes: true });
  const out = formatSteps(r);
  console.log(out);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(out, /dismissed notice dialog after step 0: "Now you’ll see one price/);
  assert.match(out, /\+ dialog "Filters" opened/);
  await ops.closeTab(conn, id);
});

t('a listed cookie banner is dismissed and recorded; unlisted it stops the plan', async () => {
  let id = await open('steps-shop.html?overlay=cookie');
  let jev = scenarioJev({ category: 'cookie banner' });
  let r = await runSteps(conn, id, ['click "More filters"'], { jev: jev, dismiss: 'cookie banner, app-install prompt' });
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(await ops.evaluate(conn, id, 'window.clicked'), ['accept']);
  assert.equal(await ops.evaluate(conn, id, 'document.getElementById("panel").hidden'), false);
  const d = r.events.find(e => e.type === 'dismissed');
  assert.equal(d.category, 'cookie banner');
  assert.match(d.text, /We use cookies/);
  assert.equal(d.control, 'button "Accept cookies"');
  assert.equal(d.after_step, 0);
  // The category question and the closing control come back from one request; the
  // privacy link is not offered.
  const ask = jev.calls.find(c => c.questions.category);
  assert.ok(ask.questions.control);
  assert.ok(!Object.values(ask.questions.control.criteria).some(c => /Privacy/.test(c.name || '')));
  await ops.closeTab(conn, id);

  id = await open('steps-shop.html?overlay=cookie');
  jev = scenarioJev({ category: 'cookie banner' });
  r = await runSteps(conn, id, ['click "More filters"'], { jev: jev, dismiss: 'app-install prompt' });
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /not one of the listed kinds/);
  assert.match(r.stopped.overlay, /We use cookies/);
  assert.ok(r.stopped.controls.includes('button "Accept cookies"'));
  assert.deepEqual(await ops.evaluate(conn, id, 'window.clicked'), []);

  // Without --dismiss the same banner stops the plan too, with no extra request.
  jev = scenarioJev();
  r = await runSteps(conn, id, ['click "More filters"'], { jev: jev });
  assert.match(r.stopped.reason, /blocking the page/);
  assert.match(formatSteps(r), /Overlay: "We use cookies/);
  await ops.closeTab(conn, id);
});

t('an overlay control that subscribes or buys is never clicked', async () => {
  let id = await open('steps-shop.html?overlay=newsletter');
  let jev = scenarioJev({ category: 'newsletter popup' });
  let r = await runSteps(conn, id, ['click "More filters"'], { jev: jev, dismiss: 'newsletter popup' });
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(await ops.evaluate(conn, id, 'window.clicked'), ['nothanks']);
  assert.equal(r.events[0].control, 'button "No thanks"');
  await ops.closeTab(conn, id);

  id = await open('steps-shop.html?overlay=subscribe');
  jev = scenarioJev({ category: 'promotion popup' });
  r = await runSteps(conn, id, ['click "More filters"'], { jev: jev, dismiss: 'newsletter popup, promotion popup' });
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /no safe control closes it/);
  assert.deepEqual(await ops.evaluate(conn, id, 'window.clicked'), []);
  assert.ok(!jev.calls.some(c => c.questions.control), 'Subscribe and Buy are never offered as closing controls');
  await ops.closeTab(conn, id);
});

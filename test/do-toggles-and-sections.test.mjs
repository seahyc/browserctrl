// Checkboxes, radios and toggles read back correctly, and sections that open or close on the way
// to a target: opened once, left open when the plan goes on into them, closed when they cover.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { fakeJev, planJev } from './fake-jev.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-memo-'));
process.env.CDP_AGENT_ID = 'test-do-toggles-and-sections';
process.env.BROWSERCTRL_NOTIFY = '0';
process.env.BROWSERCTRL_TRACES = TRACES;
process.env.BROWSERCTRL_NOTES = 'off';
process.env.BROWSERCTRL_READ_TOKENS = path.join(MEMO, 'read-tokens.json');
process.env.BROWSERCTRL_SETTLE_MEMORY = path.join(MEMO, 'never.json');
process.env.BROWSERCTRL_SITE_TROUBLE = path.join(MEMO, 'trouble.json');

// Jev answers "none" for every target and no overlay: only browserctrl's own logic acts.
const noJev = fakeJev();

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
const js = (id, expr) => ops.evaluate(conn, id, expr);
const run = async (id, steps) => { const r = await runSteps(conn, id, steps, { jev: fakeJev(), noNotes: true }); console.log(formatSteps(r)); return r; };

t('clicking a component\'s slotted heading opens its shadow-root disclosure, and says so', async () => {
  const id = await open('slice-r1.html?acc');
  const r = await run(id, ['click "Year"']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await js(id, 'document.getElementById("year").shadowRoot.querySelector("details").open'), true);
  assert.equal(r.steps[0].expanded, true, JSON.stringify(r.steps[0]));
  await ops.closeTab(conn, id);
});

t('a disclosure under a footer that is not sticky is scrolled clear, not clicked through', async () => {
  const id = await open('slice-r1.html?acc&footer');
  await js(id, 'document.querySelector(".panel-footer").addEventListener("click", () => { document.getElementById("state").textContent = "footer clicked"; })');
  const r = await run(id, ['click "Year"']);
  assert.notEqual(await js(id, 'document.getElementById("state").textContent'), 'footer clicked');
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await js(id, 'document.getElementById("year").shadowRoot.querySelector("details").open'), true);
  await ops.closeTab(conn, id);
});

t('a section this plan opened is closed once when the next step\'s target is hidden behind it', async () => {
  const id = await open('slice-r1.html?drill');
  const r = await run(id, ['click "Breed"', 'click "Age"']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(r.steps[1].how, /closed .*Breed.* first/, r.steps[1].how);
  assert.equal(await js(id, 'document.querySelector("section[data-s=Age] .h").getAttribute("aria-expanded")'), 'true');
  await ops.closeTab(conn, id);
});

t('a radio named by the step is clicked even when it already reads as chosen', async () => {
  const id = await open('slice-r2.html?radius=1');
  const r = await runSteps(conn, id, ['click "10mi"'], { jev: planJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await state(id), 'clicked 10mi');
  assert.doesNotMatch(r.steps[0].how, /not clicked/);
  await ops.closeTab(conn, id);
});

t('sizes drawn as labels over hidden radios are clicked through their labels', async () => {
  const id = await open('slice-r2.html?swatch=1');
  let r = await runSteps(conn, id, ['click "L"'], { jev: planJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await state(id), 'size L');
  r = await runSteps(conn, id, ['click "40"'], { jev: planJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await state(id), 'size 40');
  await ops.closeTab(conn, id);
});

t('an Ionic box already chosen, or a radio that updates late, is not a failed click', async () => {
  const id = await open('steps-friction2.html');
  const jev = planJev({}, { near: true });
  const r = await runSteps(conn, id, ['click "Milk, 110 Cal"', 'click PICKUP'], { jev: jev });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(r.steps[0].checked, true);
  assert.equal(r.steps[1].checked, true);
  assert.equal(await ops.evaluate(conn, id, 'document.getElementById("pickup").getAttribute("aria-checked")'), 'true');
  await ops.closeTab(conn, id);
});

t('a filter box drawn unticked while its results reload is read again once they arrive', async () => {
  const id = await open('steps-friction3.html');
  const r = await runSteps(conn, id, ['click "Free Breakfast (42)"'], { jev: planJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(r.steps[0].checked, true);
  // A box that really does not tick still stops the plan.
  const r2 = await runSteps(conn, id, ['click "Dead box"'], { jev: planJev(), noNotes: true });
  assert.match(r2.stopped?.reason || '', /did not take/);
  await ops.closeTab(conn, id);
});

t('an aria-pressed toggle reports pressed, check leaves it on, and plain click turns it off', async () => {
  const id = await open('steps-friction4.html?filters=open');
  const r = await runSteps(conn, id, ['click "Washer"'], { jev: planJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.steps[0].checked, true);
  assert.match(formatSteps(r), /now pressed/);
  const again = await runSteps(conn, id, ['check "Washer"'], { jev: planJev(), noNotes: true });
  console.log(formatSteps(again));
  assert.equal(again.done, true);
  assert.match(formatSteps(again), /already pressed/);
  assert.match(again.steps[0].how, /not clicked/);
  assert.equal(await text(id, '#state'), 'Washer');
  const namedOff = await runSteps(conn, id, ['click "Washer"'], { jev: planJev(), noNotes: true });
  assert.match(formatSteps(namedOff), /now not pressed/);
  assert.equal(await text(id, '#state'), '');
  await runSteps(conn, id, ['check "Washer"'], { jev: planJev(), noNotes: true });
  // By ref it is deliberate too: the toggle turns off.
  const snap = await ops.readPage(conn, id, { maxText: 0, max: 1500, all: true });
  const ref = snap.elements.find(e => e.name === 'Washer').ref;
  const off = await runSteps(conn, id, [`click ${ref}`], { jev: planJev(), noNotes: true });
  console.log(formatSteps(off));
  assert.match(formatSteps(off), /now not pressed/);
  assert.equal(await text(id, '#state'), '');
  await ops.closeTab(conn, id);
});

t('a section already open is left open when the plan goes on into it', async () => {
  const id = await open('steps-friction5.html');
  await runSteps(conn, id, ['click "Salary"'], { jev: noJev, noNotes: true });
  const r = await runSteps(conn, id, ['click "Salary"', 'click "Middle Income Jobs ($30K-$49K)"'], { jev: noJev, noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(formatSteps(r), /already open/);
  assert.equal(await state(id), 'middle income');
  // As the last step, the click is what the plan asked for: it closes.
  const shut = await runSteps(conn, id, ['click "Salary"'], { jev: noJev, noNotes: true });
  assert.equal(shut.steps[0].expanded, false);
  await ops.closeTab(conn, id);
});

t('an exact target in a collapsed section is found by opening that section', async () => {
  const id = await open('steps-friction5.html');
  const r = await runSteps(conn, id, ['click "High school diploma or equivalent"'], { jev: noJev, noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(r.steps[0].how, /opened "Education" first/);
  assert.equal(await state(id), 'high school');
  await ops.closeTab(conn, id);
});

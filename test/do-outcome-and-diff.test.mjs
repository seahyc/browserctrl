// What a plan reports after its steps: what changed on the page, new errors and notices,
// address parameters, and results scrolled into view.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { runSteps, formatSteps, newError, urlChange } from '../lib/steps.mjs';
import { fakeJev, planJev, scenarioJev } from './fake-jev.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-memo-'));
process.env.CDP_AGENT_ID = 'test-do-outcome-and-diff';
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
const run = async (id, steps) => { const r = await runSteps(conn, id, steps, { jev: fakeJev(), noNotes: true }); console.log(formatSteps(r)); return r; };

test('a new error title, alert or invalid field is an error; old ones are not', () => {
  const calm = { title: 'Savings', alerts: [], invalid: [] };
  assert.match(newError(calm, { title: 'Error - How much money', alerts: ['There is a problem: Select how much'], invalid: ['money'] }), /title "Error - How much money"; "There is a problem/);
  assert.equal(newError({ title: 'Error - x', alerts: ['a'], invalid: [] }, { title: 'Error - x', alerts: ['a'], invalid: [] }), null);
  assert.equal(newError(calm, calm), null);
});

t('an error after a step stops the plan; a named stepper and its row', async () => {
  const id = await open('steps-friction.html');
  const jev = planJev();
  const r = await runSteps(conn, id, ['click Continue', 'click "Increase Children"'], { jev: jev });
  console.log(formatSteps(r));
  assert.equal(r.stopped.step, 1);
  assert.match(r.stopped.reason, /error after this step: title "Error - How much money do you have"; "There is a problem: Select how much money you have"/);
  const r2 = await runSteps(conn, id, ['click "Increase Children"', 'click "Increase Children"', 'click "Decrease Children"'], { jev: jev });
  assert.equal(r2.done, true, JSON.stringify(r2.stopped));
  assert.ok(r2.steps.every(s => s.how === 'exact'));
  assert.equal(await text(id, '#kids'), '1');
  await ops.closeTab(conn, id);
});

t('a do report says what the plan changed on the page', async () => {
  const id = await open('steps-friction5.html');
  const r = await runSteps(conn, id, ['click "Salary"', 'click "Gym"', 'select "State" = "OH"'], { jev: noJev, noNotes: true });
  const text = formatSteps(r);
  console.log(text);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(text, /changed on the page:/);
  assert.match(text, /button "Salary": closed → open/);
  assert.match(text, /checkbox "Gym": unchecked → checked/);
  assert.match(text, /select "State": "ID" → "OH"/);
  assert.match(text, /\+ 1 new: link "Middle Income Jobs/);
  // Nothing changed: no section.
  const same = await runSteps(conn, id, ['scroll down'], { jev: noJev, noNotes: true });
  assert.doesNotMatch(formatSteps(same), /changed on the page/);
  await ops.closeTab(conn, id);
});

t('a plan that ends with its results out of view scrolls them into view for --then items', async () => {
  const id = await open('slice-r2.html?results=1');
  await ops.evaluate(conn, id, 'scrollTo(0, 0)');
  const r = await runSteps(conn, id, ['click "Red"'], { jev: planJev(), noNotes: true, then: 'items', prefetch: false });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  const y = await ops.evaluate(conn, id, 'scrollY');
  assert.ok(y > 800, `results should be in view, scrollY=${y}`);
  assert.match(formatSteps(r), /scrolled the results into view/);
  await ops.closeTab(conn, id);
});

t('a non-blocking toast is recorded as an event and not acted on', async () => {
  const id = await open('steps-shop.html');
  const jev = scenarioJev();
  const r = await runSteps(conn, id, ['fill Search = aeron', 'key Enter', 'click "More filters"', 'fill Maximum = 600', 'click Apply'], { jev: jev, dismiss: 'cookie banner' });
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  const n = r.events.filter(e => e.type === 'notice');
  assert.deepEqual(n.map(e => [e.after_step, e.text]), [[5, 'Price changed to S$590']]);
  assert.ok(!r.events.some(e => e.type === 'dismissed'));
  assert.equal(jev.calls.length, 1, 'only the final page check: the toast is not an overlay');
  assert.match(formatSteps(r), /notice after step 5: "Price changed to S\$590"/);
  await ops.closeTab(conn, id);
});

t('an alert tied to a field by aria-errormessage is an error in any language', async () => {
  const id = await open('steps-general.html?guards=1');
  const r = await run(id, ['click "Valider"']);
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /error.*obligatoire/s);
  await ops.closeTab(conn, id);
});

test('a step that sets a filter shows as added and removed parameters', () => {
  assert.equal(urlChange('https://x.io/list?page=2', 'https://x.io/list/?state=closed'), '+state=closed -page');
  assert.equal(urlChange('https://x.io/a', 'https://x.io/b?q=1'), '→ /b +q=1');
  assert.equal(urlChange('https://x.io/a', 'https://x.io/a'), null);
});

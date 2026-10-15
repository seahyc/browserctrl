// Friction found in real runs (Online-Mind2Web round 1): wrong picks reported as done,
// refs and selectors sent to Jev, a commit guard that stopped typing and links, dialogs
// that refused their own buttons, clicks that silently did nothing, and calendars.
// Jev is a deterministic fake: no request leaves the machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { itemsExpression } from '../lib/items.mjs';
import { commits } from '../lib/jev.mjs';
import { parseStep, runSteps, formatSteps, parseDateText, missingFromPick, newError, looksLikeSelector } from '../lib/steps.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
process.env.BROWSERCTRL_TRACES = TRACES;
process.env.BROWSERCTRL_NOTES = 'off';

// targets: intent -> [pattern for the picked name, probability]. A blocker is true whenever
// the state shows an overlay; every other yes/no question is no.
function fakeJev(targets = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
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
  return { calls, opts: { cfg: { key: 'fake', model: 'fake' }, fetchImpl } };
}

test('commit words count only on controls that can commit', () => {
  assert.equal(commits('Buy now'), true);
  assert.equal(commits('Place order', { role: 'button' }), true);
  assert.equal(commits('Order Now', { role: 'button' }), true);
  assert.equal(commits('Order Now', { role: 'link', href: '/order' }), false, 'a link only opens the order page');
  assert.equal(commits('Prime Video (purchase/rental)', { role: 'button' }), false, 'an aside in parentheses');
  assert.equal(commits('Where to watch Prime Video Netflix Hulu purchase', { role: 'button' }), false, 'the verb does not lead');
  assert.equal(commits('Prime Video (purchase/rental)', { role: 'checkbox' }), false);
  assert.equal(commits('Send-to email', { role: 'textbox' }), false, 'typing commits nothing');
  assert.equal(commits('Submit', { role: 'button' }), true);
  assert.equal(commits('Submit', { role: 'button' }, { afterSearchFill: true }), false, 'Submit after a search runs the search');
  assert.equal(commits('Submit order', { role: 'button' }, { afterSearchFill: true }), true);
  assert.equal(commits('Confirm purchase', { role: 'button' }), true);
});

test('steps: ! on a non-committing action just runs; refs, item ids, selectors and dates parse', () => {
  assert.deepEqual(parseStep('fill! "SEND-TO EMAIL" = a@b.co'), { action: 'fill', target: 'SEND-TO EMAIL', value: 'a@b.co' });
  assert.deepEqual(parseStep('click ref_25'), { action: 'click', target: 'ref_25', ref: 'ref_25' });
  assert.deepEqual(parseStep('click "ref_33"'), { action: 'click', target: 'ref_33', ref: 'ref_33' });
  assert.deepEqual(parseStep('click i140'), { action: 'click', target: 'i140', item: 'i140' });
  assert.deepEqual(parseStep('click "i5"'), { action: 'click', target: 'i5' }, 'a quoted i5 is a processor, not an item');
  assert.deepEqual(parseStep('click "#plp-color-COLOR-10139"'), { action: 'click', target: '#plp-color-COLOR-10139', selector: '#plp-color-COLOR-10139' });
  assert.deepEqual(parseStep(`click '[role="option"][data-value="600"]'`).selector, '[role="option"][data-value="600"]');
  assert.deepEqual(parseStep('date 2026-10-17'), { action: 'date', target: '2026-10-17' });
  assert.deepEqual(parseStep('date "Oct 17, 2026"'), { action: 'date', target: '2026-10-17' });
  assert.throws(() => parseStep('date soon'), /date YYYY-MM-DD/);
  assert.equal(looksLikeSelector('#1 best seller'), false);
  assert.equal(looksLikeSelector('More filters'), false);
  assert.equal(looksLikeSelector('button[type=submit]'), true);
});

test('calendar labels parse in every common format', () => {
  const want = { y: 2026, m: 10, d: 16 };
  for (const s of ['Friday, 16 October 2026', 'Oct 16, 2026', 'Fri Oct 16 2026', '16, Friday, October 2026. Available. Select as check-in date.',
    '2026-10-16', '10/16/2026', 'calendar-day-10/16/2026', 'October 16th, 2026']) assert.deepEqual(parseDateText(s), want, s);
  assert.equal(parseDateText('When Add dates'), null);
  assert.equal(parseDateText('Fri, Oct 16'), null, 'no year: not a whole date');
});

test('a pick must show the numbers and dates the step names', () => {
  assert.deepEqual(missingFromPick('October 17, 2026', { name: 'When Add dates' }), ['17', '2026', 'october']);
  assert.deepEqual(missingFromPick('Under $25,000', { name: 'Payment & Price' }), ['25000']);
  assert.deepEqual(missingFromPick('600', { role: 'button', name: 'minimum square feet' }), ['600']);
  assert.deepEqual(missingFromPick('Under $25,000', { name: 'Under $25,000' }), []);
  assert.deepEqual(missingFromPick('the 2nd result', { name: 'Aeron chair' }), [], 'ordinals are positions');
  assert.deepEqual(missingFromPick('Core i5 laptops', { name: 'Intel Core i5' }), [], 'i5 is a word, not a number');
  assert.deepEqual(missingFromPick('More filters', { name: 'Filters' }), []);
});

test('a new error title, alert or invalid field is an error; old ones are not', () => {
  const calm = { title: 'Savings', alerts: [], invalid: [] };
  assert.match(newError(calm, { title: 'Error - How much money', alerts: ['There is a problem: Select how much'], invalid: ['money'] }), /title "Error - How much money"; "There is a problem/);
  assert.equal(newError({ title: 'Error - x', alerts: ['a'], invalid: [] }, { title: 'Error - x', alerts: ['a'], invalid: [] }), null);
  assert.equal(newError(calm, calm), null);
});

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
});
const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
const open = async () => {
  const id = (await ops.newTab(conn, fixture.url + 'fixtures/steps-friction.html')).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  return id;
};
const text = (id, sel) => ops.evaluate(conn, id, `document.querySelector(${JSON.stringify(sel)}).textContent`);

t('typing, links and a search Submit are not commits; Place order still is', async () => {
  const id = await open();
  const jev = fakeJev();
  const r = await runSteps(conn, id, ['fill "SEND-TO EMAIL" = gift@example.com', 'fill "Search for parking" = SFMOMA', 'click Submit', 'click "Order Now"'], { jev: jev.opts });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await text(id, '#searched'), 'Searched: SFMOMA');
  assert.equal(r.steps[3].how, 'exact, first of 2', 'two links share the name: the first on screen');
  assert.match(await ops.evaluate(conn, id, 'location.hash'), /#order/);
  const r2 = await runSteps(conn, id, ['click "Place order"'], { jev: jev.opts });
  assert.match(r2.stopped.reason, /can commit something/);
  assert.equal(await text(id, '#placed'), '');
  await ops.closeTab(conn, id);
});

t('refs from the last read, item ids, selectors and listbox options act without Jev', async () => {
  const id = await open();
  const jev = fakeJev();
  const snap = await ops.readPage(conn, id, { maxText: 0 });
  const spa = snap.elements.find(e => /Spa/.test(e.name || '') && e.role === 'checkbox');
  assert.ok(spa, 'the read lists Spa');
  const items = await ops.evaluate(conn, id, itemsExpression({}));
  const second = items.groups.flatMap(g => g.items).find(it => /Result two/.test(it.text));
  const r = await runSteps(conn, id, [`click ${spa.ref}`, `click ${second.id}`, 'click "#gym"', 'click "600"'], { jev: jev.opts });
  console.log(formatSteps(r));
  assert.equal(jev.calls.filter(c => c.questions.target).length, 0, 'no step went to Jev');
  assert.equal(r.steps[0].how, spa.ref);
  assert.equal(await ops.evaluate(conn, id, 'document.getElementById("spa").checked'), true);
  assert.equal(r.steps[1].how, `item ${second.id}`);
  assert.equal(await ops.evaluate(conn, id, 'location.hash'), '#r2');
  // #gym never toggles: the plan stops there and says so.
  assert.equal(r.stopped.step, 3);
  assert.match(r.stopped.reason, /still unchecked; the click did not take/);
  assert.equal(r.steps.length, 3);
  const r2 = await runSteps(conn, id, ['click "600"'], { jev: jev.opts });
  assert.equal(r2.done, true, JSON.stringify(r2.stopped));
  assert.match(r2.steps[0].how, /exact|option/);
  assert.equal(await text(id, '#sqftPicked'), 'Min 600');
  // A ref from a read the page has since replaced is refused, not guessed at.
  await ops.evaluate(conn, id, 'location.reload()');
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  const r3 = await runSteps(conn, id, [`click ${spa.ref}`], { jev: jev.opts });
  assert.match(r3.stopped.reason, /is not on the page any more/);
  await ops.closeTab(conn, id);
});

t('a Jev pick without the step\'s numbers stops; an unsure pick is marked ⚠', async () => {
  const id = await open();
  const jev = fakeJev({ 'October 17, 2026': [/When Add dates/, 0.9], 'Under $25,000': [/Payment/, 0.9], 'the amenities spa box': [/Spa/, 0.65] });
  const r = await runSteps(conn, id, ['click "October 17, 2026"'], { jev: jev.opts });
  console.log(formatSteps(r));
  assert.match(r.stopped.reason, /Jev picked button "When Add dates" \(p=0.9\), which does not show "17", "2026", "october"/);
  assert.match(r.stopped.reason, /date YYYY-MM-DD/);
  const r2 = await runSteps(conn, id, ['click "Under $25,000"'], { jev: jev.opts });
  assert.match(r2.stopped.reason, /does not show "25000"/);
  const r3 = await runSteps(conn, id, ['click "the amenities spa box"'], { jev: jev.opts });
  assert.equal(r3.done, true, JSON.stringify(r3.stopped));
  assert.equal(r3.steps[0].unsure, true);
  assert.match(formatSteps(r3), /^⚠ 1\. click "the amenities spa box".*unsure: check the page.*now checked/m);
  await ops.closeTab(conn, id);
});

t('a date step pages the calendar to the day and refuses unavailable days', async () => {
  const id = await open();
  const jev = fakeJev();
  const r = await runSteps(conn, id, ['click "When Add dates"', 'date 2026-12-03'], { jev: jev.opts });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(r.steps[1].how, /date, paged 2 months/);
  assert.equal(await text(id, '#picked'), 'Picked Thursday, 3 December 2026');
  // A click that names a whole date in another format finds the cell too, paging back.
  const r2 = await runSteps(conn, id, ['click "Oct 16, 2026"'], { jev: jev.opts });
  assert.equal(r2.done, true, JSON.stringify(r2.stopped));
  assert.equal(await text(id, '#picked'), 'Picked Friday, 16 October 2026');
  const r3 = await runSteps(conn, id, ['date 2026-10-05'], { jev: jev.opts });
  assert.match(r3.stopped.reason, /not available/);
  assert.equal(jev.calls.filter(c => c.questions.target).length, 0);
  await ops.closeTab(conn, id);
});

t('a dialog\'s own buttons are allowed, even duplicated or inside a shadow root', async () => {
  const id = await open();
  const jev = fakeJev();
  const r = await runSteps(conn, id, ['click "Show alerts"', 'click OK', 'click OK'], { jev: jev.opts });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal((await text(id, '#oks')).trim().split(' ').length, 2);
  const r2 = await runSteps(conn, id, ['click "Open shadow modal"', 'click "Got it"'], { jev: jev.opts });
  console.log(formatSteps(r2));
  assert.equal(r2.done, true, JSON.stringify(r2.stopped));
  assert.equal(await text(id, '#shadowDone'), 'type confirmed');
  await ops.closeTab(conn, id);
});

t('a stop under a popup iframe says the page is covered', async () => {
  const id = (await ops.newTab(conn, fixture.url + 'fixtures/steps-covered.html')).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  const r = await runSteps(conn, id, ['fill "the recipient email box" = a@b.co'], { jev: fakeJev().opts });
  console.log(formatSteps(r));
  assert.match(r.stopped.covered, /controls are covered by an iframe, likely a sign-up or chat popup/);
  assert.match(formatSteps(r), /^Covered: /m);
  await ops.closeTab(conn, id);
});

t('an error after a step stops the plan; a named stepper and its row', async () => {
  const id = await open();
  const jev = fakeJev();
  const r = await runSteps(conn, id, ['click Continue', 'click "Increase Children"'], { jev: jev.opts });
  console.log(formatSteps(r));
  assert.equal(r.stopped.step, 1);
  assert.match(r.stopped.reason, /error after this step: title "Error - How much money do you have"; "There is a problem: Select how much money you have"/);
  const r2 = await runSteps(conn, id, ['click "Increase Children"', 'click "Increase Children"', 'click "Decrease Children"'], { jev: jev.opts });
  assert.equal(r2.done, true, JSON.stringify(r2.stopped));
  assert.ok(r2.steps.every(s => s.how === 'exact'));
  assert.equal(await text(id, '#kids'), '1');
  await ops.closeTab(conn, id);
});

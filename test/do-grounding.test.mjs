// How do picks a control for a step: exact names without Jev, refs, item ids and selectors, same-named
// and redrawn controls, wrong picks that must stop, and how steps parse.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { targetQuestion } from '../lib/jev.mjs';
import { itemsExpression } from '../lib/items.mjs';
import { parseStep, runSteps, formatSteps, missingFromPick, looksLikeSelector } from '../lib/steps.mjs';
import { fakeJev, planJev } from './fake-jev.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-memo-'));
process.env.CDP_AGENT_ID = 'test-do-grounding';
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const page = { url: 'https://x.io/s', title: 't', scroll: { y: 0, h: 1, vh: 1 }, groups: [
  { id: 'g1', region: 'nav', chrome: true, count: 3, items: [{ id: 'i1', text: 'Home', link: '/' }] },
  { id: 'g2', region: 'main', count: 4, items: [
    { id: 'i2', text: 'Spotlight · Chair A · S$10', link: '/p/a' },
    { id: 'i3', text: 'Chair B · S$20', link: '/p/b' },
    { id: 'i4', text: 'Chair C · S$30', link: '/p/c', hints: ['card-sponsored'] },
    { id: 'i5', text: 'Chair D · S$40', link: '/p/d' },
  ] },
  { id: 'g3', region: 'aside', count: 3, items: [{ id: 'i6', text: 'Related one' }, { id: 'i7', text: 'Related two' }, { id: 'i8', text: 'Related three' }] },
] };

test('steps parse into action, target and value', () => {
  assert.deepEqual(parseStep('fill "the search box" = "herman miller aeron"'), { action: 'fill', target: 'the search box', value: 'herman miller aeron' });
  assert.deepEqual(parseStep('click More filters'), { action: 'click', target: 'More filters' });
  assert.deepEqual(parseStep('select Sort = Price - Low to High'), { action: 'select', target: 'Sort', value: 'Price - Low to High' });
  assert.deepEqual(parseStep('key Enter'), { action: 'key', target: 'Enter' });
  assert.deepEqual(parseStep('click! "Buy now"'), { action: 'click', target: 'Buy now', commit: true });
  assert.deepEqual(parseStep('fill! Search = x'), { action: 'fill', target: 'Search', value: 'x' }); // only click and select commit
  assert.throws(() => parseStep('buy everything'), /Unknown step/);
  assert.throws(() => parseStep('fill "box"'), /fill <target> = <value>/);
});

t('a search-filter plan runs in one call and waits for late results', async () => {
  const id = await open('steps-form.html');
  const r = await runSteps(conn, id, ['fill Search = aeron', 'key Enter', 'click "More filters"', 'fill Maximum = 600', 'click Apply'], { then: 'text' });
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.ok(r.steps.filter(s => s.target).every(s => s.how === 'exact'));
  assert.match(r.text, /Aeron A · S\$380/);
  assert.match(r.text, /Aeron B · S\$580/);
  assert.doesNotMatch(r.text, /Aeron C|Chair D/);
  await ops.closeTab(conn, id);
});

t('a step that needs Jev stops cleanly when no key is configured', async () => {
  const id = await open('steps-form.html');
  const r = await runSteps(conn, id, ['fill "the box for the product name" = aeron']);
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /TYPESAFE_API_KEY/);
  await ops.closeTab(conn, id);
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

test('a pick must show the numbers and dates the step names', () => {
  assert.deepEqual(missingFromPick('October 17, 2026', { name: 'When Add dates' }), ['17', '2026', 'october']);
  assert.deepEqual(missingFromPick('Under $25,000', { name: 'Payment & Price' }), ['25000']);
  assert.deepEqual(missingFromPick('600', { role: 'button', name: 'minimum square feet' }), ['600']);
  assert.deepEqual(missingFromPick('Under $25,000', { name: 'Under $25,000' }), []);
  assert.deepEqual(missingFromPick('the 2nd result', { name: 'Aeron chair' }), [], 'ordinals are positions');
  assert.deepEqual(missingFromPick('Core i5 laptops', { name: 'Intel Core i5' }), [], 'i5 is a word, not a number');
  assert.deepEqual(missingFromPick('More filters', { name: 'Filters' }), []);
});

t('refs from the last read, item ids, selectors and listbox options act without Jev', async () => {
  const id = await open('steps-friction.html');
  const jev = planJev();
  const snap = await ops.readPage(conn, id, { maxText: 0 });
  const spa = snap.elements.find(e => /Spa/.test(e.name || '') && e.role === 'checkbox');
  assert.ok(spa, 'the read lists Spa');
  const items = await ops.evaluate(conn, id, itemsExpression({}));
  const second = items.groups.flatMap(g => g.items).find(it => /Result two/.test(it.text));
  const r = await runSteps(conn, id, [`click ${spa.ref}`, `click ${second.id}`, 'click "#gym"', 'click "600"'], { jev: jev });
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
  const r2 = await runSteps(conn, id, ['click "600"'], { jev: jev });
  assert.equal(r2.done, true, JSON.stringify(r2.stopped));
  assert.match(r2.steps[0].how, /exact|option/);
  assert.equal(await text(id, '#sqftPicked'), 'Min 600');
  // A ref from a read the page has since replaced is refused, not guessed at.
  await ops.evaluate(conn, id, 'location.reload()');
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  const r3 = await runSteps(conn, id, [`click ${spa.ref}`], { jev: jev });
  assert.match(r3.stopped.reason, /is not on the page any more/);
  await ops.closeTab(conn, id);
});

t('a Jev pick without the step\'s numbers stops; an unsure pick is marked ⚠', async () => {
  const id = await open('steps-friction.html');
  const jev = planJev({ 'October 17, 2026': [/When Add dates/, 0.9], 'Under $25,000': [/Payment/, 0.9], 'the amenities spa box': [/Spa/, 0.65] });
  const r = await runSteps(conn, id, ['click "October 17, 2026"'], { jev: jev });
  console.log(formatSteps(r));
  assert.match(r.stopped.reason, /Jev picked button "When Add dates" \(p=0.9\), which does not show "17", "2026", "october"/);
  assert.match(r.stopped.reason, /date YYYY-MM-DD/);
  const r2 = await runSteps(conn, id, ['click "Under $25,000"'], { jev: jev });
  assert.match(r2.stopped.reason, /does not show "25000"/);
  const r3 = await runSteps(conn, id, ['click "the amenities spa box"'], { jev: jev });
  assert.equal(r3.done, true, JSON.stringify(r3.stopped));
  assert.equal(r3.steps[0].unsure, true);
  assert.match(formatSteps(r3), /^⚠ 1\. click "the amenities spa box".*unsure: check the page.*now checked/m);
  await ops.closeTab(conn, id);
});

test('a name made up from a row is offered only when the intent shares its words', () => {
  const snap = { elements: [
    { ref: 'ref_1', role: 'button', name: 'THE BOX COMBO® (unnamed button)', nameFrom: 'context' },
    { ref: 'ref_2', role: 'button', name: 'Add to Order $12.40' },
    { ref: 'ref_3', role: 'button', name: 'Increase Children', derived: true },
  ] };
  const add = targetQuestion(snap, { intent: 'Add to Order', action: 'click' });
  assert.deepEqual(add.cands.map(c => c.ref), ['ref_2'], 'the made-up name shares no word with the intent');
  const kids = targetQuestion(snap, { intent: 'add a child', action: 'click' });
  assert.ok(!kids.cands.some(c => c.ref === 'ref_1'));
  const combo = targetQuestion(snap, { intent: 'the box combo', action: 'click' });
  assert.ok(combo.cands.some(c => c.ref === 'ref_1'));
  assert.equal(combo.question.criteria.ref_1.name_from_row, true, 'Jev is told the name is made up');
});

test('same-named candidates carry their position and context', () => {
  const snap = { elements: [
    { ref: 'ref_1', role: 'button', name: 'Edit', near: 'Start time' },
    { ref: 'ref_2', role: 'button', name: 'Edit', near: 'End time' },
    { ref: 'ref_3', role: 'button', name: 'Save' },
  ] };
  const q = targetQuestion(snap, { intent: 'the end time edit button', action: 'click' }).question;
  assert.equal(q.criteria.ref_1.same_name, '1 of 2');
  assert.equal(q.criteria.ref_2.same_name, '2 of 2');
  assert.equal(q.criteria.ref_2.near, 'End time');
  assert.equal(q.criteria.ref_3.same_name, undefined);
});

t('same-named controls: Jev sees their rows; a tie stops with each ref to pick by', async () => {
  const id = await open('steps-friction2.html');
  const jev = planJev({ 'the end time Edit': [/End time/, 0.9], 'Edit the time': [/Edit/, 0.5] }, { near: true });
  const r = await runSteps(conn, id, ['click "the end time Edit"'], { jev: jev });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await text(id, '#edited'), 'edit end');
  const r2 = await runSteps(conn, id, ['click "Edit the time"'], { jev: jev });
  console.log(formatSteps(r2));
  assert.ok(r2.stopped, 'a coin flip between two Edit buttons stops');
  assert.match(r2.stopped.reason, /same name/);
  assert.match(r2.stopped.reason, /click ref_\d+ \(near "Start time"\)/);
  assert.match(r2.stopped.reason, /click ref_\d+ \(near "End time"\)/);
  await ops.closeTab(conn, id);
});

t('a control redrawn between the read and the click is found again once', async () => {
  const id = await open('steps-friction4.html?redraw=1');
  const r = await runSteps(conn, id, ['click "Increase Pets"'], { jev: planJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await text(id, '#pets'), '1');
  await ops.closeTab(conn, id);
});

t('clicking a control that is already in view does not scroll the page', async () => {
  const id = await open('steps-friction4.html?tall=1');
  const r = await runSteps(conn, id, ['click "Increase Pets"'], { jev: planJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await text(id, '#state'), 'pets 0');
  const snap = await ops.readPage(conn, id, { maxText: 0, max: 1500, all: true });
  await ops.click(conn, id, { ref: snap.elements.find(e => e.name === 'Increase Pets').ref, token: snap.token });
  assert.equal(await ops.evaluate(conn, id, 'scrollY'), 0);
  await ops.closeTab(conn, id);
});

t('an icon-only button is named by its icon title', async () => {
  const id = await open('steps-friction4.html');
  const snap = await ops.readPage(conn, id, { maxText: 0, max: 1500, all: true });
  assert.ok(snap.elements.some(e => e.role === 'button' && e.name === 'Search'), JSON.stringify(snap.elements.slice(0, 3)));
  const r = await runSteps(conn, id, ['click "Search"'], { jev: planJev(), noNotes: true });
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await text(id, '#searched'), 'searched');
  await ops.closeTab(conn, id);
});

t('click "Search" takes the button, not the box whose placeholder says Search', async () => {
  const id = await open('steps-friction5.html');
  const r = await runSteps(conn, id, ['fill "Search" = "chef"', 'click "Search"'], { jev: noJev, noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(r.steps[1].target, /^button/);
  assert.equal(await state(id), 'searched chef');
  await ops.closeTab(conn, id);
});

t('a ref in a do step means what the caller last read, after another plan read the page again', async () => {
  const id = await open('steps-friction5.html');
  const mine = await ops.readPage(conn, id, { all: true });
  const gym = mine.elements.find(e => e.name === 'Gym');
  // The page grows controls above it, and a later plan's read renumbers every ref.
  await ops.evaluate(conn, id, `document.body.insertAdjacentHTML('afterbegin', '<button>One</button><button>Two</button><button>Three</button>')`);
  const later = await ops.readPage(conn, id, { all: true });
  assert.notEqual(later.elements.find(e => e.ref === gym.ref)?.name, 'Gym', 'the ref now names something else in the latest snapshot');
  const r = await runSteps(conn, id, [`click ${gym.ref}`], { jev: noJev, noNotes: true, refToken: mine.token });
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(r.steps[0].target, /checkbox "Gym"/);
  await ops.closeTab(conn, id);
});

t('a sort radio drawn twice is judged by the copy on screen after the page redraws', async () => {
  const id = await open('slice-r2.html?dupsort=1');
  const r = await runSteps(conn, id, ['click "Price - Low to High"'], { jev: planJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.ok(r.steps[0].checked === true || /in its address/.test(r.steps[0].how), JSON.stringify(r.steps[0]));
  assert.match(await state(id), /sorted Price - Low to High/);
  await ops.closeTab(conn, id);
});

t('a ref whose element the page redrew is found again by role and name', async () => {
  const id = await open('slice-r2.html?redraw=1');
  let snap = await ops.readPage(conn, id, { maxText: 0, max: 1500, all: true });
  let ref = snap.elements.find(e => e.name === 'Max Price').ref;
  await ops.evaluate(conn, id, 'redrawSoon()');
  await sleep(500);
  const r = await runSteps(conn, id, [`fill ${ref} = "40"`], { jev: planJev(), noNotes: true });
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

t('do steps take custom-element selectors; plain words stay words', () => {
  assert.equal(looksLikeSelector('x-acc:nth-of-type(1) h2'), true);
  assert.equal(looksLikeSelector('p-select-wrapper'), true);
  assert.equal(looksLikeSelector('div > a'), true);
  assert.equal(looksLikeSelector('Submit'), false);
  assert.equal(looksLikeSelector('Free parking'), false);
});

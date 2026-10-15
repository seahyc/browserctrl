// Friction found in Online-Mind2Web round 2: a date step that ran before the picker had
// opened, day cells named only by their text, Ionic controls whose checked state was read
// too early (or was already right), an "Order Now" entry button refused as a commit, row
// names made up for unnamed buttons outranking real ones, and same-named controls Jev
// could not tell apart. Jev is a deterministic fake: no request leaves the machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { targetQuestion } from '../lib/jev.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
process.env.BROWSERCTRL_TRACES = TRACES;
process.env.BROWSERCTRL_NOTES = 'off';

// targets: intent -> [pattern for the picked name or near context, probability].
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
        const key = (re && Object.keys(q.criteria).find(k => k !== 'none' && re.test(`${q.criteria[k].name || ''} ${q.criteria[k].near || ''}`))) || 'none';
        const keys = Object.keys(q.criteria);
        answers[id] = { type: 'choice', choice: key, probabilities: Object.fromEntries(keys.map(k => [k, k === key ? p : (1 - p) / (keys.length - 1)])), confidence: p };
      }
    }
    return { ok: true, status: 200, json: async () => ({ answers, model: 'fake' }) };
  };
  return { calls, opts: { cfg: { key: 'fake', model: 'fake' }, fetchImpl } };
}

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
  const id = (await ops.newTab(conn, fixture.url + 'fixtures/steps-friction2.html')).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  return id;
};
const text = (id, sel) => ops.evaluate(conn, id, `document.querySelector(${JSON.stringify(sel)}).textContent`);

t('a date step waits for the picker to open and reads day cells by their text', async () => {
  const id = await open();
  const jev = fakeJev();
  const r = await runSteps(conn, id, ['click "Pick dates"', 'date 2026-11-16'], { jev: jev.opts });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(r.steps[1].how, /date, paged 1 month/);
  assert.equal(await text(id, '#picked'), 'Picked November 16, 2026');
  await ops.closeTab(conn, id);
});

t('an Ionic box already chosen, or a radio that updates late, is not a failed click', async () => {
  const id = await open();
  const jev = fakeJev();
  const r = await runSteps(conn, id, ['click "Milk, 110 Cal"', 'click PICKUP'], { jev: jev.opts });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(r.steps[0].checked, true);
  assert.equal(r.steps[1].checked, true);
  assert.equal(await ops.evaluate(conn, id, 'document.getElementById("pickup").getAttribute("aria-checked")'), 'true');
  await ops.closeTab(conn, id);
});

t('an "Order Now" entry button runs until the page holds a bag total; a ref click is deliberate', async () => {
  const id = await open();
  const jev = fakeJev();
  const r = await runSteps(conn, id, ['click "Order Now"'], { jev: jev.opts });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await text(id, '#started'), 'order started');
  // With a bag total and a card field on the page, the same words commit.
  await ops.evaluate(conn, id, 'document.getElementById("cart").hidden = false; document.getElementById("started").textContent = ""');
  const r2 = await runSteps(conn, id, ['click "Order Now"'], { jev: jev.opts });
  assert.match(r2.stopped?.reason || '', /can commit something/);
  assert.equal(await text(id, '#started'), '');
  // Clicked by ref from the caller's read, it is deliberate.
  const snap = await ops.readPage(conn, id, { maxText: 0 });
  const btn = snap.elements.find(e => e.name === 'Order Now');
  const r3 = await runSteps(conn, id, [`click ${btn.ref}`], { jev: jev.opts });
  assert.equal(r3.done, true, JSON.stringify(r3.stopped));
  assert.equal(await text(id, '#started'), 'order started');
  // Place order stays guarded, even by name next to the total.
  const r4 = await runSteps(conn, id, ['click "Place order"'], { jev: jev.opts });
  assert.match(r4.stopped.reason, /can commit something/);
  assert.equal(await text(id, '#placed'), '');
  await ops.closeTab(conn, id);
});

t('same-named controls: Jev sees their rows; a tie stops with each ref to pick by', async () => {
  const id = await open();
  const jev = fakeJev({ 'the end time Edit': [/End time/, 0.9], 'Edit the time': [/Edit/, 0.5] });
  const r = await runSteps(conn, id, ['click "the end time Edit"'], { jev: jev.opts });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await text(id, '#edited'), 'edit end');
  const r2 = await runSteps(conn, id, ['click "Edit the time"'], { jev: jev.opts });
  console.log(formatSteps(r2));
  assert.ok(r2.stopped, 'a coin flip between two Edit buttons stops');
  assert.match(r2.stopped.reason, /same name/);
  assert.match(r2.stopped.reason, /click ref_\d+ \(near "Start time"\)/);
  assert.match(r2.stopped.reason, /click ref_\d+ \(near "End time"\)/);
  await ops.closeTab(conn, id);
});

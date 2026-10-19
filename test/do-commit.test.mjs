// The commit guard: which clicks can commit something and stop the plan, which entry buttons,
// typing and links do not, and how a marked step goes through.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import * as jev from '../lib/jev.mjs';
import { commits } from '../lib/jev.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { fakeJev, planJev } from './fake-jev.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-memo-'));
process.env.CDP_AGENT_ID = 'test-do-commit';
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
const run = async (id, steps) => { const r = await runSteps(conn, id, steps, { jev: fakeJev(), noNotes: true }); console.log(formatSteps(r)); return r; };

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

t('typing, links and a search Submit are not commits; Place order still is', async () => {
  const id = await open('steps-friction.html');
  const jev = planJev();
  const r = await runSteps(conn, id, ['fill "SEND-TO EMAIL" = gift@example.com', 'fill "Search for parking" = SFMOMA', 'click Submit', 'click "Order Now"'], { jev: jev });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await text(id, '#searched'), 'Searched: SFMOMA');
  assert.equal(r.steps[3].how, 'exact, first of 2', 'two links share the name: the first on screen');
  assert.match(await ops.evaluate(conn, id, 'location.hash'), /#order/);
  const r2 = await runSteps(conn, id, ['click "Place order"'], { jev: jev });
  assert.match(r2.stopped.reason, /can commit something/);
  assert.equal(await text(id, '#placed'), '');
  await ops.closeTab(conn, id);
});

t('an "Order Now" entry button runs until the page holds a bag total; a ref click is deliberate', async () => {
  const id = await open('steps-friction2.html');
  const jev = planJev({}, { near: true });
  const r = await runSteps(conn, id, ['click "Order Now"'], { jev: jev });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await text(id, '#started'), 'order started');
  // With a bag total and a card field on the page, the same words commit.
  await ops.evaluate(conn, id, 'document.getElementById("cart").hidden = false; document.getElementById("started").textContent = ""');
  const r2 = await runSteps(conn, id, ['click "Order Now"'], { jev: jev });
  assert.match(r2.stopped?.reason || '', /can commit something/);
  assert.equal(await text(id, '#started'), '');
  // Clicked by ref from the caller's read, it is deliberate.
  const snap = await ops.readPage(conn, id, { maxText: 0 });
  const btn = snap.elements.find(e => e.name === 'Order Now');
  const r3 = await runSteps(conn, id, [`click ${btn.ref}`], { jev: jev });
  assert.equal(r3.done, true, JSON.stringify(r3.stopped));
  assert.equal(await text(id, '#started'), 'order started');
  // Place order stays guarded, even by name next to the total.
  const r4 = await runSteps(conn, id, ['click "Place order"'], { jev: jev });
  assert.match(r4.stopped.reason, /can commit something/);
  assert.equal(await text(id, '#placed'), '');
  await ops.closeTab(conn, id);
});

t('a made-up row name does not make a plain icon button commit; a submit in a sign-up form still does', async () => {
  const id = await open('slice-r2.html?derived=1');
  const snap = await ops.readPage(conn, id, { maxText: 0, max: 1500, all: true });
  const tour = snap.elements.find(e => /app tour/i.test(e.name || ''));
  const send = snap.elements.find(e => /mailing list/i.test(e.name || ''));
  assert.ok(tour && send, JSON.stringify(snap.elements.map(e => [e.role, e.name])));
  assert.equal(jev.commits(tour.name, tour), false, `tour: ${JSON.stringify(tour)}`);
  assert.equal(jev.commits(send.name, send), true, `send: ${JSON.stringify(send)}`);
  const r = await runSteps(conn, id, [`click "${tour.name}"`], { jev: planJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await state(id), 'tour');
  await ops.closeTab(conn, id);
});

t('a committing control stops the plan even when named exactly', async () => {
  const id = await open('steps-form.html');
  const r = await runSteps(conn, id, ['click "Buy now"']);
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /can commit something/);
  await ops.closeTab(conn, id);
});

t('a step marked ! clicks a committing control named exactly', async () => {
  const id = await open('steps-form.html');
  await ops.evaluate(conn, id, `[...document.querySelectorAll('button')].find(b => b.innerText === 'Buy now').onclick = () => { document.body.dataset.bought = '1'; }`);
  const r = await runSteps(conn, id, ['click! "Buy now"']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(r.steps[0].committed, true);
  assert.equal(await ops.evaluate(conn, id, 'document.body.dataset.bought'), '1');
  const unmarked = await runSteps(conn, id, ['click "Buy now"']);
  assert.match(unmarked.stopped.reason, /mark the step: click! "Buy now"/);
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

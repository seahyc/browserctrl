// Stops every benchmark arm paid for, rebuilt from the sites' own markup (do-stops.html):
// GitHub's issue link inside an inline h3 with overflow:hidden, UPS's closed Service Alert
// flyout parked off screen, a notice dialog that only closes, Carnival's portal filter modal,
// IMDb's hover flyout, and Carnival's Save checkbox that comes first in each trip tile.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { itemsExpression } from '../lib/items.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { exactMatch } from '../lib/do/ground.mjs';
import { fakeJev } from './fake-jev.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-stops-'));
process.env.CDP_AGENT_ID = 'test-do-stops';
process.env.BROWSERCTRL_NOTIFY = '0';
process.env.BROWSERCTRL_TRACE = '0';
process.env.BROWSERCTRL_CAPTURE = '0';
process.env.BROWSERCTRL_NOTES = 'off';
process.env.BROWSERCTRL_READ_TOKENS = path.join(MEMO, 'read-tokens.json');
process.env.BROWSERCTRL_SETTLE_MEMORY = path.join(MEMO, 'never.json');
process.env.BROWSERCTRL_SITE_TROUBLE = path.join(MEMO, 'trouble.json');

const haveBrowser = Boolean(chromeBinary());
let fixture, browser, conn;
before(async () => {
  if (!haveBrowser) return;
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => {
  try { conn?.close(); } catch {}
  await browser?.close();
  await fixture?.close();
  fs.rmSync(MEMO, { recursive: true, force: true });
});
const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
const open = async (query) => {
  const id = (await ops.newTab(conn, fixture.url + 'fixtures/do-stops.html?' + query)).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  return id;
};
const state = (id) => ops.evaluate(conn, id, `document.querySelector('#state').textContent`);
// The page's own state, once it says what the step should have done: under heavy load a click's
// acknowledgement can time out and the event lands a moment after the step returns.
const reaches = async (id, want, ms = 10000) => {
  let v = await state(id);
  for (const t0 = Date.now(); v !== want && Date.now() - t0 < ms;) { await new Promise(r => setTimeout(r, 100)); v = await state(id); }
  return v;
};
// A model that matches nothing and sees nothing wrong: the steps below name exact targets.
const quiet = () => fakeJev({ noul: (q, id) => /expect/.test(id) ? 0.98 : 0.04 });
// A starved browser ends the plan at 45 s instead of the 120 s default, and every failure
// says where the time went.
const run = async (id, steps, jev = quiet()) => {
  const r = await runSteps(conn, id, steps, { jev, noNotes: true, deadlineMs: 45000 });
  console.log(formatSteps(r));
  console.log('phases', JSON.stringify(r.phases), 'step ms', r.steps.map(s => s.ms));
  return r;
};
const why = (r) => JSON.stringify({ stopped: r.stopped, phases: r.phases, ms: r.ms, steps: r.steps.map(s => ({ ms: s.ms, how: s.how })) });

t('GitHub: an issue link inside an inline h3 with overflow:hidden is clicked, by title and by items id', async () => {
  const id = await open('gh=1');
  try {
    const snap = await ops.readPage(conn, id, { maxText: 0 });
    const link = snap.elements.find(e => e.role === 'link' && /Roadmap: improve MCP/.test(e.name));
    assert.ok(link, 'issue link in the snapshot');
    assert.ok(!link.covered, `the link reads as covered: ${link.covered}`);
    const r1 = await run(id, ['click "[Feature] Roadmap: improve MCP usability and performance under bounded resources, a long title that wraps onto a second line in the list"']);
    assert.equal(r1.done, true, why(r1));
    // Matched by its name in the snapshot (cut at 120 characters), with no second page lookup.
    assert.equal(r1.steps[0].how, 'exact');
    assert.equal(await reaches(id, 'opened issue-1065'), 'opened issue-1065');
    const items = await ops.evaluate(conn, id, itemsExpression());
    const row = items.groups.flatMap(g => g.items).find(i => /Prefixed XHTML/.test(i.text));
    assert.ok(row, 'the third issue is an item');
    const r2 = await run(id, [`click ${row.id}`]);
    assert.equal(r2.done, true, why(r2));
    assert.equal(await reaches(id, 'opened issue-1067'), 'opened issue-1067');
  } finally { await ops.closeTab(conn, id); }
});

t('UPS: a closed Service Alert flyout parked off screen is not an open modal, and the tab behind it is clicked', async () => {
  const id = await open('ups=phantom');
  try {
    const snap = await ops.readPage(conn, id, { maxText: 0 });
    assert.ok(!snap.modal, `read as a modal: ${JSON.stringify(snap.modal)}`);
    const tab = snap.elements.find(e => /Medium: Starting/.test(e.name || ''));
    assert.ok(tab && !tab.inert, `the tab reads as inert: ${JSON.stringify(tab)}`);
    const r = await run(id, ['click "Medium: Starting at $18.95"']);
    assert.equal(r.done, true, why(r));
    assert.equal(await reaches(id, 'tab Medium: Starting at $18.95'), 'tab Medium: Starting at $18.95');
  } finally { await ops.closeTab(conn, id); }
});

// The model says the dialog blocks the page, as Jev did on UPS.
const blocking = () => fakeJev({ noul: (q, id, s) => id === 'blocker' && s?.page?.overlay ? 0.93 : /expect/.test(id) ? 0.98 : 0.04 });

t('a notice dialog whose only control closes it is closed and reported, then the step runs', async () => {
  const id = await open('ups=notice');
  try {
    const r = await run(id, ['click "Medium: Starting at $18.95"'], blocking());
    assert.equal(r.done, true, why(r));
    assert.equal(await reaches(id, 'tab Medium: Starting at $18.95'), 'tab Medium: Starting at $18.95');
    const ev = r.events.find(e => e.type === 'dismissed');
    assert.ok(ev, `no dismissed event: ${JSON.stringify(r.events)}`);
    assert.match(ev.category, /notice/);
    assert.match(ev.control, /Close/);
    assert.match(formatSteps(r), /dismissed/);
  } finally { await ops.closeTab(conn, id); }
});

t('the same notice dialog is closed when the click finds it covering the target (no blocker judgment)', async () => {
  const id = await open('ups=notice');
  try {
    const r = await run(id, ['click "Medium: Starting at $18.95"']);
    assert.equal(r.done, true, why(r));
    assert.equal(await reaches(id, 'tab Medium: Starting at $18.95'), 'tab Medium: Starting at $18.95');
    assert.ok(r.events.some(e => e.type === 'dismissed' && /notice/.test(e.category)), JSON.stringify(r.events));
  } finally { await ops.closeTab(conn, id); }
});

for (const [kind, why] of [['decide', 'asks for a choice'], ['form', 'has a field and a Subscribe button']]) t(`a dialog that ${why} is never dismissed: the plan stops`, async () => {
  for (const jev of [blocking(), quiet()]) {
    const id = await open('ups=' + kind);
    try {
      const r = await run(id, ['click "Medium: Starting at $18.95"'], jev);
      assert.equal(r.done, false);
      assert.equal(await state(id), '');
      assert.equal(await ops.evaluate(conn, id, 'window.unsafe === true'), false);
      assert.ok(!r.events.some(e => e.type === 'dismissed'), JSON.stringify(r.events));
    } finally { await ops.closeTab(conn, id); }
  }
});

t('Carnival: a filter whose modal opens in a portal a moment later counts as opened, and is not clicked shut', async () => {
  const id = await open('portal=1');
  try {
    const r = await run(id, ['click "Duration"']);
    assert.equal(r.done, true, why(r));
    assert.equal(r.steps[0].expanded, true);
    assert.equal(await reaches(id, 'duration open'), 'duration open');
    console.log('disclosure check ms', r.phases.disclosure);
    const r2 = await run(id, ['click "8 Days"']);
    assert.equal(r2.done, true, why(r2));
    assert.equal(await reaches(id, 'chose 8 days'), 'chose 8 days');
  } finally { await ops.closeTab(conn, id); }
});

t('GitHub two-factor: a control that names no panel counts as opened when links beside it appear', async () => {
  const id = await open('twofa=1');
  try {
    const r = await run(id, ['click "More options"', 'click "Passkey"']);
    assert.equal(r.done, true, why(r));
    assert.equal(r.steps[0].expanded, true);
    assert.equal(await reaches(id, 'chose webauthn'), 'chose webauthn');
  } finally { await ops.closeTab(conn, id); }
});

t('IMDb: a flyout that opens under the pointer and closes on click is left open, and says so', async () => {
  const id = await open('hoverflyout=1');
  try {
    const r = await run(id, ['click "Toggle language selector"']);
    assert.equal(r.done, true, why(r));
    assert.equal(r.steps[0].expanded, true);
    assert.match(r.steps[0].how, /hover/);
    // The page's own signals: it opened on the pointer, the click shut it, the hover reopened it.
    assert.deepEqual(await ops.evaluate(conn, id, 'window.flyoutLog'), ['open', 'closed', 'open']);
    assert.equal(await reaches(id, 'language open'), 'language open');
    // Detecting and undoing the shut is bounded: a few reads and one hover, no settle waits
    // (about 50–300 ms on a quiet machine; the cap only catches a runaway loop).
    console.log('disclosure check ms', r.phases.disclosure);
    assert.ok(r.phases.disclosure < 10000, `disclosure check took ${r.phases.disclosure} ms`);
  } finally { await ops.closeTab(conn, id); }
});

t('Carnival: click on a trip tile by items id opens its link, not the Save checkbox drawn first', async () => {
  const id = await open('tiles=1');
  try {
    const items = await ops.evaluate(conn, id, itemsExpression());
    const tile = items.groups.flatMap(g => g.items).find(i => /Mexican Riviera/.test(i.text));
    assert.ok(tile, 'the trip is an item');
    const r = await run(id, [`click ${tile.id}`]);
    assert.equal(r.done, true, why(r));
    assert.equal(await reaches(id, 'opened trip-1'), 'opened trip-1');
    assert.match(r.steps[0].target, /link/);
  } finally { await ops.closeTab(conn, id); }
});

t('a plan that asks for the Save checkbox still gets it', async () => {
  const id = await open('tiles=1');
  try {
    const r = await run(id, ['click "Save Itinerary for 14-Day Hawaii"']);
    assert.equal(r.done, true, why(r));
    assert.equal(await reaches(id, 'saved 2'), 'saved 2');
  } finally { await ops.closeTab(conn, id); }
});

test('a step naming a control by its full text matches the name the snapshot cut at 120 characters, only when one fits', () => {
  const full = 'A'.repeat(60) + ' issue title that goes on well past the snapshot limit for names ' + 'B'.repeat(40);
  const link = (ref, name) => ({ ref, role: 'link', name });
  const snap = { elements: [link('ref_1', full.slice(0, 120)), link('ref_2', 'Other issue')] };
  assert.equal(exactMatch(snap, { action: 'click', target: full })?.ref, 'ref_1');
  assert.equal(exactMatch(snap, { action: 'click', target: full.slice(0, 90) }), null);
  const twins = { elements: [link('ref_1', full.slice(0, 120)), link('ref_2', full.slice(0, 121))] };
  assert.equal(exactMatch(twins, { action: 'click', target: full }), null);
});

// Friction found in the Airbnb demo run: a toggle under the filters dialog's sticky footer
// left out of the candidates ("Jev found no element" for Gym), an aria-pressed toggle
// switched off by a second click, a fee notice on top named only as "no element", and a
// guest panel redrawn between the read and the click. Jev is a deterministic fake.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import * as notes from '../lib/notes.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
const NOTES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-notes-'));
process.env.BROWSERCTRL_TRACES = TRACES;
process.env.BROWSERCTRL_NOTES_DIR = NOTES;
process.env.BROWSERCTRL_NOTES = 'on';

// targets: intent -> [pattern for the picked name, probability]. Overlays block unless
// blocks is false (a dialog that holds the target, as Airbnb's filters do).
function fakeJev(targets = {}, { blocks = true } = {}) {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      if (q.type === 'noul') answers[id] = { type: 'noul', noul: id === 'blocker' && blocks && body.state.page?.overlay ? 0.93 : 0.04 };
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
const page = (q = '') => fixture.url + 'fixtures/steps-friction4.html' + q;
const open = async (q) => {
  const id = (await ops.newTab(conn, page(q))).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  return id;
};
const text = (id, sel) => ops.evaluate(conn, id, `document.querySelector(${JSON.stringify(sel)}).textContent`);

t('a toggle under a pinned footer is offered and clicked clear of it', async () => {
  const id = await open('?filters=open');
  const snap = await ops.readPage(conn, id, { maxText: 0, max: 1500, all: true });
  const gym = snap.elements.find(e => e.name === 'Gym');
  assert.ok(gym?.covered, `Gym should sit under the footer: ${JSON.stringify(gym)}`);
  assert.equal(gym.coverPinned, true);
  const r = await runSteps(conn, id, ['click "Gym"'], { jev: fakeJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(r.steps[0].how, 'exact');
  assert.equal(await text(id, '#state'), 'Gym');
  await ops.closeTab(conn, id);
});

t('a toggle clipped by its scrolling list under a static footer is offered and scrolled into view', async () => {
  const id = await open('?filters=list');
  const snap = await ops.readPage(conn, id, { maxText: 0, max: 1500, all: true });
  const gym = snap.elements.find(e => e.name === 'Gym');
  assert.ok(gym?.covered && gym.coverPinned, `Gym should be clipped and reachable: ${JSON.stringify(gym)}`);
  const r = await runSteps(conn, id, ['click "Gym"'], { jev: fakeJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await text(id, '#state'), 'Gym');
  await ops.closeTab(conn, id);
});

t('an aria-pressed toggle reports pressed, and a second click by name leaves it on', async () => {
  const id = await open('?filters=open');
  const r = await runSteps(conn, id, ['click "Washer"'], { jev: fakeJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.steps[0].checked, true);
  assert.match(formatSteps(r), /now pressed/);
  const again = await runSteps(conn, id, ['click "Washer"'], { jev: fakeJev(), noNotes: true });
  console.log(formatSteps(again));
  assert.equal(again.done, true);
  assert.match(formatSteps(again), /already pressed/);
  assert.match(again.steps[0].how, /not clicked/);
  assert.equal(await text(id, '#state'), 'Washer');
  // By ref it is deliberate: the toggle turns off.
  const snap = await ops.readPage(conn, id, { maxText: 0, max: 1500, all: true });
  const ref = snap.elements.find(e => e.name === 'Washer').ref;
  const off = await runSteps(conn, id, [`click ${ref}`], { jev: fakeJev(), noNotes: true });
  console.log(formatSteps(off));
  assert.match(formatSteps(off), /now not pressed/);
  assert.equal(await text(id, '#state'), '');
  await ops.closeTab(conn, id);
});

t('a notice on top is named with the control that closes it', async () => {
  const id = await open('?notice=1');
  const r = await runSteps(conn, id, ['click "Filters"'], { jev: fakeJev({ Filters: [/^Filters$/, 0.9] }, { blocks: false }), noNotes: true });
  const out = formatSteps(r);
  console.log(out);
  assert.equal(r.done, false);
  assert.match(out, /On top: a dialog "Now you’ll see one price/);
  assert.match(out, /close it with click "Got it"/);
  assert.match(out, /Covered: button "Filters" is under div "Now you’ll see one price/);
  await ops.closeTab(conn, id);
});

t('a control redrawn between the read and the click is found again once', async () => {
  const id = await open('?redraw=1');
  const r = await runSteps(conn, id, ['click "Increase Pets"'], { jev: fakeJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await text(id, '#pets'), '1');
  await ops.closeTab(conn, id);
});

t('clicking a control that is already in view does not scroll the page', async () => {
  const id = await open('?tall=1');
  const r = await runSteps(conn, id, ['click "Increase Pets"'], { jev: fakeJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await text(id, '#state'), 'pets 0');
  const snap = await ops.readPage(conn, id, { maxText: 0, max: 1500, all: true });
  await ops.click(conn, id, { ref: snap.elements.find(e => e.name === 'Increase Pets').ref, token: snap.token });
  assert.equal(await ops.evaluate(conn, id, 'scrollY'), 0);
  await ops.closeTab(conn, id);
});

t('an icon-only button is named by its icon title', async () => {
  const id = await open();
  const snap = await ops.readPage(conn, id, { maxText: 0, max: 1500, all: true });
  assert.ok(snap.elements.some(e => e.role === 'button' && e.name === 'Search'), JSON.stringify(snap.elements.slice(0, 3)));
  const r = await runSteps(conn, id, ['click "Search"'], { jev: fakeJev(), noNotes: true });
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await text(id, '#searched'), 'searched');
  await ops.closeTab(conn, id);
});

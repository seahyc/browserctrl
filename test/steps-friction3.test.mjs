// Friction found in Online-Mind2Web round 3: a date step after a click that closed the
// picker the page had opened by itself (Airbnb), a filter box read as unticked while its
// results reloaded (Booking), and a reveal note contradicted because its first step was
// already done (the filters dialog was open), which deleted a note that had worked twice.
// Jev is a deterministic fake: no request leaves the machine.
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
const page = (q = '') => fixture.url + 'fixtures/steps-friction3.html' + q;
const open = async (q) => {
  const id = (await ops.newTab(conn, page(q))).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  return id;
};
const text = (id, sel) => ops.evaluate(conn, id, `document.querySelector(${JSON.stringify(sel)}).textContent`);

t('a date step reopens a date picker the previous click closed', async () => {
  const id = await open();
  // The picker opens on load. Mid-plan, a click on its open control would be skipped (it is
  // already open), so close it as a plan's last step, then ask for a date.
  await runSteps(conn, id, ['click "When Add dates"'], { jev: fakeJev(), noNotes: true });
  const r = await runSteps(conn, id, ['date 2026-10-17'], { jev: fakeJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(r.steps[0].how, /opened "When Add dates"/);
  assert.equal(await text(id, '#picked'), 'Picked October 17, 2026');
  await ops.closeTab(conn, id);
});

t('a filter box drawn unticked while its results reload is read again once they arrive', async () => {
  const id = await open();
  const r = await runSteps(conn, id, ['click "Free Breakfast (42)"'], { jev: fakeJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(r.steps[0].checked, true);
  // A box that really does not tick still stops the plan.
  const r2 = await runSteps(conn, id, ['click "Dead box"'], { jev: fakeJev(), noNotes: true });
  assert.match(r2.stopped?.reason || '', /did not take/);
  await ops.closeTab(conn, id);
});

t('a reveal note whose first step is already done still runs the rest and is confirmed', async () => {
  const n = await notes.add(page(), 'Gym is under Search all filters in the Filters dialog', { force: true, reveal: { target: 'Gym', steps: ['click "Filters"', 'click "Search all filters"'] } });
  assert.equal(n.ok, true, n.reason);
  const id = await open('?filters=open');
  const r = await runSteps(conn, id, ['click Gym'], { jev: fakeJev({ Gym: [/^Gym$/, 0.9] }, { blocks: false }) });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await text(id, '#gymmed'), 'gym on');
  assert.deepEqual(r.notes_applied, [{ id: n.id, ok: true }]);
  assert.equal(notes.show('127.0.0.1').facts.find(f => f.id === n.id).count, 2);
  notes.clear('127.0.0.1');
  await ops.closeTab(conn, id);
});

t('a reveal note whose steps cannot run at all is neither confirmed nor contradicted', async () => {
  const n = await notes.add(page(), 'Gym hides behind a Spa toggle', { force: true, reveal: { target: 'Gym', steps: ['click "Spa toggle"'] } });
  const id = await open();
  const r = await runSteps(conn, id, ['click Gym'], { jev: fakeJev({ Gym: [/^Gym$/, 0.9] }) });
  assert.equal(r.done, false);
  assert.deepEqual(r.notes_applied || [], []);
  assert.equal(notes.show('127.0.0.1').facts.find(f => f.id === n.id).count, 1);
  notes.clear('127.0.0.1');
  await ops.closeTab(conn, id);
});

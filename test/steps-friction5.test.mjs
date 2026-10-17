// Friction from the held-out round 3 runs: a click "Search" that took the search box (its
// placeholder) over its button, a filter section left open by the last plan shut by the
// next plan's click on its heading, an exact target inside a collapsed section, and the
// find and fields commands that replace hand-written eval. Jev is a deterministic fake.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import * as finder from '../lib/find.mjs';
import { runSteps, formatSteps, waitForContent } from '../lib/steps.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
process.env.BROWSERCTRL_TRACES = TRACES;
process.env.BROWSERCTRL_NOTES = 'off';

// Jev answers "none" for every target and no overlay: only browserctrl's own logic acts.
const noJev = {
  cfg: { key: 'fake', model: 'fake' },
  fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      if (q.type === 'noul') answers[id] = { type: 'noul', noul: 0.04 };
      else if (q.type === 'choice') { const keys = Object.keys(q.criteria); answers[id] = { type: 'choice', choice: 'none', probabilities: Object.fromEntries(keys.map(k => [k, k === 'none' ? 0.9 : 0.1 / (keys.length - 1)])), confidence: 0.9 }; }
    }
    return { ok: true, status: 200, json: async () => ({ answers, model: 'fake' }) };
  },
};

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
  const id = (await ops.newTab(conn, fixture.url + 'fixtures/steps-friction5.html')).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  return id;
};
const state = (id) => ops.evaluate(conn, id, `document.getElementById('state').textContent`);

t('click "Search" takes the button, not the box whose placeholder says Search', async () => {
  const id = await open();
  const r = await runSteps(conn, id, ['fill "Search" = "chef"', 'click "Search"'], { jev: noJev, noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(r.steps[1].target, /^button/);
  assert.equal(await state(id), 'searched chef');
  await ops.closeTab(conn, id);
});

t('a section already open is left open when the plan goes on into it', async () => {
  const id = await open();
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
  const id = await open();
  const r = await runSteps(conn, id, ['click "High school diploma or equivalent"'], { jev: noJev, noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(r.steps[0].how, /opened "Education" first/);
  assert.equal(await state(id), 'high school');
  await ops.closeTab(conn, id);
});

t('find names hidden matches and their opener; fields lists what the form holds', async () => {
  const id = await open();
  const f = await ops.evaluate(conn, id, finder.FIND('middle income'));
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].hidden, 'in a hidden section');
  assert.equal(f.rows[0].opens_with.name, 'Salary');
  assert.match(finder.formatFind(f, 'middle income'), /opens with button "Salary"/);
  const fl = await ops.evaluate(conn, id, finder.FIELDS());
  const text = finder.formatFields(fl);
  assert.match(text, /checkbox\s+"Spa \(3\)"\s+= "checked"/);
  assert.match(text, /select\s+"State"\s+= "ID"/);
  assert.match(text, /1 unticked box/);
  await ops.closeTab(conn, id);
});

t('a short page that has finished loading is not waited on as a loading shell', async () => {
  const id = await open();
  const t0 = Date.now();
  await waitForContent(conn, id, { timeoutMs: 10000, minChars: 5000, stable: false });
  assert.ok(Date.now() - t0 < 3000, `waited ${Date.now() - t0} ms`);
  await ops.closeTab(conn, id);
});

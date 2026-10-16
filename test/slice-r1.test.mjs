// What rotation 1 of the held-out sites (Porsche, Petfinder) showed, as general page shapes:
// web components whose control lives in a shadow root, labels in shadow roots, custom selects
// with slotted options, a native select laid over a styled button, sections shown one at a
// time, a getRootNode polyfill, settles held by beacons and animations, and the CLI's
// positional coordinates, page-checked selectors and browser from the environment.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { runSteps, settle, looksLikeSelector } from '../lib/steps.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
const NOTES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-notes-'));
process.env.BROWSERCTRL_TRACES = TRACES;
process.env.BROWSERCTRL_NOTES_DIR = NOTES;
process.env.BROWSERCTRL_NOTES = 'off';

// A Jev that never matches: every step here names its element exactly.
const fakeJev = () => ({
  cfg: { key: 'fake', model: 'fake' },
  fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      answers[id] = q.type === 'noul' ? { type: 'noul', noul: 0.04 } : { type: 'choice', choice: 'none', probabilities: { none: 1 }, confidence: 1 };
    }
    return { ok: true, status: 200, json: async () => ({ answers, model: 'fake' }) };
  },
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
  fs.rmSync(NOTES, { recursive: true, force: true });
});
const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
const open = async (q) => {
  const id = (await ops.newTab(conn, fixture.url + 'fixtures/slice-r1.html' + q)).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  return id;
};
const js = (id, expr) => ops.evaluate(conn, id, expr);
const run = (id, steps) => runSteps(conn, id, steps, { jev: fakeJev(), noNotes: true });
process.env.CDP_AGENT_ID ||= 'slice-r1-test'; // the test's own calls and its CLI calls are one owner
// One agent identity for every CLI call: without one (CI has no session id), each process is
// its own owner and the second command finds the tab claimed by the first.
const cli = (args, env = {}) => promisify(execFile)(process.execPath, [path.join(ROOT, 'bin/browserctrl.mjs'), ...args], { env: { ...process.env, CDP_AGENT_ID: process.env.CDP_AGENT_ID, ...env } });

t('clicking a component\'s slotted heading opens its shadow-root disclosure, and says so', async () => {
  const id = await open('?acc');
  const r = await run(id, ['click "Year"']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await js(id, 'document.getElementById("year").shadowRoot.querySelector("details").open'), true);
  assert.equal(r.steps[0].expanded, true, JSON.stringify(r.steps[0]));
  await ops.closeTab(conn, id);
});

t('a disclosure under a footer that is not sticky is scrolled clear, not clicked through', async () => {
  const id = await open('?acc&footer');
  await js(id, 'document.querySelector(".panel-footer").addEventListener("click", () => { document.getElementById("state").textContent = "footer clicked"; })');
  const r = await run(id, ['click "Year"']);
  assert.notEqual(await js(id, 'document.getElementById("state").textContent'), 'footer clicked');
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await js(id, 'document.getElementById("year").shadowRoot.querySelector("details").open'), true);
  await ops.closeTab(conn, id);
});

t('a combobox in a shadow root is named by its shadow-root label, and select picks the option in its own list', async () => {
  const id = await open('?sel');
  const snap = await ops.readPage(conn, id, { maxText: 0, max: 1500, all: true });
  const names = snap.elements.filter(e => e.role === 'combobox').map(e => e.name);
  assert.deepEqual(names, ['Min. Year', 'Max. Year']);
  const r = await run(id, ['select "Min. Year" = "2019"']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await js(id, 'document.getElementById("state").textContent'), 'Min. Year=2019');
  await ops.closeTab(conn, id);
});

t('select uses a transparent native select laid over a styled button', async () => {
  const id = await open('?overlay');
  const r = await run(id, ['select "Relevance" = "Price - Low to High"']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await js(id, 'document.getElementById("state").textContent'), 'sort=Price - Low to High');
  await ops.closeTab(conn, id);
});

t('a section this plan opened is closed once when the next step\'s target is hidden behind it', async () => {
  const id = await open('?drill');
  const r = await run(id, ['click "Breed"', 'click "Age"']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(r.steps[1].how, /closed .*Breed.* first/, r.steps[1].how);
  assert.equal(await js(id, 'document.querySelector("section[data-s=Age] .h").getAttribute("aria-expanded")'), 'true');
  await ops.closeTab(conn, id);
});

t('a getRootNode polyfill that returns undefined does not break reading the page', async () => {
  const id = await open('?polyfill');
  const snap = await ops.readPage(conn, id, { maxText: 0, max: 1500, all: true });
  assert.ok(snap.elements.some(e => e.name === 'Inside a span'), JSON.stringify(snap.elements.slice(0, 3)));
  await ops.closeTab(conn, id);
});

t('a settle is not held by a keepalive beacon or by a style-only animation', async () => {
  const id = await open('?settle');
  await js(id, 'document.getElementById("go").click()');
  const ms = await settle(conn, id, {});
  assert.ok(ms < 1500, `settled in ${ms} ms (${settle.why})`);
  assert.equal(settle.why, 'quiet');
  await ops.closeTab(conn, id);
});

t('do steps take custom-element selectors; plain words stay words', () => {
  assert.equal(looksLikeSelector('x-acc:nth-of-type(1) h2'), true);
  assert.equal(looksLikeSelector('p-select-wrapper'), true);
  assert.equal(looksLikeSelector('div > a'), true);
  assert.equal(looksLikeSelector('Submit'), false);
  assert.equal(looksLikeSelector('Free parking'), false);
});

t('the CLI takes positional coordinates, any selector the page accepts, and a browser from the environment', async () => {
  const id = await open('?acc');
  const tab = id.slice(0, 8);
  const xy = JSON.parse((await cli(['click', tab, '5', '5', '--port', String(TEST_PORT)])).stdout);
  assert.deepEqual([xy.clicked.x, xy.clicked.y], [5, 5]);
  const sel = await cli(['click', tab, 'x-acc:nth-of-type(1) h2', '--port', String(TEST_PORT)]);
  assert.match(sel.stdout, /"clicked"/);
  const env = await cli(['tabs'], { BROWSERCTRL_PORT: String(TEST_PORT) });
  assert.match(env.stdout, new RegExp(tab));
  await ops.closeTab(conn, id);
});

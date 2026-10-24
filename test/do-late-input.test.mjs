// A click a busy page acknowledges late, or never (past INPUT.ACK), may still be landing when
// the step checks it: the box-ticked and section-opened checks then wait up to INPUT.LATE_WAIT
// instead of their usual 2 s / 1.2 s, and the step says the click was taken late. The fixture
// (do-stops.html?busy=) holds the page's main thread itself, so the lateness does not depend
// on machine load, and applies the click 2.5 s after it, past the usual wait.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { INPUT } from '../lib/timing.mjs';
import { fakeJev } from './fake-jev.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT, loadFactor, scaled } from './helpers.mjs';

// The click-acknowledgement thresholds stretch with machine load (test/load.mjs); hold them
// still for this file, so the page's busy and late times below and the messages they produce
// stay in step with them. At low load these are the written 1.5 s, 2.5 s, 6 s and 5 s.
process.env.BROWSERCTRL_TEST_LOAD_FACTOR = String(loadFactor());
const BUSY = INPUT.SLOW_ACK + 500, LATE = scaled(2500);
const secs = (ms) => String(ms / 1000).replace('.', '\\.');

const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-late-'));
process.env.CDP_AGENT_ID = 'test-do-late-input';
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
const state = (id) => ops.evaluate(conn, id, `document.querySelector('#state').textContent`);
const why = (r) => JSON.stringify({ stopped: r.stopped, phases: r.phases, steps: r.steps.map(s => ({ ms: s.ms, how: s.how, late_input: s.late_input })) });
async function run(query, step) {
  const id = (await ops.newTab(conn, fixture.url + 'fixtures/do-stops.html?' + query)).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  const r = await runSteps(conn, id, [step], { jev: fakeJev(), noNotes: true, deadlineMs: scaled(45000) });
  console.log(formatSteps(r));
  console.log('phases', JSON.stringify(r.phases), 'late_input', JSON.stringify(r.steps[0]?.late_input));
  return { id, r };
}

t('a checkbox click acknowledged late (main thread held 1.5 s) is waited for, and the step says so', async () => {
  const { id, r } = await run(`busy=${BUSY}&late=${LATE}&on=down`, 'click "Include breakfast"');
  try {
    assert.equal(r.done, true, why(r));
    assert.ok(r.steps[0].late_input?.ms >= INPUT.SLOW_ACK, why(r));
    assert.ok(!r.steps[0].late_input.unacknowledged, why(r));
    assert.match(r.steps[0].how, /the page acknowledged the click late \(\d+\.\d s\)/);
    assert.equal(r.steps[0].checked, true);
    // Checked when the step said so: no waiting in the test.
    assert.equal(await state(id), 'breakfast on');
  } finally { await ops.closeTab(conn, id); }
});

t('a checkbox click never acknowledged (main thread held past INPUT.ACK) is waited for, and the step says so', async () => {
  const { id, r } = await run(`busy=${INPUT.ACK + 1000}&late=${LATE}&on=enter`, 'click "Include breakfast"');
  try {
    assert.equal(r.done, true, why(r));
    assert.equal(r.steps[0].late_input?.unacknowledged, true, why(r));
    assert.match(r.steps[0].how, new RegExp(`the page did not acknowledge the click within ${secs(INPUT.ACK)} s`));
    assert.equal(r.steps[0].checked, true);
    assert.equal(await state(id), 'breakfast on');
  } finally { await ops.closeTab(conn, id); }
});

t('a section whose click was acknowledged late opens 2.5 s later and counts as opened', async () => {
  const { id, r } = await run(`busy=${BUSY}&late=${LATE}&on=down`, 'click "More options"');
  try {
    assert.equal(r.done, true, why(r));
    assert.equal(r.steps[0].expanded, true, why(r));
    assert.match(r.steps[0].how, /acknowledged the click late/);
    assert.equal(await state(id), 'more open');
  } finally { await ops.closeTab(conn, id); }
});

t('a late click that never takes still stops, saying how long it waited', async () => {
  const { id, r } = await run(`busy=${BUSY}&on=down&never=1`, 'click "Include breakfast"');
  try {
    assert.equal(r.done, false);
    assert.match(r.stopped.reason, new RegExp(`still unchecked after waiting ${secs(INPUT.LATE_WAIT)} s for a click the page took late; the click did not take`));
    assert.equal(await state(id), '');
  } finally { await ops.closeTab(conn, id); }
});

t('a section a late click never opens still stops, saying how long it waited', async () => {
  const { id, r } = await run(`busy=${BUSY}&on=down&never=1`, 'click "More options"');
  try {
    assert.equal(r.done, false);
    assert.match(r.stopped.reason, new RegExp(`did not open: .* after waiting ${secs(INPUT.LATE_WAIT)} s for a click the page took late`));
  } finally { await ops.closeTab(conn, id); }
});

t('a prompt click that never takes stops after the usual wait, with no late note', async () => {
  const { id, r } = await run('busy=0&never=1', 'click "Include breakfast"');
  try {
    assert.equal(r.done, false);
    assert.match(r.stopped.reason, /still unchecked/);
    // On a loaded machine even this click can be acknowledged late; the note then is right.
    if (!r.steps[0].late_input) assert.doesNotMatch(r.stopped.reason, /after waiting/);
  } finally { await ops.closeTab(conn, id); }
});

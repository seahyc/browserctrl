// Shared rig for test/do-late-input-*.test.mjs (split in two so neither holds a parallel run
// for minutes). A click a busy page acknowledges late, or never (past INPUT.ACK), may still be landing when
// the step checks it: the box-ticked and section-opened checks then wait up to INPUT.LATE_WAIT
// instead of their usual 2 s / 1.2 s, and the step says the click was taken late. The fixture
// (do-stops.html?busy=) holds the page's main thread itself, so the lateness does not depend
// on machine load, and applies the click 2.5 s after it, past the usual wait.
import { test, before, after } from 'node:test';
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
export const BUSY = INPUT.SLOW_ACK + 500, LATE = scaled(2500);
export const secs = (ms) => String(ms / 1000).replace('.', '\\.');

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
export const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
export const state = (id) => ops.evaluate(conn, id, `document.querySelector('#state').textContent`);
export const why = (r) => JSON.stringify({ stopped: r.stopped, phases: r.phases, steps: r.steps.map(s => ({ ms: s.ms, how: s.how, late_input: s.late_input })) });
export async function run(query, step) {
  const id = (await ops.newTab(conn, fixture.url + 'fixtures/do-stops.html?' + query)).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  const r = await runSteps(conn, id, [step], { jev: fakeJev(), noNotes: true, deadlineMs: scaled(45000) });
  console.log(formatSteps(r));
  console.log('phases', JSON.stringify(r.phases), 'late_input', JSON.stringify(r.steps[0]?.late_input));
  return { id, r };
}
export { INPUT, ops, conn };


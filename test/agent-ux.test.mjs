import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { runSteps, formatSteps, parseStep } from '../lib/steps.mjs';
import { startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const haveBrowser = Boolean(chromeBinary());
let browser, conn;
before(async () => {
  delete process.env.TYPESAFE_API_KEY;
  process.env.BROWSERCTRL_JEV_ENV = path.join(process.env.BROWSERCTRL_HOME, 'missing-jev.env');
  process.env.BROWSERCTRL_NOTES = 'off';
  if (!haveBrowser) return;
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => { conn?.close(); await browser?.close(); });
const t = (name, fn) => test(name, { skip: !haveBrowser }, fn);
async function open(html) {
  const id = (await ops.newTab(conn, 'data:text/html,' + encodeURIComponent(html))).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  return id;
}
const opts = { noNotes: true, traceRun: false, handoff: false };

test('check parses as an idempotent toggle click', () => {
  assert.deepEqual(parseStep('check Device'), { action: 'click', target: 'Device', check: true });
});

test('the outcome is the last line, after optional returned text and the page footer', () => {
  const base = { steps: [], page: { title: 'Fixture', url: 'https://fixture.test/' }, ms: 10, jev_calls: 0, planned_leaves: 3, executed_leaves: 3, text: 'returned text' };
  const done = formatSteps({ ...base, done: true });
  assert.match(done, /returned text[\s\S]*https:\/\/fixture.test\/[^\n]*\n✓ done: 3\/3 steps$/);
  const stopped = formatSteps({ ...base, stopped: { step: 2, reason: 'missing\n' + 'x'.repeat(300) } });
  assert.match(stopped, /Stopped at step 2:/);
  assert.match(stopped.split('\n').at(-1), /^✗ stopped at step 2\/3: missing x{192}$/);
  console.log(done);
  console.log(stopped);
});

t('no key: action expectations continue, including the final expectation', async () => {
  const id = await open(`<button onclick="this.textContent='First done'">First</button><button onclick="this.textContent='Second done'">Second</button>`);
  const warnings = [];
  const r = await runSteps(conn, id, ['click First => "First done"', 'click Second => "Second done"'], { ...opts, onWarning: async w => {
    warnings.push(w);
    assert.equal(warnings.length, 1);
    assert.equal(await ops.evaluate(conn, id, 'document.querySelector("button").textContent'), 'First');
  } });
  assert.equal(r.done, true);
  assert.equal(r.unsure, true);
  assert.equal(r.jev_calls, 0);
  assert.equal(warnings.length, 1);
  assert.equal(r.steps.length, 2);
  for (const row of r.steps) {
    assert.equal(row.unsure, true);
    assert.equal(row.unchecked, 'acted; expectation not checked (no TypeSafe key)');
    assert.equal(row.stopped, undefined);
  }
  assert.match(await ops.evaluate(conn, id, 'document.body.innerText'), /First done.*Second done/s);
  assert.match(formatSteps(r), /✓ done: 2\/2 steps \(unsure\)$/);
  console.log(formatSteps(r));
});

t('no key: a target needing Jev stops before input', async () => {
  const id = await open(`<button onclick="document.body.dataset.clicked='yes'">First</button>`);
  const r = await runSteps(conn, id, ['click "the first action button"'], opts);
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /TypeSafe API key/);
  assert.equal(await ops.evaluate(conn, id, 'document.body.dataset.clicked || "no"'), 'no');
  assert.equal(r.warnings.length, 1);
  console.log(formatSteps(r));
});

t('Escape reports a dirty dialog that disappeared', async () => {
  const id = await open(`<dialog open aria-label="Edit device"><label>Device<input value="original"></label></dialog><script>document.addEventListener('keydown', e => {if(e.key==='Escape')document.querySelector('dialog').close()})</script>`);
  const r = await runSteps(conn, id, ['fill Device = changed', 'key Escape'], opts);
  assert.equal(r.done, true);
  assert.match(formatSteps(r), /Escape closed the dialog "Edit device"; staged edits were lost/);
});

t('Escape does not report lost edits for a clean or still-open dialog', async () => {
  for (const close of [true, false]) {
    const id = await open(`<dialog open aria-label="Edit device"><label>Device<input value="original"></label></dialog><script>document.addEventListener('keydown', e => {if(e.key==='Escape' && ${close})document.querySelector('dialog').close()})</script>`);
    const r = await runSteps(conn, id, close ? ['key Escape'] : ['fill Device = changed', 'key Escape'], opts);
    assert.equal(r.done, true);
    assert.doesNotMatch(formatSteps(r), /Escape closed/);
  }
});

t('check leaves an already checked input on and rejects ordinary buttons', async () => {
  const id = await open('<label>Device<input type="checkbox" checked onclick="document.body.dataset.clicked=\'yes\'"></label><button>Continue</button>');
  const r = await runSteps(conn, id, ['check Device', 'check Device'], opts);
  assert.equal(r.done, true);
  assert.equal(await ops.evaluate(conn, id, 'document.body.dataset.clicked || "no"'), 'no');
  const bad = await runSteps(conn, id, ['check Continue'], opts);
  assert.equal(bad.done, false);
  assert.match(bad.stopped.reason, /check needs a checkbox/);
});

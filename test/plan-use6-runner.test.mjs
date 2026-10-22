import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { fakeJev } from './fake-jev.mjs';

process.env.BROWSERCTRL_CAPTURE = '0';
process.env.BROWSERCTRL_TRACE = '0';
let fixture, browser, conn;
before(async () => {
  if (!chromeBinary()) return;
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => {
  try { await conn?.stop(); }
  finally { conn?.close(); await browser?.close(); await fixture?.close(); }
});
const t = (name, fn) => test(name, { skip: !chromeBinary() }, fn);
async function run(query, lines, jev = fakeJev({ noul: () => .01 })) {
  const tab = (await ops.newTab(conn, fixture.url + 'fixtures/plan-use6-runner.html' + query)).targetId;
  await ops.waitForReady(conn, tab);
  try {
    const report = await runSteps(conn, tab, lines, { jev, noNotes: true });
    console.log(formatSteps(report));
    return report;
  } finally { await ops.closeTab(conn, tab); }
}

t('navigation leaves a blocked page and checks the destination', async () => {
  const report = await run('?blocked', ['nav ' + fixture.url + 'fixtures/plan-use6-runner.html', 'click "Next Available"']);
  assert.equal(report.done, true, JSON.stringify(report.stopped));
  const denied = await run('?blocked', ['nav ' + fixture.url + 'fixtures/plan-use6-runner.html?blocked']);
  assert.equal(denied.done, false);
  assert.equal(denied.stopped.step, 1);
});
t('a plan acting on the blocked page still stops before input', async () => {
  const report = await run('?blocked', ['click "Next Available"']);
  assert.equal(report.done, false);
  assert.equal(report.stopped.step, 0);
});
t('first optional click waits for late shadow consent', async () => {
  const report = await run('?consent', ['optional click "Accept all cookies"']);
  assert.equal(report.executed_leaves, 1);
  assert.ok(!report.steps[0].skipped);
});
t('an absent optional-only plan says nothing ran', async () => {
  const report = await run('', ['optional click "Absent control"']);
  assert.match(formatSteps(report), /done: 0\/1 steps \(nothing ran\)/);
});
t('controls revealed in place reserve extraction slots', async () => {
  const jev = fakeJev({
    choice: (question, id) => {
      if (id !== 'extract') return 'none';
      const key = Object.keys(question.criteria).find(k => String(question.criteria[k]).includes('2 Mar 2027 - Site E101 is available'));
      assert.ok(key);
      return key;
    },
    noul: (_question, id) => id === 'extract_verify' ? .98 : .01,
  });
  const report = await run('', ['click "Next Available"', 'extract "the first available date"'], jev);
  assert.equal(report.extracted[0].value, '2 Mar 2027 - Site E101 is available');
});
t('optional click after navigation waits on the new page', async () => {
  const report = await run('', ['nav ' + fixture.url + 'fixtures/plan-use6-runner.html?consent', 'optional click "Accept all cookies"']);
  assert.equal(report.executed_leaves, 2);
  assert.ok(!report.steps[1].skipped);
});

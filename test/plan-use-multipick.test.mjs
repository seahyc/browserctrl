import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { fakeJev } from './fake-jev.mjs';

let fixture, browser, conn;
const haveBrowser = Boolean(chromeBinary());
before(async () => {
  if (!haveBrowser) return;
  process.env.BROWSERCTRL_NOTES = 'off';
  process.env.BROWSERCTRL_NOTIFY = '0';
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => {
  try { conn?.close(); } catch {}
  await browser?.close();
  await fixture?.close();
});

test('one plan re-grounds picks after chips reorder and counts update, then applies', { skip: !haveBrowser }, async () => {
  const tab = (await ops.newTab(conn, fixture.url + 'fixtures/plan-use-multipick.html')).targetId;
  try {
    await ops.waitForReady(conn, tab, { waitUntil: 'load' });
    const report = await runSteps(conn, tab, ['click "Filters"', 'click "Amber"', 'click "Blue"', 'click "Coral"', 'click "Apply"'], { jev: fakeJev(), noNotes: true });
    console.log(formatSteps(report));
    assert.equal(report.done, true, JSON.stringify(report.stopped));
    assert.equal(report.steps.length, 5);
    assert.equal(await ops.evaluate(conn, tab, 'document.querySelector("#state").textContent'), 'Amber, Blue, Coral');
    assert.equal(await ops.evaluate(conn, tab, 'generation'), 3);
    assert.equal(await ops.evaluate(conn, tab, 'document.querySelector("#filters").hidden'), true);
  } finally { await ops.closeTab(conn, tab); }
});

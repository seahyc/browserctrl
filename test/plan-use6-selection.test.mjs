import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';
process.env.BROWSERCTRL_NOTES = 'off';
process.env.BROWSERCTRL_NOTIFY = '0';
let fixture, browser, conn;
const haveBrowser = Boolean(chromeBinary());
before(async () => {
  if (!haveBrowser) return;
  fixture = await startFixtureServer(); browser = await startHeadlessBrowser(TEST_PORT); conn = await connect(TEST_PORT);
});
after(async () => { conn?.close(); await browser?.close(); await fixture?.close(); });
for (const mode of ['textbox', 'combobox', 'renamed-city', 'words', 'unrelated', 'wrong-number', 'partial-number', 'wrong-owner', 'wrong-words']) {
  test(`option selection checks its owning value: ${mode}`, { skip: !haveBrowser }, async () => {
    const id = (await ops.newTab(conn, `${fixture.url}fixtures/plan-use6-selection.html?mode=${mode}`)).targetId;
    try {
      await ops.waitForReady(conn, id, { waitUntil: 'load' });
      const r = await runSteps(conn, id, ['click "#address"', 'click! "#submit"'], { noNotes: true, jev: { choice: () => { throw Error('unexpected model call'); } } });
      const valid = ['textbox', 'combobox', 'renamed-city', 'words'].includes(mode);
      assert.equal(r.done, valid, formatSteps(r));
      assert.equal(await ops.evaluate(conn,id,'window.submits'), valid ? 1 : 0);
      if (valid) assert.ok(!r.steps[0].unsure, formatSteps(r));
      else assert.match(r.stopped.reason, /selection|selected|did not take/i);
    } finally { await ops.closeTab(conn,id); }
  });
}

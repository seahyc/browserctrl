// Overlays and covered controls: dialogs, popups and notices that block a step, dismissing the
// listed kinds, and controls under a pinned footer or a popup iframe.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { planJev } from './fake-jev.mjs';
import { startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-memo-'));
process.env.CDP_AGENT_ID = 'test-do-overlays';
process.env.BROWSERCTRL_NOTIFY = '0';
process.env.BROWSERCTRL_TRACES = TRACES;
process.env.BROWSERCTRL_NOTES = 'off';
process.env.BROWSERCTRL_READ_TOKENS = path.join(MEMO, 'read-tokens.json');
process.env.BROWSERCTRL_SETTLE_MEMORY = path.join(MEMO, 'never.json');
process.env.BROWSERCTRL_SITE_TROUBLE = path.join(MEMO, 'trouble.json');

const haveBrowser = Boolean(chromeBinary());
let browser, conn;
before(async () => {
  if (!haveBrowser) return;
  delete process.env.TYPESAFE_API_KEY;
  process.env.BROWSERCTRL_JEV_ENV = path.join(os.tmpdir(), 'no-such-jev.env');
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => {
  try { conn?.close(); } catch {}
  await browser?.close();
  fs.rmSync(TRACES, { recursive: true, force: true });
  fs.rmSync(MEMO, { recursive: true, force: true });
});
const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);

t('covered Save names its picker and dismisses it once with a neutral dialog click', async () => {
  for (const options of [{ noNotes: true }, { noNotes: true, jev: planJev() }]) {
    const id = (await ops.newTab(conn, 'about:blank')).targetId;
    try {
      await ops.evaluate(conn, id, `document.body.innerHTML = \`<div role="dialog" aria-modal="true" aria-label="Editor" style="position:fixed;left:20px;top:20px;width:500px;height:400px;background:white">
        <input aria-label="Title" value="Draft"><button id="save" style="position:absolute;left:100px;top:100px;width:100px;height:40px" onclick="document.body.dataset.saved='yes'">Save</button>
        <div role="listbox" aria-label="Group picker" style="position:absolute;left:80px;top:80px;width:200px;height:160px;background:gray;z-index:2"><div role="option">Selected group</div></div></div>\`; document.addEventListener('click', e => { const p = document.querySelector('[role=listbox]'); if(p && !p.contains(e.target)) p.remove(); });`);
      await assert.rejects(ops.click(conn, id, { selector: '#save' }), e => {
        assert.match(e.message, /listbox "Group picker"/);
        assert.match(e.message, /Escape may close an enclosing dialog/);
        assert.doesNotMatch(e.message, /`cdp /);
        return true;
      });
      const r = await runSteps(conn, id, ['click "Save"'], options);
      assert.equal(r.done, true, formatSteps(r));
      assert.match(formatSteps(r), /clicked neutral space inside the dialog/);
      assert.equal(await ops.evaluate(conn, id, 'document.body.dataset.saved'), 'yes');
    } finally { await ops.closeTab(conn, id); }
  }
});

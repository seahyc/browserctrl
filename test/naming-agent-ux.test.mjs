// Visible input labels survive legacy form names, without any model calls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { runSteps } from '../lib/steps.mjs';
import { BatchSession } from '../lib/batch.mjs';
import { startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const haveBrowser = Boolean(chromeBinary());
let server, browser, conn, origin;
before(async () => {
  if (!haveBrowser) return;
  delete process.env.TYPESAFE_API_KEY;
  process.env.BROWSERCTRL_JEV_ENV = path.join(os.tmpdir(), 'no-such-agent-ux-jev.env');
  process.env.BROWSERCTRL_NOTES = 'off';
  server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Input naming</title><body>
      <form onsubmit="event.preventDefault(); document.querySelector('#state').textContent='Saved'">
      <div class=row><input id=first type=checkbox name=kpzuqziv1><span>Mosyle Auth Exclusion - Ying's Mac</span></div>
      <div class=row><input type=checkbox name=s8y39f3mu><span>Other Mac</span></div>
      <div class=row><input type=radio name=group123><span>Personal device</span></div>
      <div class=row><input name=field123><span>Device description</span></div>
      <input type=submit name=alterar value=Save>
      <input type=button name=internal value=Cancel>
      <input type=reset name=internal value=Clear>
      <input type=image name=internal alt=Continue>
      <input type=submit name=internal>
      </form><p id=state>Editing</p></body>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => {
  conn?.close();
  await browser?.close();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
});

test('read, guarded batches and do share visible input names with no Jev key', {
  skip: haveBrowser ? false : 'no Chromium-family browser installed',
}, async () => {
  const id = (await ops.newTab(conn, origin)).targetId;
  try {
    await ops.waitForReady(conn, id, { waitUntil: 'load' });
    const page = await ops.readPage(conn, id, { all: true });
    for (const name of ["Mosyle Auth Exclusion - Ying's Mac", 'Other Mac', 'Personal device', 'Device description', 'Save', 'Cancel', 'Clear', 'Continue', 'Submit']) {
      assert.ok(page.elements.some(el => el.name === name), `${name}: ${JSON.stringify(page.elements)}`);
    }
    assert.ok(page.elements.every(el => !['alterar', 'kpzuqziv1', 's8y39f3mu', 'group123', 'field123'].includes(el.name)));
    const batch = await new BatchSession(conn, id, { origin }).observe();
    assert.ok(batch.elements.some(el => el.name === "Mosyle Auth Exclusion - Ying's Mac"));
    assert.ok(batch.elements.some(el => el.name === 'Save'));
    const result = await runSteps(conn, id, ['check "Mosyle Auth Exclusion - Ying\'s Mac"', 'click "Save"'], {
      key: { key: null }, noNotes: true,
    });
    assert.equal(result.done, true, JSON.stringify(result));
    assert.equal(result.jev_calls, 0);
    assert.equal(await ops.evaluate(conn, id, 'document.querySelector("#first").checked'), true);
    assert.equal(await ops.evaluate(conn, id, 'document.querySelector("#state").textContent'), 'Saved');
  } finally {
    await ops.closeTab(conn, id);
  }
});

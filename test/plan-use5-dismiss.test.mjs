// Scroll recovery, committed slider values and collapsed search-header disclosure.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { fakeJev, optionWith } from './fake-jev.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-memo-'));
process.env.CDP_AGENT_ID = 'test-plan-use5-dismiss';
process.env.BROWSERCTRL_NOTIFY = '0';
process.env.BROWSERCTRL_TRACES = TRACES;
process.env.BROWSERCTRL_NOTES = 'off';
process.env.BROWSERCTRL_READ_TOKENS = path.join(MEMO, 'read-tokens.json');
process.env.BROWSERCTRL_SETTLE_MEMORY = path.join(MEMO, 'never.json');
process.env.BROWSERCTRL_SITE_TROUBLE = path.join(MEMO, 'trouble.json');

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
  fs.rmSync(MEMO, { recursive: true, force: true });
});
const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
const url = (page) => fixture.url + 'fixtures/' + page;
const open = async (page, waitUntil = 'load') => {
  const id = (await ops.newTab(conn, url(page))).targetId;
  await ops.waitForReady(conn, id, { waitUntil });
  return id;
};
const js = (id, expr) => ops.evaluate(conn, id, expr);
const run = async (id, steps) => { const r = await runSteps(conn, id, steps, { jev: fakeJev(), noNotes: true }); console.log(formatSteps(r)); return r; };


t('nonmodal dismissal offers only closing controls and verifies removal', async () => {
  const id = await open('plan-use5-dismiss.html');
  const jev = fakeJev({ choice: (q, key) => {
    if (key === 'category') return 'c1';
    if (key === 'control') {
      const names = Object.values(q.criteria).map(c => typeof c === 'string' ? c : c.name || '').join(' | ');
      assert.doesNotMatch(names, /Explore adventures|Continue with email|OK|Skip/);
      return optionWith(q, 'No thanks');
    }
    return 'none';
  } });
  const r = await runSteps(conn, id, ['click "Results"'], { jev, dismiss: ['sign-up popup'], noNotes: true });
  console.log(formatSteps(r));
  assert.equal(await js(id, 'Boolean(document.querySelector("aside"))'), false);
  assert.equal(await js(id, 'Boolean(window.unsafe)'), false);
  assert.ok(r.events.some(e => e.type === 'dismissed'));
  await ops.closeTab(conn, id);
});

t('nonmodal panel with no closing control never offers or clicks an action', async () => {
  const id = await open('plan-use5-dismiss.html');
  await js(id, `document.querySelector('aside button:last-child').remove()`);
  let controlAsked = false;
  const jev = fakeJev({ choice: (q, key) => {
    if (key === 'control') controlAsked = true;
    return key === 'category' ? 'c1' : 'none';
  } });
  const r = await runSteps(conn, id, ['click "Results"'], { jev, dismiss: ['sign-up popup'], noNotes: true });
  console.log(formatSteps(r));
  assert.equal(controlAsked, false);
  assert.equal(await js(id, 'Boolean(window.unsafe)'), false);
  assert.equal(await js(id, 'Boolean(document.querySelector("aside"))'), true);
  assert.equal(r.events.some(e => e.type === 'dismissed'), false);
  await ops.closeTab(conn, id);
});

t('end of plan retries unchanged nonmodal text after initial uncertain category', async () => {
  const id = await open('plan-use5-dismiss.html');
  let categories = 0;
  const jev = fakeJev({ choice: (q, key) => {
    if (key === 'category') return ++categories === 1 ? 'other' : 'c1';
    if (key === 'control') return optionWith(q, 'No thanks');
    return 'none';
  } });
  const r = await runSteps(conn, id, ['click "Results"'], { jev, dismiss: ['sign-up popup'], noNotes: true });
  console.log(formatSteps(r));
  assert.equal(await js(id, 'Boolean(document.querySelector("aside"))'), false);
  assert.equal(await js(id, 'Boolean(window.unsafe)'), false);
  assert.equal(r.steps.at(-1).step, 'end');
  await ops.closeTab(conn, id);
});

// A select named by a label grounds by that label's words alone, with no Jev key: a
// wrapping <label> (whose innerText also carries the options), <label for> and
// aria-labelledby. Seen on the om2w billing dialog: `select "Month"` stopped without a key.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-memo-'));
process.env.CDP_AGENT_ID = 'test-label-select-grounding';
process.env.BROWSERCTRL_NOTIFY = '0';
process.env.BROWSERCTRL_NOTES = 'off';
process.env.BROWSERCTRL_READ_TOKENS = path.join(MEMO, 'read-tokens.json');
process.env.BROWSERCTRL_SETTLE_MEMORY = path.join(MEMO, 'never.json');
process.env.BROWSERCTRL_SITE_TROUBLE = path.join(MEMO, 'trouble.json');

const haveBrowser = Boolean(chromeBinary());
const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
let fixture, browser, conn;
before(async () => {
  if (!haveBrowser) return;
  delete process.env.TYPESAFE_API_KEY;
  process.env.BROWSERCTRL_JEV_ENV = path.join(MEMO, 'no-such-jev.env');
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

const outState = async id => Object.fromEntries(String(await ops.evaluate(conn, id, 'document.querySelector("#out").dataset.s')).split(';').map(x => x.split('=')));

t('selects named by a wrapping label, label[for] or aria-labelledby ground exactly with no Jev key', async () => {
  const id = (await ops.newTab(conn, `${fixture.url}fixtures/label-selects.html`)).targetId;
  await ops.waitForReady(conn, id, {});
  const steps = ['select "Month" = "2026-08"', 'select "Project" = "cygnus"', 'select "Year" = "2027"', 'select "Quarter" = "Q3"', 'fill "Notes" = "final"'];
  const r = await runSteps(conn, id, steps, { noNotes: true });
  const text = formatSteps(r);
  assert.ok(!r.stopped, text);
  assert.equal(r.steps.length, steps.length, text);
  assert.equal((text.match(/\(exact\)/g) || []).length, steps.length, text);
  assert.match(text, /0 Jev calls/);
  const s = await outState(id);
  assert.deepEqual([s.month, s.project, s.year, s.quarter, s.notes], ['2026-08', 'cygnus', '2027', 'Q3', 'final']);
});

t('a label names its control by its own words, without the options or text inside it', async () => {
  const id = (await ops.newTab(conn, `${fixture.url}fixtures/label-selects.html`)).targetId;
  await ops.waitForReady(conn, id, {});
  const snap = await ops.readPage(conn, id);
  const named = Object.fromEntries(snap.elements.filter(e => e.role !== 'button').map(e => [e.role + ':' + e.name, true]));
  for (const want of ['select:Month', 'select:Project', 'select:Year', 'select:Quarter', 'checkbox:Remember me', 'textbox:Email', 'textbox:Notes']) {
    assert.ok(named[want], `${want} in ${JSON.stringify(Object.keys(named))}`);
  }
});

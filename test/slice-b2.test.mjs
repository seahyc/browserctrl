// Friction found by the Online-Mind2Web round 2 runs, on offline fixtures: a bare
// combobox is named from its row's label (SpotHero's vehicle field); a ref into a frame
// that loaded a new page is a stale ref, not "not a field" (Coolmath's quiz); a page whose
// main thread is stuck is recovered by reload, replacing the tab as a last resort (Best Buy).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

process.env.CDP_AGENT_ID = 'test-slice-b2';
process.env.BROWSERCTRL_NOTIFY = '0';
process.env.BROWSERCTRL_READ_TOKENS = path.join(os.tmpdir(), `browserctrl-test-read-tokens-b2-${process.pid}.json`);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = (...args) => promisify(execFile)(process.execPath, [path.join(ROOT, 'bin/browserctrl.mjs'), ...args, '--port', String(TEST_PORT)], { env: process.env, timeout: 120000 });

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
  fs.rmSync(process.env.BROWSERCTRL_READ_TOKENS, { force: true });
});

const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
const open = async (page) => {
  const id = (await ops.newTab(conn, fixture.url + 'fixtures/' + page)).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  return id;
};

t('a bare combobox is named from its row label, with its described-by hint as the placeholder', async () => {
  const id = await open('slice-b2-fields.html');
  const snap = await ops.readPage(conn, id, {});
  const box = snap.elements.find(e => e.role === 'combobox');
  assert.equal(box.name, 'Make and Model', JSON.stringify(box));
  assert.equal(box.placeholder, 'Type to Search');
  assert.equal(box.nameFrom, 'context');
  // Two fields in one row: the row's text belongs to neither.
  const pair = snap.elements.filter(e => e.role === 'textbox' && e.name !== 'Make and Model');
  assert.equal(pair.length, 2);
  assert.ok(pair.every(e => e.name !== 'Plate and state'), JSON.stringify(pair));
  const { stdout } = await cli('read', id.slice(0, 8));
  assert.match(stdout, /combobox\s+Make and Model.*\(named from its row\)/, stdout);
  await ops.closeTab(conn, id);
});

t('a ref into a frame that loaded a new page is reported stale, not "not a field"', async () => {
  const id = await open('slice-b2-frame.html');
  const { stdout } = await cli('read', id.slice(0, 8));
  const ref = stdout.match(/(ref_\d+)\s+e\d+\s+textbox\s+Enter your answer/)?.[1];
  assert.ok(ref, stdout);
  await ops.evaluate(conn, id, `new Promise(r => { const f = document.getElementById('quiz'); f.onload = () => r(1); f.src = 'slice-b2-question.html?q=2'; })`);
  const err = await cli('fill', id.slice(0, 8), ref, '132').then(() => null, e => e);
  assert.ok(err, 'fill on the replaced frame must fail');
  assert.match(String(err.stderr || err.message), /frame that has loaded a new page.*read/i);
  assert.doesNotMatch(String(err.stderr || err.message), /not a field you can type into/);
  // After a fresh read the field in the new page takes the value.
  const again = (await cli('read', id.slice(0, 8))).stdout;
  const ref2 = again.match(/(ref_\d+)\s+e\d+\s+textbox\s+Enter your answer/)?.[1];
  await cli('fill', id.slice(0, 8), ref2, '132');
  const v = await ops.evaluate(conn, id, `document.getElementById('quiz').contentDocument.getElementById('answer').value`);
  assert.equal(v, '132');
  await ops.closeTab(conn, id);
});

t('reload recovers a page whose main thread is stuck: stops the script and loads it again', async () => {
  const id = await open('slice-b2-hang-once.html');
  await new Promise(r => setTimeout(r, 800)); // the loop starts 300 ms after load
  const { stdout } = await cli('reload', id.slice(0, 8), '--timeout', '3000');
  const r = JSON.parse(stdout);
  assert.equal(r.recovered, 'reloaded', stdout);
  assert.ok(r.tried.includes('stopped its script'), stdout);
  assert.equal(await ops.evaluate(conn, id, '1 + 1'), 2);
  await ops.closeTab(conn, id);
});

t('a page that wedges on every load is reopened in a new tab whose id reload prints', async () => {
  const id = await open('slice-b2-hang-always.html');
  await new Promise(r => setTimeout(r, 800));
  // The tab was being recorded: the recording is closed off, with the command to continue it.
  const recDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-b2-rec-'));
  const recState = path.join(recDir, 'rec-tabs.json');
  fs.writeFileSync(recState, JSON.stringify({ [id]: { dir: recDir, port: TEST_PORT, startedAt: Date.now(), n: 1 } }));
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(ROOT, 'bin/browserctrl.mjs'), 'reload', id.slice(0, 8), '--timeout', '2000', '--port', String(TEST_PORT)],
    { env: { ...process.env, BROWSERCTRL_REC_STATE: recState }, timeout: 120000 });
  const r = JSON.parse(stdout);
  assert.equal(r.replaced, true, stdout);
  assert.notEqual(r.tab, id.slice(0, 8));
  assert.match(r.note, new RegExp(`use ${r.tab} from now on`));
  assert.match(r.note, new RegExp(`continue it: browserctrl rec start ${r.tab} --out ${recDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), r.note);
  assert.deepEqual(JSON.parse(fs.readFileSync(recState, 'utf8')), {}, 'the old tab no longer counts as recording');
  assert.ok(JSON.parse(fs.readFileSync(path.join(recDir, 'meta.json'), 'utf8')).endedAt, 'the recording was finished');
  fs.rmSync(recDir, { recursive: true, force: true });
  const tabs = await conn.browser('Target.getTargets');
  assert.ok(!tabs.targetInfos.some(x => x.targetId === id), 'the stuck tab is closed');
  assert.ok(tabs.targetInfos.some(x => x.targetId.startsWith(r.tab) && /slice-b2-hang-always/.test(x.url)), 'the page is open in the new tab');
  await conn.browser('Target.closeTarget', { targetId: r.targetId }).catch(() => {});
});

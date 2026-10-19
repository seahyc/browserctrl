// Pages that stop answering: JavaScript dialogs, a stuck main thread, reload and tab replacement,
// a bot check that clears on reload, and navigating away from a stuck page.
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
import * as captcha from '../lib/captcha.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-memo-'));
process.env.CDP_AGENT_ID = 'test-page-recovery';
process.env.BROWSERCTRL_NOTIFY = '0';
process.env.BROWSERCTRL_TRACES = TRACES;
process.env.BROWSERCTRL_NOTES = 'off';
process.env.BROWSERCTRL_READ_TOKENS = path.join(MEMO, 'read-tokens.json');
process.env.BROWSERCTRL_SETTLE_MEMORY = path.join(MEMO, 'never.json');
process.env.BROWSERCTRL_SITE_TROUBLE = path.join(MEMO, 'trouble.json');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliRun = (args, env = process.env, timeout = 120000) => promisify(execFile)(process.execPath, [path.join(ROOT, 'bin/browserctrl.mjs'), ...args], { env, timeout });
const cli = (...args) => cliRun([...args, '--port', String(TEST_PORT)]);

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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

t('a page waiting on a JavaScript dialog says so and how to answer it; dialog answers it', async () => {
  const id = await open('slice-controls.html');
  // The click returns when the dialog opens (the daemon answers the input then), carrying it.
  const clicked = await ops.click(conn, id, { selector: '#alerter' });
  assert.equal(clicked.dialog?.message, 'Are you sure?');
  assert.match(clicked.next, /browserctrl dialog \w{8} --accept/);
  await assert.rejects(ops.evaluate(conn, id, 'document.title', { timeoutMs: 1500 }),
    /timed out after 1500ms .*JavaScript alert dialog: "Are you sure\?"[\s\S]*browserctrl dialog \w{8} --accept/);
  const { stdout } = await cli('dialog', id.slice(0, 8), '--accept');
  assert.match(stdout, /"answered": "accept"/);
  assert.match(stdout, /Are you sure\?/);
  assert.equal(await ops.evaluate(conn, id, 'document.title', { timeoutMs: 5000 }), 'Steppers, custom checkboxes and accordions');
});

t('a stuck main thread is diagnosed with the command to run', async () => {
  const id = await open('slice-controls.html');
  // A long task started from a timer, as a heavy page script runs (not inside our own input event).
  // Background tabs can align timers to 1 s, so wait until the task has really started.
  await ops.evaluate(conn, id, 'window.__busyFrom = 0; setTimeout(function () { window.__busyFrom = Date.now(); var t = Date.now(); while (Date.now() - t < 15000) {} }, 0); 1');
  for (let i = 0; i < 40; i++) {
    const started = await ops.evaluate(conn, id, 'window.__busyFrom', { timeoutMs: 400 }).catch(() => 'blocked');
    if (started === 'blocked' || started > 0) break;
    await new Promise(r => setTimeout(r, 100));
  }
  await assert.rejects(ops.evaluate(conn, id, 'document.title', { timeoutMs: 1500 }), e => {
    assert.match(e.message, /outcome is uncertain[\s\S]*not responding: its main thread has been stuck[\s\S]*browserctrl reload \w{8}/);
    assert.equal(e.diagnosis.kind, 'hung');
    return true;
  });
  await ops.closeTab(conn, id).catch(() => {});
});

t('a read that times out while the page is briefly busy runs again once it answers', async () => {
  const id = await open('slice-controls.html');
  await ops.evaluate(conn, id, 'window.__busyFrom = 0; setTimeout(function () { window.__busyFrom = Date.now(); var t = Date.now(); while (Date.now() - t < 4000) {} }, 0); 1');
  const t0 = Date.now();
  const r = await ops.evaluate(conn, id, '({ title: document.title, busyFrom: window.__busyFrom })', { timeoutMs: 1000, retry: true });
  assert.equal(r.title, 'Steppers, custom checkboxes and accordions');
  assert.ok(r.busyFrom > 0, 'the busy task ran before the read');
  assert.ok(Date.now() - t0 >= 1000, `the read was blocked (took ${Date.now() - t0} ms), so it timed out and ran again`);
});

t('reload recovers a page whose main thread is stuck: stops the script and loads it again', async () => {
  const id = await open('slice-b2-hang-once.html');
  await new Promise(r => setTimeout(r, 800)); // the loop starts 300 ms after load
  const { stdout } = await cli('reload', id.slice(0, 8), '--timeout', '3000');
  const r = JSON.parse(stdout);
  // Stopping the script and reloading is the first resort; on slow runners (Windows CI) the
  // page can take longer than that to answer, and a later resort is still a recovery.
  assert.ok(['reloaded', 'restarted its renderer', 'replaced the tab'].includes(r.recovered), stdout);
  assert.ok(r.tried.length, stdout);
  const tab = r.replaced ? r.targetId : id;
  assert.equal(await ops.evaluate(conn, tab, '1 + 1'), 2);
  await ops.closeTab(conn, tab);
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

t('a bot check that outlasts the wait gets one reload before giving up', async () => {
  const id = await open('slice-r2.html?challenge=1');
  await ops.evaluate(conn, id, 'sessionStorage.removeItem("loads")');
  await ops.reload(conn, id);
  const found = await captcha.detect(conn, id);
  assert.ok(found, 'the first load shows a challenge');
  const r = await captcha.handoff(conn, id, { found, timeoutMs: 1500, pollMs: 300, focus: false });
  assert.equal(r.solvedBy, 'reload', JSON.stringify(r));
  await ops.closeTab(conn, id);
});

t('navigating away from a stuck page recovers it and lands on the new address', async () => {
  const id = (await ops.newTab(conn, fixture.url + 'fixtures/slice-b2-hang-always.html')).targetId;
  await sleep(1500); // the loop starts after load
  const to = url('slice-r2.html?radius=1');
  const r = await ops.navigate(conn, id, to, { timeoutMs: 12000 });
  assert.ok(r.recovered || r.url === to, JSON.stringify(r));
  const tab = r.targetId || id;
  assert.equal(await ops.evaluate(conn, tab, 'location.href'), to);
  await ops.closeTab(conn, tab);
});

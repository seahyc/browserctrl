// End-to-end: drive a throwaway headless browser through the real core.
// These are the tests that would have caught the documented-but-missing
// commands that shipped in v1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const haveBrowser = Boolean(chromeBinary());
let fixture;
let browser;
let conn;
let tabId;

before(async () => {
  if (!haveBrowser) return;
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
  const tab = await ops.newTab(conn, fixture.url);
  tabId = tab.targetId;
  await ops.waitForReady(conn, tabId, { waitUntil: 'load' });
});

after(async () => {
  try {
    conn?.close();
  } catch {}
  browser?.close();
  await fixture?.close();
});

const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);

t('tabs lists the fixture tab', async () => {
  const tabs = await ops.tabs(conn);
  assert.ok(tabs.some(x => x.targetId === tabId), 'fixture tab should be listed');
});

t('read returns refs, names, test ids and page text', async () => {
  const snap = await ops.readPage(conn, tabId);
  assert.equal(snap.title, 'cdp fixture');
  const go = snap.elements.find(e => e.testid === 'go-button');
  assert.ok(go, 'button with data-testid should be captured');
  assert.equal(go.role, 'button');
  assert.equal(go.name, 'Run it');
  const disabled = snap.elements.find(e => e.name === 'Cannot press');
  assert.equal(disabled.disabled, true);
  const input = snap.elements.find(e => e.tag === 'input' && e.role === 'textbox');
  assert.equal(input.name, 'Your name', 'label[for] should provide the accessible name');
  assert.match(snap.text, /Hello from the fixture/);
});

t('click by ref runs the page handler', async () => {
  const snap = await ops.readPage(conn, tabId);
  const go = snap.elements.find(e => e.testid === 'go-button');
  await ops.click(conn, tabId, { ref: go.ref, token: snap.token });
  await ops.waitFor(conn, tabId, { selector: '#late', timeoutMs: 3000 });
  const visible = await ops.evaluate(conn, tabId, "getComputedStyle(document.getElementById('late')).display");
  assert.equal(visible, 'block');
});

t('wait --gone resolves when the spinner is removed', async () => {
  const res = await ops.waitFor(conn, tabId, { gone: '#spinner', timeoutMs: 3000 });
  assert.equal(res.matched, '#spinner');
});

t('fill fires input events frameworks listen for', async () => {
  await ops.fill(conn, tabId, { selector: '#name', value: 'Ada Lovelace' });
  assert.equal(await ops.evaluate(conn, tabId, 'window.__lastInput'), 'Ada Lovelace');
  assert.equal(await ops.evaluate(conn, tabId, "document.getElementById('name').value"), 'Ada Lovelace');
});

t('read ignores CDP annotation controls and sees controls in open shadow DOM', async () => {
  await ops.evaluate(conn, tabId, `
    document.body.insertAdjacentHTML('beforeend', '<div data-cdp="annotation"><textarea id="cdp-note" aria-label="CDP note"></textarea><button id="cdp-save">Save annotation</button></div><div id="shadow-host"></div>');
    var root = document.getElementById('shadow-host').attachShadow({ mode: 'open' });
    root.innerHTML = '<button id="real-send" aria-label="Send message">Send</button>';
    root.querySelector('button').addEventListener('click', function () { document.body.dataset.sent = 'yes'; });
  `);
  const snap = await ops.readPage(conn, tabId);
  assert.equal(snap.elements.some(e => e.name === 'CDP note' || e.name === 'Save annotation'), false, 'internal annotation controls must never get refs');
  const send = snap.elements.find(e => e.name === 'Send message');
  assert.ok(send, 'controls in open shadow DOM should get refs');
  await ops.click(conn, tabId, { ref: send.ref, token: snap.token });
  assert.equal(await ops.evaluate(conn, tabId, 'document.body.dataset.sent'), 'yes');
  await assert.rejects(() => ops.fill(conn, tabId, { selector: '#cdp-note', value: 'do not touch' }), /annotation UI/);
});

t('key sends a real Enter to the focused element', async () => {
  await ops.click(conn, tabId, { selector: '#name' });
  await ops.key(conn, tabId, 'Enter');
  assert.equal(await ops.evaluate(conn, tabId, 'window.__enterPressed'), true);
});

t('select picks an option by label and fires change', async () => {
  const res = await ops.selectOption(conn, tabId, { selector: '#pick', label: 'Beta' });
  assert.equal(res.value, 'b');
  assert.equal(await ops.evaluate(conn, tabId, 'window.__lastSelect'), 'b');
});

t('select reports the available options when the label is wrong', async () => {
  await assert.rejects(
    () => ops.selectOption(conn, tabId, { selector: '#pick', label: 'Gamma' }),
    /Alpha \| Beta/,
  );
});

t('stale refs are refused rather than clicking the wrong element', async () => {
  const snap = await ops.readPage(conn, tabId);
  await ops.readPage(conn, tabId); // invalidates the previous token
  await assert.rejects(() => ops.click(conn, tabId, { ref: 'ref_1', token: snap.token }), /older snapshot/);
});

t('navigate waits for readiness instead of sleeping', async () => {
  const res = await ops.navigate(conn, tabId, `${fixture.url}slow`, { waitUntil: 'load' });
  assert.match(res.url, /slow/);
  assert.equal(await ops.evaluate(conn, tabId, "document.getElementById('slow').textContent"), 'slow page');
  await ops.navigate(conn, tabId, fixture.url, { waitUntil: 'networkidle' });
});

t('screenshot writes a real png, and element scope is smaller than the page', async () => {
  const page = await ops.screenshot(conn, tabId, { path: '/tmp/cdp-test-page.png' });
  const header = fs.readFileSync(page.path).subarray(0, 8);
  assert.deepEqual([...header], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG magic bytes');
  const el = await ops.screenshot(conn, tabId, { selector: '#intro', path: '/tmp/cdp-test-el.png' });
  assert.ok(el.bytes < page.bytes, 'element shot should be smaller than the viewport shot');
});

t('full-page screenshot captures below the fold', async () => {
  const viewport = await ops.screenshot(conn, tabId, { path: '/tmp/cdp-test-vp.png' });
  const full = await ops.screenshot(conn, tabId, { fullPage: true, path: '/tmp/cdp-test-full.png' });
  assert.ok(full.bytes > viewport.bytes, 'full page should capture more than the viewport');
});

t('diagnostics buffer console output and failed requests', async () => {
  await ops.navigate(conn, tabId, fixture.url, { waitUntil: 'load' });
  const snap = await ops.readPage(conn, tabId);
  await ops.click(conn, tabId, { ref: snap.elements.find(e => e.testid === 'go-button').ref, token: snap.token });
  await ops.waitFor(conn, tabId, { selector: '#late', timeoutMs: 3000 });
  const diag = await ops.diagnostics(conn, tabId, { limit: 100 });
  assert.ok(diag.console.some(c => /go clicked/.test(c.text)), 'console.log should be buffered');

  await ops.evaluate(conn, tabId, `fetch('${fixture.url}404').catch(() => {})`);
  await new Promise(r => setTimeout(r, 500));
  const failed = await ops.failedRequests(conn, tabId);
  assert.ok(failed.some(r => /404/.test(r.url) && r.status === 404), 'a 404 should show up in failed requests');
});

t('scroll moves the viewport', async () => {
  const before2 = await ops.evaluate(conn, tabId, 'window.scrollY');
  await ops.scroll(conn, tabId, { deltaY: 600 });
  await new Promise(r => setTimeout(r, 300));
  const after2 = await ops.evaluate(conn, tabId, 'window.scrollY');
  assert.ok(after2 > before2, `scrollY should increase (${before2} -> ${after2})`);
});

t('resolveTab matches on url substring, not just id', async () => {
  const tab = await ops.resolveTab(conn, '127.0.0.1');
  assert.equal(tab.targetId, tabId);
});

t('a missing element gives an actionable error, not a silent no-op', async () => {
  await assert.rejects(() => ops.click(conn, tabId, { selector: '#nope' }), /No element matches #nope/);
});

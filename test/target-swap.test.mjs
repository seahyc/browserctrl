// A tab whose page target is replaced under it: Chrome activating a prerendered page
// (Speculation Rules) while another DevTools client watches the tab through a tab target.
// The daemon follows the tab to its new target id instead of losing it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';
import { createSwapTracker, SWAP_NOTE } from '../lib/target-swap.mjs';
import { createFillGate } from '../lib/vault-fill.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------- the tracker ---

const page = (targetId, extra = {}) => ({ targetId, type: 'page', url: 'https://x.test/', browserContextId: 'C1', ...extra });
function tracker({ live, husks = {} }) {
  const swaps = [], ambiguous = [];
  const t = createSwapTracker({
    getTargets: async () => ({ targetInfos: live() }),
    getTargetInfo: async targetId => {
      if (husks[targetId] === undefined) throw new Error('No target with given id found');
      return { targetInfo: husks[targetId] };
    },
    onSwap: (from, to) => swaps.push([from, to]),
    onAmbiguous: (from, to) => ambiguous.push([from, to]),
  });
  return { t, swaps, ambiguous };
}
const created = info => ({ method: 'Target.targetCreated', params: { targetInfo: info } });
const changed = info => ({ method: 'Target.targetInfoChanged', params: { targetInfo: info } });

test('an activated prerender replaces the one page that dropped out as a husk', async () => {
  let live = [page('OLD'), page('OTHER'), page('NEXT', { subtype: 'prerender' })];
  const husks = { OLD: { ...page('OLD'), url: '', subtype: 'disconnected', browserContextId: undefined } };
  const { t, swaps, ambiguous } = tracker({ live: () => live, husks });
  for (const info of live) t.onEvent(created(info));
  live = [page('OTHER'), page('NEXT')];
  t.onEvent(changed(page('NEXT')));
  await t.settled();
  assert.deepEqual(swaps, [['OLD', 'NEXT']]);
  assert.deepEqual(ambiguous, []);
  assert.equal(t.resolve('OLD'), 'NEXT');
  assert.equal(t.resolve('OTHER'), 'OTHER');
  assert.deepEqual(t.list().map(r => [r.from, r.to, r.reason]), [['OLD', 'NEXT', 'prerender']]);
  // A second activation on the same tab chains.
  live = [page('OTHER'), page('NEXT'), page('THIRD', { subtype: 'prerender' })];
  t.onEvent(created(live[2]));
  live = [page('OTHER'), page('THIRD')];
  husks.NEXT = { ...page('NEXT'), url: '', subtype: 'disconnected' };
  t.onEvent(changed(page('THIRD')));
  await t.settled();
  assert.equal(t.resolve('OLD'), 'THIRD');
});

test('a prerender activated with no page gone, or a page closed, is not a swap', async () => {
  let live = [page('OLD'), page('NEXT', { subtype: 'prerender' })];
  const { t, swaps } = tracker({ live: () => live });
  for (const info of live) t.onEvent(created(info));
  t.onEvent(changed(page('NEXT')));
  await t.settled();
  assert.deepEqual(swaps, []);
  // OLD closed (targetDestroyed) as the prerender activated elsewhere.
  live = [page('NEXT'), page('NEXT2', { subtype: 'prerender' })];
  t.onEvent(created(live[1]));
  t.onEvent({ method: 'Target.targetDestroyed', params: { targetId: 'OLD' } });
  live = [page('NEXT'), page('NEXT2')];
  t.onEvent(changed(page('NEXT2')));
  await t.settled();
  assert.deepEqual(swaps, []);
});

test('two pages gone at once is ambiguous: nothing is followed', async () => {
  let live = [page('A'), page('B'), page('NEXT', { subtype: 'prerender' })];
  const husk = { type: 'page', url: '', subtype: 'disconnected' };
  const { t, swaps, ambiguous } = tracker({ live: () => live, husks: { A: { ...husk, targetId: 'A' }, B: { ...husk, targetId: 'B' } } });
  for (const info of live) t.onEvent(created(info));
  live = [page('NEXT')];
  t.onEvent(changed(page('NEXT')));
  await t.settled();
  assert.deepEqual(swaps, []);
  assert.deepEqual(ambiguous, [[['A', 'B'], 'NEXT']]);
  assert.equal(t.resolve('A'), 'A');
});

test('a page in another browser context is never taken for the replaced tab', async () => {
  let live = [page('OLD', { browserContextId: 'C2' }), page('NEXT', { subtype: 'prerender' })];
  const { t, swaps } = tracker({ live: () => live, husks: { OLD: { targetId: 'OLD', type: 'page', url: '', subtype: 'disconnected' } } });
  for (const info of live) t.onEvent(created(info));
  live = [page('NEXT')];
  t.onEvent(changed(page('NEXT')));
  await t.settled();
  assert.deepEqual(swaps, []);
});

// -------------------------------------------------------------- vault taint ---

let gatePort = 19700;
const fillRequest = tab => ({ version: 2, request_id: crypto.randomUUID(), deadline: Date.now() / 1000 + 60,
  destination: { browser: 'dia', origins: ['https://accounts.example.com'], tab_id: tab, element: '@e12' }, field: 'password', value: 'private-password-123' });
function fakeBrowser(tab) {
  return async (method, params) => {
    if (method === 'Target.getTargets') return { targetInfos: [{ targetId: tab, type: 'page' }] };
    if (method === 'Page.getNavigationHistory') return { entries: [{ url: 'x' }], currentIndex: 0 };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F', loaderId: 'L1', url: 'https://accounts.example.com/login' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
    if (method === 'Runtime.evaluate') return { result: { subtype: 'node', objectId: 'O1' } };
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 5 } };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'O2' } };
    if (method === 'Runtime.callFunctionOn') return params.arguments[0].value.verify ? { result: { value: { ok: true, length: 20 } } } : { result: { value: { ok: true } } };
    return {};
  };
}
const OLD = 'AAAAAAAA11111111', NEW = 'BBBBBBBB22222222', OTHER = 'CCCCCCCC33333333';

test('a swapped tab keeps its vault taint under the new id, and a restart still knows it', async () => {
  const port = ++gatePort;
  const options = { recording: () => false, send: fakeBrowser(OLD), sessionFor: async () => 'S', withInput: async (_t, _s, fn) => fn() };
  const g = createFillGate(port, options);
  assert.equal((await g.run(fillRequest(OLD), 'owner')).verification, 'filled');
  g.replaced(OLD, NEW);
  assert.equal(g.tainted(NEW), true);
  assert.equal(g.tainted(OLD), false);
  assert.match(g.refusal({ op: 'cdp', targetId: NEW, method: 'Runtime.evaluate' }), /tab_tainted/);
  assert.match(g.refusal({ op: 'cdp', targetId: NEW, method: 'Page.captureScreenshot', mediated: true }), /tab_tainted/);
  assert.equal(g.redact({ v: 'x private-password-123 y' }).v, 'x [redacted] y');
  // The durable marker moved too: a restarted daemon refuses the new id outright.
  const restarted = createFillGate(port, options);
  assert.equal(restarted.tainted(NEW), true);
  assert.equal(restarted.tainted(OLD), false);
});

test('with several possible predecessors the new page inherits every taint and theirs stay', async () => {
  const port = ++gatePort;
  const g = createFillGate(port, { recording: () => false, send: fakeBrowser(OLD), sessionFor: async () => 'S', withInput: async (_t, _s, fn) => fn() });
  assert.equal((await g.run(fillRequest(OLD), 'owner')).verification, 'filled');
  g.replaced([OLD, OTHER], NEW);
  assert.equal(g.tainted(OLD), true);
  assert.equal(g.tainted(NEW), true);
  assert.equal(g.tainted(OTHER), false);
});

// ------------------------------------------------- a real prerender swap ---

const HOME = fs.mkdtempSync('/tmp/bc-swap-');
const BASE_ENV = {
  ...process.env, BROWSERCTRL_HOME: HOME, BROWSERCTRL_AGENT_ID: 'agent-swap', BROWSERCTRL_NOTIFY: '0', BROWSERCTRL_NOTES: 'off',
  BROWSERCTRL_JEV_ENV: path.join(HOME, 'no-such-jev.env'),
};
for (const k of ['TYPESAFE_API_KEY', 'BROWSERCTRL_BROWSER', 'BROWSERCTRL_PORT', 'CDP_AGENT_ID']) delete BASE_ENV[k];

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/browserctrl.mjs'), ...args, '--port', String(TEST_PORT)],
      { env: BASE_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// Another DevTools client on the browser that works through tab targets, as current
// DevTools front ends and Puppeteer do. Chrome lets a tab prerender (and swaps its page
// target on activation) only under such a client.
async function tabClient(port) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map(), listeners = new Set();
  ws.onmessage = e => {
    const d = JSON.parse(e.data);
    if (d.id) { pending.get(d.id)?.(d); pending.delete(d.id); } else for (const l of listeners) l(d);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, d => (d.error ? reject(new Error(d.error.message)) : resolve(d.result)));
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const until = (pred, ms = 15000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(l); reject(new Error('timed out waiting for a CDP event')); }, ms);
    const l = d => { if (pred(d)) { clearTimeout(timer); listeners.delete(l); resolve(d); } };
    listeners.add(l);
  });
  return { send, until, close: () => ws.close() };
}

const haveBrowser = Boolean(chromeBinary()) && typeof WebSocket === 'function';
const t = (name, fn) => test(name, { skip: !haveBrowser && 'no Chromium-family browser (or no WebSocket in this Node)' }, fn);
let server, base, browser;
before(async () => {
  if (!haveBrowser) return;
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (req.url.startsWith('/next')) return res.end('<html><head><title>Next page</title></head><body><h1>Prerendered next page</h1></body></html>');
    res.end(`<html><head><title>Start page</title><script type="speculationrules">{"prerender":[{"source":"list","urls":["/next"]}]}</script></head>
<body><h1>Start</h1><a href="/next">Go next</a></body></html>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await startHeadlessBrowser(TEST_PORT);
});
after(async () => {
  if (haveBrowser) await run(['stop']).catch(() => {});
  await browser?.close();
  await new Promise(r => server ? server.close(r) : r());
  fs.rmSync(HOME, { recursive: true, force: true });
});

t('a tab whose prerendered page activates is followed to its new target', async () => {
  const other = await tabClient(TEST_PORT);
  try {
    await other.send('Target.setDiscoverTargets', { discover: true });
    // The tab loads, and prerenders /next, before browserctrl attaches.
    const { targetId: oldId } = await other.send('Target.createTarget', { url: `${base}/start` });
    const { targetInfos } = await other.send('Target.getTargets', { filter: [{ type: 'tab' }] });
    const tab = targetInfos.find(t => t.url.startsWith(`${base}/start`));
    assert.ok(tab, 'tab target for the start page');
    const { sessionId: tabSession } = await other.send('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
    const prerendered = other.until(d => d.params?.targetInfo?.subtype === 'prerender' && d.params.targetInfo.url.endsWith('/next'));
    await other.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, tabSession);
    const nextId = (await prerendered).params.targetInfo.targetId;
    await new Promise(r => setTimeout(r, 1000)); // let it finish loading
    assert.notEqual(nextId, oldId);

    assert.equal((await run(['use', oldId.slice(0, 8)])).code, 0);
    const r = await run(['do', oldId.slice(0, 8), 'click "Go next"', '--then', 'text']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Prerendered next page/);
    assert.match(r.stderr, new RegExp(SWAP_NOTE(nextId).replace(/[()]/g, '\\$&')));

    // The old target is gone from the browser's list; the old id, the current tab and the
    // claim all lead to the new one.
    const tabs = JSON.parse((await run(['tabs', '--json'])).stdout);
    assert.ok(!tabs.some(row => row.targetId === oldId));
    const now = tabs.find(row => row.targetId === nextId);
    assert.ok(now?.claimedBy, 'the claim moved to the new target');
    const byOldId = await run(['text', oldId.slice(0, 8)]);
    assert.equal(byOldId.code, 0, byOldId.stderr);
    assert.match(byOldId.stdout, /Prerendered next page/);
    assert.match(byOldId.stderr, /target changed \(prerendered page activated\); continuing on /);
    const current = await run(['text']);
    assert.equal(current.code, 0, current.stderr);
    assert.match(current.stdout, /Prerendered next page/);
  } finally { other.close(); }
});

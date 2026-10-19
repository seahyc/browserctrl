// The bridge listens on loopback, which any web page can reach. These tests are
// what a hostile page can and cannot do. No browser is needed, and no test calls
// a route that scans the user's real browsers (/api/tabs is only checked refused).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-sec-'));
process.env.BROWSERCTRL_HOME = home;
process.env.CDP_HOME = path.join(home, 'cdp');

const bridge = await import('../lib/bridge.mjs');
const state = await import('../lib/state.mjs');
const annotations = await import('../lib/annotations.mjs');
const recorder = await import('../lib/recorder.mjs');
const config = await import('../lib/config.mjs');

const PORT = Number(process.env.BROWSERCTRL_TEST_PORT || 9333) + 40;
const base = `http://127.0.0.1:${PORT}`;
const EVIL = 'https://evil.example';
let server;
let token;

before(async () => {
  server = await bridge.start(PORT, { idleMs: 0 });
  token = bridge.bridgeToken();
  state.mark(4242, 'secret-target', { note: 'private note', url: 'https://bank.example/account', title: 'My bank' });
  annotations.add({ note: 'pending annotation', page: { url: 'https://bank.example/' } });
});

after(() => server?.close());

const withToken = (extra = {}) => ({ headers: { 'X-Browserctrl-Token': token, ...extra } });

test('the token is 32 random bytes in a private file', () => {
  const file = config.runtimePath('bridge-token');
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), token);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(bridge.bridgeToken(), token, 'a second caller must read the same token, not make another');
});

test('without the token every data route is refused and returns nothing', async () => {
  const routes = [
    ['GET', '/api/tabs'], ['GET', '/api/marks'], ['GET', '/shots/x.png'], ['GET', '/api/recordings'],
    ['GET', '/api/recordings/abc/video'], ['GET', '/api/annotations'], ['GET', '/api/sessions'], ['GET', '/api/browsers'],
    ['GET', '/tray'], ['GET', '/annotator?id=abc'], ['GET', '/api/prewarm'], ['GET', '/api/token'],
    ['POST', '/api/marks'], ['POST', '/annotations'], ['POST', '/api/recordings'], ['POST', '/api/prewarm'],
    ['DELETE', '/api/marks'], ['DELETE', '/api/annotations'],
  ];
  for (const [method, route] of routes) {
    const res = await fetch(base + route, { method, body: method === 'POST' ? '{}' : undefined });
    const text = await res.text();
    assert.equal(res.status, 403, `${method} ${route}`);
    assert.equal(text, '{"error":"forbidden"}', `${method} ${route} must not say anything else`);
  }
  assert.equal(state.marks().length, 1, 'refused requests must not change anything');
});

test('a wrong token is refused like no token', async () => {
  const res = await fetch(`${base}/api/marks`, { headers: { 'X-Browserctrl-Token': 'a'.repeat(64) } });
  assert.equal(res.status, 403);
  assert.equal((await fetch(`${base}/api/marks?t=nope`)).status, 403);
});

test('with the token, routes answer (header, or t= for what a page loads as img/video/link)', async () => {
  const marks = await (await fetch(`${base}/api/marks`, withToken())).json();
  assert.equal(marks.length, 1);
  assert.equal(marks[0].note, 'private note');
  assert.equal((await fetch(`${base}/api/recordings`, withToken())).status, 200);
  assert.equal((await fetch(`${base}/api/recordings?t=${token}`)).status, 200);
  assert.equal((await fetch(`${base}/api/annotations`, withToken())).status, 200);
  const shot = await fetch(`${base}/shots/x.png?t=${token}`);
  assert.equal(shot.status, 404, 'authenticated, then simply not there');
});

test('a hostile origin gets no CORS grant, with or without a guess at the token', async () => {
  for (const headers of [{ Origin: EVIL }, { Origin: EVIL, 'X-Browserctrl-Token': 'b'.repeat(64) }]) {
    const res = await fetch(`${base}/api/marks`, { headers });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.headers.get('access-control-allow-private-network'), null);
  }
  // The scripts are public, but carry nothing: no grant and no token inside.
  const js = await fetch(`${base}/overlay.js`, { headers: { Origin: EVIL } });
  assert.equal(js.status, 200);
  assert.equal(js.headers.get('access-control-allow-origin'), null);
  assert.ok(!(await js.text()).includes(token));
});

test('a caller that proved itself is allowed to read cross-origin, and only that origin', async () => {
  const res = await fetch(`${base}/api/marks`, withToken({ Origin: 'http://localhost:3000' }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assert.match(res.headers.get('vary'), /Origin/);
});

test('preflight works for the real request, and exposes nothing', async () => {
  const res = await fetch(`${base}/api/marks`, {
    method: 'OPTIONS',
    headers: { Origin: EVIL, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-browserctrl-token' },
  });
  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-methods'), /POST/);
  assert.match(res.headers.get('access-control-allow-headers'), /X-Browserctrl-Token/i);
  assert.equal(await res.text(), '');
  assert.equal(res.headers.get('access-control-allow-private-network'), null);
  // ...and the request that follows still needs the token.
  assert.equal((await fetch(`${base}/api/marks`, { headers: { Origin: EVIL } })).status, 403);
});

test('a request under another hostname (DNS rebinding) is refused even with the token', async () => {
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/api/marks', headers: { Host: `evil.example:${PORT}`, 'X-Browserctrl-Token': token } }, r => { r.resume(); resolve(r.statusCode); }).on('error', reject);
  });
  assert.equal(status, 403);
});

test('a GET never changes state', async () => {
  const snapshot = () => JSON.stringify([state.marks().map(({ ageMs, ...m }) => m), annotations.pending(), recorder.list()]);
  const before = snapshot();
  for (const route of ['/api/marks', '/api/annotations', '/api/annotations?consume=1', '/api/recordings', '/api/prewarm', '/api/sessions', '/health', '/tray', '/overlay.js']) {
    await fetch(base + route, withToken()).then(r => r.text());
  }
  assert.equal(snapshot(), before);
  assert.equal(annotations.pending().length, 1, 'consume=1 on a GET must not consume');
});

test('pages the bridge serves carry the token; nothing else does', async () => {
  const tray = await (await fetch(`${base}/tray`, withToken())).text();
  assert.ok(tray.includes(token), 'the tray needs it for its own fetches');
  const framed = await fetch(`${base}/tray?t=${token}`);
  assert.equal(framed.headers.get('x-frame-options'), 'DENY');
  assert.equal(framed.headers.get('referrer-policy'), 'no-referrer');
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.ok(!(await health.text()).includes(token));
});

test('the extension is trusted by its own origin, which comes from the manifest key', async () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const id = bridge.extensionId(manifest.key);
  assert.match(id, /^[a-p]{32}$/);
  const ext = { Origin: `chrome-extension://${id}` };
  assert.equal((await fetch(`${base}/api/marks`, { headers: ext })).status, 200);
  const handed = await (await fetch(`${base}/api/token`, { headers: ext })).json();
  assert.equal(handed.token, token);
  assert.equal((await fetch(`${base}/api/marks`, { headers: { Origin: `chrome-extension://${'a'.repeat(32)}` } })).status, 403, 'another extension is not trusted');
  assert.equal((await fetch(`${base}/api/token`, withToken())).status, 403, 'only the extension is handed the token');
});

test('what runs inside web pages holds no way to reach the bridge', () => {
  const overlay = fs.readFileSync(new URL('../lib/overlay/annotate.js', import.meta.url), 'utf8');
  assert.ok(!/fetch\s*\(/.test(overlay), 'the overlay must not call the bridge');
  assert.ok(!/__cdpBridge|17222/.test(overlay));
  const injected = recorder.injectionScript('rec-1');
  assert.ok(!/fetch\s*\(|__cdpBridge|17222/.test(injected), 'the recorder must not call the bridge');
  assert.ok(!injected.includes(token) && !overlay.includes(token));
});

test('the bridge exits after its idle time', async () => {
  const port = PORT + 1;
  let idle = false;
  const s = await bridge.start(port, { idleMs: 200, onIdle: () => { idle = true; } });
  await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(idle, false);
  for (let i = 0; i < 40 && !idle; i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(idle, true, 'no request for idleMs should end it');
  assert.equal(s.listening, false);
});

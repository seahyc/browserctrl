// Passive capture: fetch/XHR traffic from attached tabs becomes a per-host
// endpoint catalog with a few full exemplars per endpoint.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { endpointOf, createStore, frameKind, frameJson, createCapture } from '../lib/exemplars.mjs';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-exemplars-'));

test('endpoint templates normalize ids and keep query keys, not values', () => {
  assert.deepEqual(endpointOf('GET', 'https://shop.example/api/v4/order/48213/items?offset=20&limit=20'),
    { host: 'shop.example', template: 'GET /api/v4/order/{n}/items?limit&offset' });
  assert.equal(endpointOf('POST', 'https://x.com/i/api/graphql/Aa1Bb2Cc3Dd4Ee5Ff6Gg7H/SearchTimeline?variables=1').template,
    'POST /i/api/graphql/{id}/SearchTimeline?variables');
  assert.equal(endpointOf('GET', 'https://a.b/u/0f8fad5b-d9cb-469f-a165-70867728950e').template, 'GET /u/{uuid}');
  assert.equal(endpointOf('GET', 'https://a.b/aps/fg/2.0/orders/').template, 'GET /aps/fg/2.0/orders/');
});

test('the store keeps the last three exemplars per endpoint in a private gzip file', () => {
  const dir = path.join(tmp, 'unit');
  const store = createStore(dir);
  for (let i = 0; i < 5; i++) store.record({ method: 'GET', url: `https://shop.example/api/orders/${i}`, status: 200, responseBody: `{"i":${i}}` });
  store.flush();
  const [ep] = createStore(dir).exemplars('shop.example');
  assert.equal(ep.template, 'GET /api/orders/{n}');
  assert.equal(ep.count, 5);
  assert.deepEqual(ep.exemplars.map(e => e.responseBody), ['{"i":2}', '{"i":3}', '{"i":4}']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'shop.example.json.gz')).mode & 0o777, 0o600);
});

test('WebSocket frames are classified by prefix or JSON type, and parsed', () => {
  assert.equal(frameKind('LOGI{"key":"k"}'), 'LOGI');
  assert.equal(frameKind('{"type":"message","x":1}'), 'type=message');
  assert.equal(frameKind('{"op":2}'), 'op=2');
  assert.equal(frameKind('hello'), 'text');
  assert.deepEqual(frameJson('MESG{"message":"hi"}'), { message: 'hi' });
  assert.equal(frameJson('not json'), null);
});

const haveBrowser = Boolean(chromeBinary());
let fixture, browser, conn;
before(async () => {
  if (!haveBrowser) return;
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => {
  try { await conn?.stop(); } catch {}
  try { conn?.close(); } catch {}
  await browser?.close();
  await fixture?.close();
});

test('a page fetch in an attached tab is captured with its headers and JSON body', { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, async () => {
  const { targetId } = await ops.newTab(conn, 'about:blank');
  await ops.evaluate(conn, targetId, '1'); // attach and enable Network before the page loads
  await ops.navigate(conn, targetId, `${fixture.url}shop`);
  await ops.waitFor(conn, targetId, { selector: 'body[data-loaded="2"]', present: true, timeoutMs: 10000 });
  const host = new URL(fixture.url).host;
  let ep;
  for (let i = 0; i < 40 && !ep; i++) {
    await new Promise(r => setTimeout(r, 250));
    ep = createStore(process.env.BROWSERCTRL_EXEMPLARS).exemplars(host, '/api/orders/').at(0);
  }
  assert.ok(ep, 'the orders endpoint should be in the store');
  assert.equal(ep.template, 'GET /api/orders/{n}?limit&offset');
  const ex = ep.exemplars.at(-1);
  assert.equal(ex.status, 200);
  assert.equal(ex.requestHeaders['x-csrf'], 'tok-123');
  assert.equal(JSON.parse(ex.responseBody).data.orders.length, 2);
  assert.match(ex.page, /\/shop$/);
});

test('a page WebSocket frame in an attached tab is captured by kind', { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, async () => {
  const { targetId } = await ops.newTab(conn, 'about:blank');
  await ops.evaluate(conn, targetId, '1');
  await ops.navigate(conn, targetId, `${fixture.url}chat`);
  await ops.waitFor(conn, targetId, { selector: 'body[data-logi="1"]', present: true, timeoutMs: 10000 });
  const host = new URL(fixture.url).host;
  let ep;
  for (let i = 0; i < 40 && !ep; i++) {
    await new Promise(r => setTimeout(r, 250));
    ep = createStore(process.env.BROWSERCTRL_EXEMPLARS).exemplars(host, 'WS recv LOGI ').at(0);
  }
  assert.ok(ep, 'the LOGI frame should be in the store');
  assert.equal(frameJson(ep.exemplars.at(-1).frame).key, fixture.wsKey);
});

test('extra request headers arriving twice before the request do not throw', () => {
  const cap = createCapture({ store: { record() {} }, getBody: async () => null });
  // A redirect sends requestWillBeSentExtraInfo twice before requestWillBeSent.
  cap.onEvent('Network.requestWillBeSentExtraInfo', { requestId: 'r1', headers: { cookie: 'a' } });
  cap.onEvent('Network.requestWillBeSentExtraInfo', { requestId: 'r1', headers: { cookie: 'b' } });
  cap.onEvent('Network.requestWillBeSent', { requestId: 'r1', type: 'Fetch', documentURL: 'https://x/', request: { method: 'GET', url: 'https://x/api', headers: {} } });
  cap.onEvent('Network.requestWillBeSentExtraInfo', { requestId: 'r1', headers: { cookie: 'c' } });
});

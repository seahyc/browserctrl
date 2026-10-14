// API recipes: replay a site's own API inside a tab on that site.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { get, fill, coerce, shape, freshFrameValue, runRecipe, listRecipes, loadRecipe, findRecipes, recipeHint, recipeMatches, tapAdd, tapUpdate, tapRemove, listTaps } from '../lib/recipes.mjs';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-recipes-'));

test('paths read nested values, negative indexes and collections', () => {
  const doc = { data: { offers: [{ at: 'a', tags: ['x'] }, { at: 'b', tags: ['y', 'x'] }] } };
  assert.equal(get(doc, 'data.offers[-1].at'), 'b');
  assert.deepEqual(get(doc, 'data.offers[*].tags[*]'), ['x', 'y']);
  assert.equal(get(doc, 'data.missing[0].at'), undefined);
});

test('templates keep types when whole, interpolate and encode when embedded', () => {
  const scope = { limit: 20, q: 'a b&c', auth: { csrf: 't' } };
  assert.equal(fill('{{limit}}', scope), 20);
  assert.equal(fill('/s?q={{q}}&n={{limit}}', scope, { encode: true }), '/s?q=a%20b%26c&n=20');
  assert.deepEqual(fill({ h: '{{auth.csrf}}', n: ['{{limit}}'] }, scope), { h: 't', n: [20] });
  assert.equal(coerce('50', 20), 50);
  assert.equal(coerce('TAB_DONE', 'TAB_COMPLETED'), 'TAB_DONE');
  assert.deepEqual(shape({ output: { id: 'id', cents: 'price.cents' } }, [{ id: 1, price: { cents: 5 } }]), [{ id: 1, cents: 5 }]);
});

test('listRecipes reads site/name files and reports unreadable ones', () => {
  const dir = path.join(tmp, 'store');
  fs.mkdirSync(path.join(dir, 'shop.example'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shop.example', 'orders.json'), JSON.stringify({ kind: 'read', description: 'd', tab: 'handoff' }));
  fs.writeFileSync(path.join(dir, 'shop.example', 'broken.json'), '{');
  const rows = listRecipes(dir, path.join(tmp, 'no-taps'));
  assert.deepEqual(rows.map(r => r.name), ['shop.example/broken', 'shop.example/orders']);
  assert.match(rows[0].error, /unreadable/);
  assert.equal(rows[1].tab, 'handoff');
});

test('local recipes override tapped ones, and taps may keep recipes under recipes/', () => {
  const local = path.join(tmp, 'local'), taps = path.join(tmp, 'taps');
  const put = (root, name, body) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), JSON.stringify(body)); };
  put(path.join(taps, 'community', 'recipes'), 'shopee.sg/orders.json', { description: 'tapped orders', origin: 'https://shopee.sg' });
  put(path.join(taps, 'community', 'recipes'), 'taobao.com/orders.json', { description: 'tapped taobao', origin: 'https://buyertrade.taobao.com', keywords: ['purchases'] });
  put(local, 'shopee.sg/orders.json', { description: 'my orders', origin: 'https://shopee.sg' });
  const rows = listRecipes(local, taps);
  assert.deepEqual(rows.map(r => [r.name, r.source]), [['shopee.sg/orders', 'local'], ['taobao.com/orders', 'community']]);
  assert.equal(loadRecipe('taobao.com/orders', local, taps).description, 'tapped taobao');
  assert.deepEqual(listTaps(taps), ['community']);
});

test('recipes are found by URL (site, origin host and subdomains, or match) and by words', () => {
  const rows = [
    { name: 'taobao.com/orders', origin: 'https://buyertrade.taobao.com', description: 'Full Taobao purchase history', keywords: ['orders'] },
    { name: 'shopee.sg/orders', origin: 'https://shopee.sg', description: 'Shopee purchase history' },
    { name: 'x.com/search', origin: 'https://x.com', match: ['^https://x\\.com/search'], description: 'Search posts' },
  ];
  assert.ok(recipeMatches(rows[0], 'https://world.taobao.com/cart'));
  assert.ok(!recipeMatches(rows[0], 'https://nottaobao.com/'));
  assert.ok(recipeMatches(rows[2], 'https://x.com/search?q=a') && !recipeMatches(rows[2], 'https://x.com/home'));
  assert.deepEqual(findRecipes('https://shopee.sg/user/purchase', rows).map(r => r.name), ['shopee.sg/orders']);
  assert.deepEqual(findRecipes('purchase history', rows).map(r => r.name), ['taobao.com/orders', 'shopee.sg/orders']);
  assert.deepEqual(findRecipes('taobao orders', rows).map(r => r.name), ['taobao.com/orders']);
  assert.match(recipeHint('https://shopee.sg/', rows), /shopee\.sg\/orders \(Shopee purchase history\).*recipe run/);
  assert.equal(recipeHint('https://example.com/', rows), null);
  assert.equal(recipeHint('about:blank', rows), null);
});

test('taps are cloned from git, updated fast-forward and removed', async () => {
  const repo = path.join(tmp, 'tap-src');
  fs.mkdirSync(path.join(repo, 'shop.example'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'shop.example', 'orders.json'), '{"description":"one"}');
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  g('init', '-q'); g('add', '.'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one');
  const taps = path.join(tmp, 'tapdir');
  assert.deepEqual(await tapAdd(repo, 'shared', taps), { tap: 'shared', recipes: 1 });
  await assert.rejects(tapAdd(repo, 'shared', taps), /already exists/);
  fs.writeFileSync(path.join(repo, 'shop.example', 'returns.json'), '{}');
  g('add', '.'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'two');
  assert.deepEqual(await tapUpdate('shared', taps), [{ tap: 'shared', recipes: 2 }]);
  assert.deepEqual(tapRemove('shared', taps), { removed: 'shared' });
  assert.deepEqual(listTaps(taps), []);
});

test('a captured frame is used only while it is recent and not about to expire', () => {
  const now = Date.parse('2026-10-13T13:30:00Z');
  const frame = (at, key, expires) => ({ at, frame: `LOGI{"key":"${key}","expires_at":${expires}}` });
  const src = { path: 'key', expires_path: 'expires_at' };
  const frames = [frame('2026-10-13T13:20:00Z', 'old', 1791898000), frame('2026-10-13T13:26:00Z', 'new', 1791898560)];
  assert.equal(freshFrameValue(frames, src, now), 'new', 'newest frame, expiring in 6 minutes (seconds)');
  assert.equal(freshFrameValue(frames, src, Date.parse('2026-10-13T13:35:45Z')), null, 'within 30s of expiry');
  assert.equal(freshFrameValue([frame('2026-10-13T13:26:00Z', 'ms', 1791898560000)], src, now), 'ms', 'milliseconds work too');
  assert.equal(freshFrameValue(frames, { path: 'key', max_age_s: 60 }, now), null, 'older than max_age_s');
  assert.equal(freshFrameValue([], src, now), null);
});

const haveBrowser = Boolean(chromeBinary());
let fixture, browser, conn, origin;
before(async () => {
  if (!haveBrowser) return;
  fixture = await startFixtureServer();
  origin = fixture.url.replace(/\/$/, '');
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => {
  try { await conn?.stop(); } catch {}
  try { conn?.close(); } catch {}
  await browser?.close();
  await fixture?.close();
});
const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);

const ordersRecipe = () => ({
  name: 'fixture/orders', kind: 'read', origin, warm_path: '/shop', settle_ms: 0,
  auth: { csrf: { from: 'html', path: '/shop', regex: '"csrfToken":"([^"]+)"' } },
  request: { method: 'GET', url: '/api/orders/48213?offset={{offset}}&limit={{limit}}', headers: { 'x-csrf': '{{auth.csrf}}' } },
  params: { limit: 2, offset: 0 },
  paginate: { type: 'offset', param: 'offset', step: '{{limit}}', items: 'data.orders' },
  output: { id: 'id', cents: 'price.cents' },
});

t('a recipe resolves its token from the page HTML and paginates in an owned tab', async () => {
  const res = await runRecipe(conn, ordersRecipe());
  assert.deepEqual(res.items.map(x => x.id), [100, 101, 102, 103, 104]);
  assert.equal(res.items[4].cents, 1250);
  assert.equal(res.calls, 3);
  const again = await runRecipe(conn, ordersRecipe(), { limit: '5' });
  assert.equal(again.tab, res.tab, 'the owned tab is reused');
  assert.equal(again.calls, 2, 'a string override keeps the numeric type');
});

t('param defaults may use built-ins such as now_iso', async () => {
  const recipe = { name: 'fixture/now', origin, warm_path: '/shop', settle_ms: 0, params: { since: '{{now_iso}}' }, paginate: { start: 0 },
    js: 'async (cursor, params) => ({ items: [params.since], next: null })' };
  const res = await runRecipe(conn, recipe);
  assert.match(res.items[0], /^\d{4}-\d\d-\d\dT/);
});

t('an owned tab that drifted off the site is navigated back and reused', async () => {
  const first = await runRecipe(conn, ordersRecipe());
  const owned = (await ops.tabs(conn)).find(x => x.id === first.tab);
  await ops.navigate(conn, owned.targetId, 'about:blank');
  const again = await runRecipe(conn, ordersRecipe());
  assert.equal(again.tab, first.tab);
  assert.equal(again.items.length, 5);
});

t('a recipe waits for a challenge on its tab to clear before calling', async () => {
  process.env.BROWSERCTRL_NOTIFY = '0';
  const recipe = { ...ordersRecipe(), name: 'fixture/challenged', tab: 'handoff', handoff_match: `^${origin}/verify/captcha`, captcha_wait_ms: 20000 };
  const human = await ops.newTab(conn, `${origin}/verify/captcha?y=1`);
  await ops.waitForReady(conn, human.targetId, { waitUntil: 'load' });
  // Clear well after the recipe starts checking, even on a slow runner.
  await ops.evaluate(conn, human.targetId, "setTimeout(() => history.replaceState(null, '', '/shop'), 2500), 1");
  const res = await runRecipe(conn, recipe);
  assert.equal(res.challenge.captcha, 'shopee-verify');
  assert.equal(res.challenge.solvedBy, 'human');
  assert.ok(res.challenge.waitedMs > 0);
  assert.equal(res.items.length, 5);
});

t('a ws auth source reads a session key that only ever appeared in a WebSocket frame', async () => {
  const recipe = {
    name: 'fixture/chat-messages', origin, warm_path: '/chat', settle_ms: 0,
    auth: { sk: { from: 'ws', frame: 'LOGI', path: 'key' } },
    request: { method: 'GET', url: '/api/chat-messages', credentials: 'omit', headers: { 'session-key': '{{auth.sk}}' } },
    paginate: { items: 'messages' }, output: { text: 'text' },
  };
  const res = await runRecipe(conn, recipe);
  assert.deepEqual(res.items.map(m => m.text), ['Yup still possible', 'Deal']);
});

t('a page hook returns items and the next cursor', async () => {
  const recipe = {
    name: 'fixture/hook', origin, warm_path: '/shop', settle_ms: 0, paginate: { start: 0 },
    js: "async (offset) => { const j = await (await fetch('/api/orders/1?offset=' + offset + '&limit=3', {headers: {'x-csrf': 'tok-123'}})).json(); return { items: j.data.orders.map(o => o.title), next: j.data.orders.length === 3 ? offset + 3 : null }; }",
  };
  const res = await runRecipe(conn, recipe);
  assert.deepEqual(res.items, ['Item 0', 'Item 1', 'Item 2', 'Item 3', 'Item 4']);
  assert.equal(res.calls, 2);
});

t('a handoff recipe refuses to open a tab and uses the human tab without navigating it', async () => {
  const recipe = { ...ordersRecipe(), name: 'fixture/handoff', tab: 'handoff', handoff_match: `^${origin}/shop\\?human` };
  await assert.rejects(runRecipe(conn, recipe), /needs a tab you opened yourself/);
  const human = await ops.newTab(conn, `${origin}/shop?human=1`);
  await ops.waitForReady(conn, human.targetId, { waitUntil: 'load' });
  const res = await runRecipe(conn, recipe);
  assert.equal(res.tab, human.id);
  assert.equal(res.items.length, 5);
  assert.equal(await ops.evaluate(conn, human.targetId, 'location.search'), '?human=1');
});

const stallRecipe = (k, kind) => ({
  name: `fixture/stall-${kind}`, kind, origin, warm_path: '/shop', settle_ms: 0, timeout_ms: 1500,
  request: { method: 'GET', url: `/api/hang-once?k=${k}` }, paginate: { items: 'items' },
});
const hits = async k => (await fetch(`${origin}/api/hits?k=${k}`)).json();

t('a read recipe whose call never answers fails fast in the page and is retried once', async () => {
  const k = `read-${Date.now()}`;
  const started = Date.now();
  const res = await runRecipe(conn, stallRecipe(k, 'read'));
  assert.deepEqual(res.items.map(x => x.id), [1, 2]);
  assert.equal(res.retried.length, 1);
  assert.match(res.retried[0], /call 1: the request did not finish within 1500 ms.*stopped in call 1/);
  assert.equal(await hits(k), 2);
  assert.ok(Date.now() - started < 15000, 'bounded by the in-page timeout, not the 30 s CDP one');
});

t('a write recipe is never retried and says its outcome is uncertain', async () => {
  const k = `write-${Date.now()}`;
  await assert.rejects(runRecipe(conn, stallRecipe(k, 'write')), /did not finish within 1500 ms.*stopped in call 1.*never retried/);
  assert.equal(await hits(k), 1);
});

t('an HTTP error is not retried', async () => {
  const recipe = { ...ordersRecipe(), name: 'fixture/forbidden', auth: {}, request: { method: 'GET', url: '/api/orders/1' } };
  await assert.rejects(runRecipe(conn, recipe), (e) => /HTTP 403/.test(e.message) && e.retried.length === 0);
});

t('the recipe tab renders as if visible without being selected', async () => {
  const res = await runRecipe(conn, ordersRecipe());
  const owned = (await ops.tabs(conn)).find(x => x.id === res.tab);
  const page = await ops.evaluate(conn, owned.targetId, "new Promise(r => requestAnimationFrame(() => r(document.visibilityState)))", { timeoutMs: 5000 });
  assert.equal(page, 'visible');
});

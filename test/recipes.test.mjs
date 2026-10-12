// API recipes: replay a site's own API inside a tab on that site.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { get, fill, coerce, shape, runRecipe, listRecipes } from '../lib/recipes.mjs';
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
  const rows = listRecipes(dir);
  assert.deepEqual(rows.map(r => r.name), ['shop.example/broken', 'shop.example/orders']);
  assert.match(rows[0].error, /unreadable/);
  assert.equal(rows[1].tab, 'handoff');
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

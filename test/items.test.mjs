// The item reader must keep the reading mistakes agents made on real sites from
// recurring: promoted cards, a banner mistaken for results, chat senders, lazy lists.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { itemsExpression, formatItems } from '../lib/items.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const haveBrowser = Boolean(chromeBinary());
let fixture, browser, conn;

before(async () => {
  if (!haveBrowser) return;
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});

after(async () => {
  try { conn?.close(); } catch {}
  await browser?.close();
  await fixture?.close();
});

const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
const open = async (page) => {
  const id = (await ops.newTab(conn, fixture.url + 'fixtures/' + page)).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  return id;
};
const items = (id, opts) => ops.evaluate(conn, id, itemsExpression(opts));

t('results grid, banner and nav are separate groups, each labelled by its region', async () => {
  const id = await open('items-market.html');
  const r = await items(id);
  const grid = r.groups.find(g => g.heading.includes('Search results'));
  const banner = r.groups.find(g => g.label === 'Official store');
  const nav = r.groups.find(g => g.region.includes('nav'));
  assert.ok(grid && banner && nav, formatItems(r));
  assert.equal(grid.count, 12);
  assert.equal(banner.count, 3);
  assert.notEqual(grid.id, banner.id);
  assert.equal(grid.columns, 4);
  assert.match(grid.items[0].link, /^\/p\/listing-1$/);
  await ops.closeTab(conn, id);
});

t('a promoted card carries its badge and class hint inside the item', async () => {
  const id = await open('items-market.html');
  const grid = (await items(id)).groups.find(g => g.heading.includes('Search results'));
  assert.match(grid.items[0].text, /^Spotlight · Herman Miller Aeron 1/);
  assert.deepEqual(grid.items[0].hints, ['D_bump_x2']);
  assert.equal(grid.items[2].hints, undefined);
  await ops.closeTab(conn, id);
});

t('chat messages report which side they sit on', async () => {
  const id = await open('items-chat.html');
  const r = await items(id);
  const thread = r.groups.find(g => g.region.includes('log'));
  assert.ok(thread, formatItems(r));
  assert.deepEqual(thread.items.map(i => i.align), ['left', 'right', 'left', 'right', 'left', 'right']);
  await ops.closeTab(conn, id);
});

t('ids stay stable across reads and newly loaded items are marked', async () => {
  const id = await open('items-market.html');
  await ops.wake(conn, id); // a background tab runs no IntersectionObserver otherwise
  const first = (await items(id)).groups.find(g => g.heading.includes('Search results'));
  assert.ok(first.items.every(i => i.new));
  await ops.evaluate(conn, id, 'window.scrollTo(0, document.body.scrollHeight)');
  await ops.evaluate(conn, id, 'new Promise(r => setTimeout(r, 300))');
  const second = (await items(id, { all: true })).groups.find(g => g.heading.includes('Search results'));
  assert.equal(second.count, 18);
  assert.deepEqual(second.items.slice(0, 12).map(i => i.id), first.items.map(i => i.id));
  assert.ok(second.items.slice(0, 12).every(i => !i.new));
  assert.ok(second.items.slice(12).every(i => i.new));
  await ops.closeTab(conn, id);
});

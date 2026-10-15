// One lookup for a site: recipes (with run usage) first, then flow notes (ids, this page
// first, api notes as recipe candidates, links to recipes), and the combined hint block.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-site-'));
Object.assign(process.env, {
  BROWSERCTRL_NOTES_DIR: path.join(TMP, 'notes'), BROWSERCTRL_RECIPES: path.join(TMP, 'recipes'), BROWSERCTRL_TAPS: path.join(TMP, 'taps'),
  TYPESAFE_API_KEY: '', BROWSERCTRL_JEV_ENV: path.join(TMP, 'missing.env'),
});
const notes = await import('../lib/notes.mjs');
const site = await import('../lib/site.mjs');

fs.mkdirSync(path.join(TMP, 'recipes/shop.example.com'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'recipes/shop.example.com/orders.json'), JSON.stringify({
  description: 'All orders, newest first. Paged.', origin: 'https://shop.example.com', params: { tab: 'ALL', cursor: '' },
  request: { url: 'https://shop.example.com/api/orders' },
}));
beforeEach(() => { fs.rmSync(path.join(TMP, 'notes'), { recursive: true, force: true }); delete process.env.BROWSERCTRL_NOTES; });

test('site lookup lists recipes with run usage, then notes with this page first', async () => {
  await notes.add('https://shop.example.com/orders', 'Order tabs are in the URL as ?tab=', { force: true });
  await notes.add('shop.example.com', 'Prices follow the visitor\'s location', { force: true });
  const api = await notes.add('https://shop.example.com/orders', 'The order list comes from GET /api/orders?tab=&cursor=', { force: true, api: true });
  await notes.add('shop.example.com', 'For order history, the recipe is faster than paging the UI', { force: true, recipe: 'shop.example.com/orders' });

  const info = site.lookup('https://shop.example.com/orders?tab=2');
  assert.equal(info.site, 'example.com');
  assert.deepEqual(info.recipes.map(r => r.name), ['shop.example.com/orders']);
  assert.equal(info.recipes[0].run, 'browserctrl recipe run shop.example.com/orders tab=ALL cursor=…');
  assert.deepEqual(info.notes.slice(0, 2).map(n => n.path), ['/orders', '/orders']);
  assert.equal(info.candidates, 1);
  const text = site.format(info);
  assert.ok(text.indexOf('Recipes') < text.indexOf('Notes'), text);
  assert.match(text, /browserctrl recipe run shop\.example\.com\/orders tab=ALL/);
  assert.match(text, new RegExp(`${api.id} \\[api\\] The order list comes from GET /api/orders.*api, recipe candidate`));
  assert.match(text, /recipe is faster than paging the UI → recipe run shop\.example\.com\/orders/);
  assert.match(text, /1 api note is a recipe candidate: browserctrl recipe endpoints shop\.example\.com/);
  // A bare site finds the same recipe.
  assert.deepEqual(site.lookup('shop.example.com').recipes.map(r => r.name), ['shop.example.com/orders']);
});

test('one hint block: header with counts and where to see all, recipes, then notes', async () => {
  for (let i = 0; i < 7; i++) await notes.add('shop.example.com', `Site fact number ${i}`, { force: true });
  const block = site.hintBlock('https://shop.example.com/orders');
  assert.equal(block[0], '1 recipe (faster than the UI), 5 of 7 notes for example.com (all: browserctrl site example.com)');
  assert.match(block[1], /^ {2}recipe shop\.example\.com\/orders: All orders, newest first → browserctrl recipe run shop\.example\.com\/orders/);
  assert.equal(block.length, 7);
  assert.match(block[2], /^ {2}[0-9a-f]{5} Site fact number/);
  // Notes off for hints (the notes-off arm): recipes still show, notes do not.
  process.env.BROWSERCTRL_NOTES = 'quiet';
  assert.deepEqual(site.hintBlock('https://shop.example.com/orders'), ['1 recipe (faster than the UI) for example.com (all: browserctrl site example.com)', block[1]]);
  assert.equal(site.lookup('shop.example.com').notes.length, 0);
  assert.deepEqual(site.hintBlock('https://other.example.org/'), []);
});

test('browserctrl site and notes add --api / --recipe from the CLI', async () => {
  const run = (...a) => promisify(execFile)('node', [path.join(ROOT, 'bin/browserctrl.mjs'), ...a], { env: process.env });
  assert.match((await run('notes', 'add', 'shop.example.com', '--force', '--api', 'Order details come from GET /api/orders/<id>')).stdout, /Added [0-9a-f]{5}/);
  assert.match((await run('notes', 'add', 'shop.example.com', '--recipe', 'shop.example.com/orders', '--force', 'Use the orders recipe for history')).stdout, /Added/);
  await assert.rejects(run('notes', 'add', 'shop.example.com', '--recipe', 'nope/x', '--force', 'x'), /No recipe nope\/x/);
  const out = (await run('site', 'https://shop.example.com/orders')).stdout;
  assert.match(out, /^example\.com {2}\(https:\/\/shop\.example\.com\/orders\)/);
  assert.match(out, /Recipes \(the site's own API/);
  assert.match(out, /\[api\] Order details come from/);
  assert.match(out, /Use the orders recipe for history → recipe run shop\.example\.com\/orders/);
  const json = JSON.parse((await run('site', 'shop.example.com', '--json')).stdout);
  assert.equal(json.recipes.length, 1);
  assert.equal(json.notes.length, 2);
  // notes <url> lists the page's notes first, with ids.
  await run('notes', 'add', 'https://shop.example.com/cart', '--force', 'The cart page shows fees only at checkout');
  const ranked = (await run('notes', 'https://shop.example.com/cart')).stdout.split('\n');
  assert.match(ranked[1], /^ {2}[0-9a-f]{5} \[agent\] The cart page shows fees/);
});

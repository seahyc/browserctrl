// read v2: the page-reading techniques of Browser Use's serializer, on offline fixtures.
// A card link is one row, covered and inert controls are marked, ids are stable and new
// rows are marked, stats and loading hints, same-origin frames, the viewport window, and
// clickable divs found by cursor or click listener.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import * as jev from '../lib/jev.mjs';
import { formatRead } from '../lib/refs.mjs';
import { runSteps } from '../lib/steps.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

process.env.CDP_AGENT_ID = 'test-read-v2';
process.env.BROWSERCTRL_NOTIFY = '0';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = (...args) => promisify(execFile)(process.execPath, [path.join(ROOT, 'bin/browserctrl.mjs'), ...args, '--port', String(TEST_PORT)], { env: process.env, timeout: 60000 }).then(r => r.stdout);

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
});

const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
const open = async (page) => {
  const id = (await ops.newTab(conn, fixture.url + 'fixtures/' + page)).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  return id;
};
const title = (id) => ops.evaluate(conn, id, 'document.title');
const byName = (snap, re) => snap.elements.filter(e => re.test(e.name || ''));

t('a card that is one link reads as one row; its Like button and input stay separate', async () => {
  const id = await open('read-cards.html');
  const snap = await ops.readPage(conn, id);
  const aeron = byName(snap, /Herman Miller Aeron/);
  assert.equal(aeron.length, 1, formatRead(snap));
  assert.equal(aeron[0].role, 'link');
  assert.match(aeron[0].href, /\/p\/aeron$/);
  assert.equal(byName(snap, /^S\$\d+$/).length, 0, 'price spans fold into their card');
  assert.equal(byName(snap, /^office\.chair\.seller$/).length, 0);
  const like = snap.elements.find(e => e.name === 'Like Aeron');
  assert.ok(like && like.role === 'button', 'a real nested control stays');
  assert.ok(snap.elements.find(e => e.name === 'Quantity' && e.tag === 'input'), 'inputs inside a card stay');
  assert.ok(snap.stats.folded >= 6, JSON.stringify(snap.stats));
  await ops.click(conn, id, { ref: like.ref, token: snap.token });
  assert.equal(await ops.evaluate(conn, id, 'document.querySelector(".like").textContent'), 'liked');
  await ops.closeTab(conn, id);
});

t('an open modal: its controls come first, the background is inert and covered, and clicks behind it are refused', async () => {
  const id = await open('read-modal.html');
  const snap = await ops.readPage(conn, id);
  assert.equal(snap.modal.name, 'Subscribe to our newsletter');
  assert.deepEqual(snap.elements.slice(0, 2).map(e => e.name), ['No thanks', 'Subscribe'], formatRead(snap));
  assert.ok(snap.elements.slice(0, 2).every(e => e.modal && !e.inert && !e.covered));
  const bg = snap.elements.find(e => e.name === 'Background action');
  assert.equal(bg.inert, true);
  assert.match(bg.covered, /^div/);
  assert.match(formatRead(snap), /Background action\s+\(covered by div/);
  await assert.rejects(ops.click(conn, id, { ref: bg.ref, token: snap.token }), err => err.code === 'covered');
  assert.equal(await title(id), 'Modal');
  await ops.click(conn, id, { ref: snap.elements[0].ref, token: snap.token });
  assert.equal(await title(id), 'closed');
  await ops.closeTab(conn, id);
});

t('ids are stable across reads; elements added since the last read are marked new', async () => {
  const id = await open('read-cards.html');
  const a = await ops.readPage(conn, id);
  assert.equal(a.elements.some(e => e.new), false, 'the first read marks nothing new');
  const b = await ops.readPage(conn, id);
  assert.deepEqual(b.elements.map(e => e.id), a.elements.map(e => e.id));
  assert.notEqual(a.token, b.token);
  const add = b.elements.find(e => e.name === 'Add one');
  await ops.click(conn, id, { ref: add.ref, token: b.token });
  const c = await ops.readPage(conn, id);
  const fresh = c.elements.find(e => e.name === 'Freshly added');
  assert.equal(fresh.new, true);
  assert.deepEqual(c.elements.filter(e => e.new).map(e => e.name), ['Freshly added']);
  assert.equal(c.elements.find(e => e.name === 'Add one').id, add.id);
  assert.match(formatRead(c), new RegExp(`\\*${fresh.ref}\\s+${fresh.id}\\s+button\\s+Freshly added`));
  const d = await ops.readPage(conn, id);
  assert.equal(d.elements.find(e => e.name === 'Freshly added').new, undefined, 'new only once');
  await ops.closeTab(conn, id);
});

t('a skeleton page reports stats and a loading hint', async () => {
  const id = await open('read-skeleton.html');
  const snap = await ops.readPage(conn, id);
  assert.equal(snap.stats.readyState, 'complete');
  assert.ok(snap.stats.skeletons >= 3, JSON.stringify(snap.stats));
  assert.match(snap.loading, /page may still be loading: .*skeleton/);
  assert.match(formatRead(snap), /^loading: page may still be loading/m);
  await ops.closeTab(conn, id);
  const cards = await open('read-cards.html');
  const ok = await ops.readPage(conn, cards);
  assert.equal(ok.loading, undefined, `a loaded page has no loading hint: ${ok.loading}`);
  assert.equal(ok.stats.links, 3);
  await ops.closeTab(conn, cards);
});

t('scroll reports screens above and below', async () => {
  const id = await open('read-long.html');
  const a = await ops.readPage(conn, id);
  assert.equal(a.scroll.above, 0);
  const expect = Math.round(((await ops.evaluate(conn, id, 'document.documentElement.scrollHeight')) - a.scroll.vh) / a.scroll.vh * 10) / 10;
  assert.equal(a.scroll.below, expect);
  assert.ok(a.scroll.below > 3, JSON.stringify(a.scroll));
  await ops.evaluate(conn, id, `window.scrollTo(0, ${a.scroll.vh * 2})`);
  const b = await ops.readPage(conn, id);
  assert.equal(b.scroll.above, 2);
  assert.equal(b.scroll.below, Math.round((expect - 2) * 10) / 10);
  assert.match(formatRead(b), /scroll \d+\/\d+ · 2 screens above, [\d.]+ below/);
  await ops.closeTab(conn, id);
});

t('a same-origin iframe button gets a ref that clicks it; cross-origin frames are listed', async () => {
  const id = await open('read-frames.html');
  await new Promise(r => setTimeout(r, 300));
  const snap = await ops.readPage(conn, id);
  const a = snap.elements.find(e => e.name === 'Frame A');
  const b = snap.elements.find(e => e.name === 'Frame B');
  assert.ok(a && b, formatRead(snap));
  assert.ok(a.frame !== undefined && b.frame !== undefined);
  // The frame starts at 180+7+11 = 198 px; the button 30 px into it.
  assert.equal(a.box.x, 228);
  assert.equal(snap.stats.iframes, 2);
  assert.deepEqual(snap.stats.crossOrigin, ['http://localhost:1']);
  await ops.click(conn, id, { ref: b.ref, token: snap.token });
  assert.equal(await title(id), 'frame B clicked');
  await ops.click(conn, id, { ref: a.ref, token: snap.token });
  assert.equal(await title(id), 'frame A clicked');
  const q = snap.elements.find(e => e.name === 'Frame search');
  await ops.fill(conn, id, { ref: q.ref, value: 'aeron', token: snap.token });
  assert.equal(await ops.evaluate(conn, id, 'document.getElementById("inner").contentDocument.getElementById("q").value'), 'aeron');
  await ops.closeTab(conn, id);
});

t('the default read lists what is near the viewport and counts the rest; --all lists the whole page', async () => {
  const id = await open('read-long.html');
  const near = await ops.readPage(conn, id, { all: false });
  assert.ok(near.elements.find(e => e.name === 'Top action'));
  assert.equal(near.elements.find(e => e.name === 'Next'), undefined);
  assert.ok(near.omitted.below > 50, JSON.stringify(near.omitted));
  assert.equal(near.elements.length + near.omitted.total, 122);
  assert.ok(near.elements.some(e => e.offscreen === 'below'), 'a screen below the fold is still listed, marked below');
  assert.match(formatRead(near), /\(\d+ more elements not listed: \d+ below; --all lists the whole page\)/);
  const all = await ops.readPage(conn, id);
  assert.equal(all.elements.length, 122);
  assert.equal(all.omitted, undefined);
  assert.ok(all.elements.find(e => e.name === 'Next'));
  assert.ok(jev.candidatesFor(all.elements, 'click').some(e => e.name === 'Next'));
  await ops.closeTab(conn, id);
});

t('do still finds a Next link far below the fold', async () => {
  const id = await open('read-long.html');
  const r = await runSteps(conn, id, ['click Next']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(r.steps[0].how, 'exact');
  assert.equal(await ops.evaluate(conn, id, 'document.querySelector("h1").textContent'), 'Page 2');
  await ops.closeTab(conn, id);
});

t('a div dropdown with a pointer cursor and click listener is listed and opens by ref', async () => {
  const id = await open('read-dropdown.html');
  const snap = await ops.readPage(conn, id);
  const sort = snap.elements.find(e => /^Sort By: Best Match$/.test(e.name));
  assert.ok(sort, formatRead(snap));
  assert.equal(sort.role, 'clickable');
  assert.equal(byName(snap, /^Best Match$/).length, 0, 'children of a clickable are not separate rows');
  const chip = snap.elements.find(e => e.name === 'Free shipping');
  assert.ok(chip && chip.role === 'clickable', 'a listener without a pointer cursor counts too');
  await ops.click(conn, id, { ref: sort.ref, token: snap.token });
  assert.equal(await ops.evaluate(conn, id, 'document.getElementById("menu").classList.contains("open")'), true);
  const opened = await ops.readPage(conn, id);
  const low = opened.elements.find(e => e.name === 'Price low to high');
  assert.ok(low && low.new, formatRead(opened));
  await ops.closeTab(conn, id);
  // The plan that failed on a real site: open the dropdown, pick by its exact label.
  const id2 = await open('read-dropdown.html');
  const r = await runSteps(conn, id2, ['click "Sort By: Best Match"', 'click "Price low to high"']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await ops.evaluate(conn, id2, 'document.getElementById("state").textContent'), 'sorted: asc');
  await ops.closeTab(conn, id2);
});

t('the read command windows by default and lists the whole page with --all', async () => {
  const id = await open('read-long.html');
  const text = await cli('read', id, '--text', 'none');
  assert.match(text, /^stats: \d+ interactive · 121 links · \d+ elements$/m);
  assert.match(text, /Top action/);
  assert.doesNotMatch(text, /link\s+Next\b/);
  assert.match(text, /more elements not listed: \d+ below; --all lists the whole page/);
  const all = JSON.parse(await cli('read', id, '--all', '--json', '--text', 'none'));
  assert.ok(all.elements.find(e => e.name === 'Next'));
  assert.equal(all.omitted, undefined);
  assert.ok(all.elements.every(e => /^e\d+$/.test(e.id) && /^ref_\d+$/.test(e.ref)));
  await ops.closeTab(conn, id);
});

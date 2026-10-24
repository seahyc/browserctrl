// What read reports: rows, names, refs, ids, covered and inert controls, frames, the viewport
// window, loading hints and stale refs.
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
import * as jev from '../lib/jev.mjs';
import { deepTextExpression, formatRead, frameGroundingHint } from '../lib/refs.mjs';
import { itemsExpression, formatItems } from '../lib/items.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { planJev } from './fake-jev.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-memo-'));
process.env.CDP_AGENT_ID = 'test-read-snapshot';
process.env.BROWSERCTRL_NOTIFY = '0';
process.env.BROWSERCTRL_TRACES = TRACES;
process.env.BROWSERCTRL_NOTES = 'off';
process.env.BROWSERCTRL_READ_TOKENS = path.join(MEMO, 'read-tokens.json');
process.env.BROWSERCTRL_SETTLE_MEMORY = path.join(MEMO, 'never.json');
process.env.BROWSERCTRL_SITE_TROUBLE = path.join(MEMO, 'trouble.json');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliRun = (args, env = process.env, timeout = 120000) => promisify(execFile)(process.execPath, [path.join(ROOT, 'bin/browserctrl.mjs'), ...args], { env, timeout });
const cli = (...args) => cliRun([...args, '--port', String(TEST_PORT)]);
const cliOut = (...args) => cliRun([...args, '--port', String(TEST_PORT)]).then(r => r.stdout);

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
const state = (id) => ops.evaluate(conn, id, `document.querySelector('#state').textContent`);
const rowOf = (snap, re) => snap.elements.find(e => re.test(e.name || ''));
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

t('a dominant inaccessible frame explains how to open its full URL in a plan', async () => {
  const id = await open('read-frames.html');
  // A sandbox without allow-same-origin gives a real opaque-origin document,
  // while keeping all fixture traffic on the local server.
  const src = url('read-frames.html') + '?calculator=1#form';
  await ops.evaluate(conn, id, `document.body.innerHTML = ''; document.body.style.margin = '0';
    const f = document.createElement('iframe'); f.sandbox = ''; f.src = ${JSON.stringify(src)};
    f.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border:0;padding:0';
    // Resolves once the frame has loaded (the parent sees load even for an opaque origin).
    new Promise(r => { f.onload = () => r(true); document.body.append(f); setTimeout(() => r(false), 15000); });`);
  const snap = await ops.readPage(conn, id);
  assert.equal(snap.stats.inaccessibleFrames[0].src, src);
  const hint = frameGroundingHint(snap);
  assert.match(hint, /read\/do cannot ground its contents/);
  assert.ok(hint.includes(`nav ${src}`));
  assert.ok(formatRead(snap).includes(hint));
  const stopped = await runSteps(conn, id, ['fill Pension amount = 100'], { noNotes: true });
  console.log(formatSteps(stopped));
  assert.equal(stopped.done, false);
  assert.ok(stopped.stopped.reason.includes(`nav ${src}`));
  await ops.evaluate(conn, id, `document.querySelector('iframe').style.cssText = 'width:10px;height:10px'`);
  assert.equal(frameGroundingHint(await ops.readPage(conn, id)), null, 'small frames do not suggest leaving the page');
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
  const text = await cliOut('read', id, '--text', 'none');
  assert.match(text, /^stats: \d+ interactive · 121 links · \d+ elements$/m);
  assert.match(text, /Top action/);
  assert.doesNotMatch(text, /link\s+Next\b/);
  assert.match(text, /more elements not listed: \d+ below; --all lists the whole page/);
  const all = JSON.parse(await cliOut('read', id, '--all', '--json', '--text', 'none'));
  assert.ok(all.elements.find(e => e.name === 'Next'));
  assert.equal(all.omitted, undefined);
  assert.ok(all.elements.every(e => /^e\d+$/.test(e.id) && /^ref_\d+$/.test(e.ref)));
  await ops.closeTab(conn, id);
});

t('an open dropdown rendered outside its dialog is listed first and is not inert', async () => {
  const id = await open('slice-portal.html');
  const snap = await ops.readPage(conn, id, { all: false });
  const six = rowOf(snap, /^600$/);
  assert.ok(six, 'the 600 option is listed within the default limit');
  assert.equal(six.role, 'option');
  assert.ok(!six.inert, JSON.stringify(six));
  assert.ok(six.popup);
  assert.ok(snap.elements.indexOf(six) < 5, `listed first, not at ${snap.elements.indexOf(six)}`);
  assert.ok(rowOf(snap, /^Listing 3$/)?.inert, 'the page behind the dialog stays inert');
  assert.match(formatRead(snap), /option\s+600\s+\(open list\)/);
  await ops.click(conn, id, { ref: six.ref, token: snap.token });
  assert.equal(await ops.evaluate(conn, id, 'document.getElementById("sqft").textContent'), '600');
});

t('icon-only stepper buttons are named from their row and direction', async () => {
  const id = await open('slice-controls.html');
  const snap = await ops.readPage(conn, id);
  const inc = rowOf(snap, /^Increase Children/);
  const dec = rowOf(snap, /^Decrease Children/);
  assert.ok(inc && dec, formatRead(snap));
  assert.equal(inc.nameFrom, 'context');
  assert.ok(rowOf(snap, /^Increase Adults/));
  await ops.click(conn, id, { ref: inc.ref, token: snap.token });
  assert.equal(await ops.evaluate(conn, id, 'kids.textContent'), '1');
  assert.match(formatRead(snap), /Increase Children\s+\(named from its row\)/);
});

t('a custom checkbox is not covered by its own stretched input; the click checks it', async () => {
  const id = await open('slice-controls.html');
  const snap = await ops.readPage(conn, id);
  const black = rowOf(snap, /^Black 179$/);
  assert.ok(black, formatRead(snap));
  assert.ok(!black.covered, `flagged covered by ${black.covered}`);
  await ops.click(conn, id, { ref: black.ref, token: snap.token });
  assert.equal(await ops.evaluate(conn, id, 'window.blackChecked === true'), true);
});

t('a bare combobox is named from its row label, with its described-by hint as the placeholder', async () => {
  const id = await open('slice-b2-fields.html');
  const snap = await ops.readPage(conn, id, {});
  const box = snap.elements.find(e => e.role === 'combobox');
  assert.equal(box.name, 'Make and Model', JSON.stringify(box));
  assert.equal(box.placeholder, 'Type to Search');
  assert.equal(box.nameFrom, 'context');
  // Two fields in one row: the row's text belongs to neither.
  const pair = snap.elements.filter(e => e.role === 'textbox' && e.name !== 'Make and Model');
  assert.equal(pair.length, 2);
  assert.ok(pair.every(e => e.name !== 'Plate and state'), JSON.stringify(pair));
  const { stdout } = await cli('read', id.slice(0, 8));
  assert.match(stdout, /combobox\s+Make and Model.*\(named from its row\)/, stdout);
  await ops.closeTab(conn, id);
});

t('a ref into a frame that loaded a new page is reported stale, not "not a field"', async () => {
  const id = await open('slice-b2-frame.html');
  const { stdout } = await cli('read', id.slice(0, 8));
  const ref = stdout.match(/(ref_\d+)\s+e\d+\s+textbox\s+Enter your answer/)?.[1];
  assert.ok(ref, stdout);
  await ops.evaluate(conn, id, `new Promise(r => { const f = document.getElementById('quiz'); f.onload = () => r(1); f.src = 'slice-b2-question.html?q=2'; })`);
  const err = await cli('fill', id.slice(0, 8), ref, '132').then(() => null, e => e);
  assert.ok(err, 'fill on the replaced frame must fail');
  assert.match(String(err.stderr || err.message), /frame that has loaded a new page.*read/i);
  assert.doesNotMatch(String(err.stderr || err.message), /not a field you can type into/);
  // After a fresh read the field in the new page takes the value.
  const again = (await cli('read', id.slice(0, 8))).stdout;
  const ref2 = again.match(/(ref_\d+)\s+e\d+\s+textbox\s+Enter your answer/)?.[1];
  await cli('fill', id.slice(0, 8), ref2, '132');
  const v = await ops.evaluate(conn, id, `document.getElementById('quiz').contentDocument.getElementById('answer').value`);
  assert.equal(v, '132');
  await ops.closeTab(conn, id);
});

// Best Buy's filter read "Sam ung Galaxy S25+": the page-side label cleanup was written
// /\s+/ inside a template string, which the page received as /s+/.
t('a field named by its <label for> keeps every letter', async () => {
  const id = await open('slice-c-results.html');
  const snap = await ops.readPage(conn, id, {});
  const box = snap.elements.find(e => e.role === 'checkbox');
  assert.equal(box?.name, 'Samsung Galaxy S25+ (12)', JSON.stringify(box));
  await ops.closeTab(conn, id);
});

t('a getRootNode polyfill that returns undefined does not break reading the page', async () => {
  const id = await open('slice-r1.html?polyfill');
  const snap = await ops.readPage(conn, id, { maxText: 0, max: 1500, all: true });
  assert.ok(snap.elements.some(e => e.name === 'Inside a span'), JSON.stringify(snap.elements.slice(0, 3)));
  await ops.closeTab(conn, id);
});

t('text, read and items see a quiz drawn in a shadow root, and a plan can answer it', async () => {
  const id = await open('slice-r2.html?shadowquiz=1');
  const text = await ops.evaluate(conn, id, deepTextExpression());
  assert.match(text, /How often do you exercise\?/);
  assert.match(text, /Most days/);
  assert.match(text, /Weight quiz/);
  assert.ok(text.indexOf('Weight quiz') < text.indexOf('How often'), 'light text before the component that follows it');
  const snap = await ops.readPage(conn, id, { maxText: 20000, max: 1500, all: true });
  assert.match(snap.text, /How often do you exercise\?/);
  const items = await ops.evaluate(conn, id, itemsExpression({}));
  assert.match(formatItems(items, { full: true }), /Most days/, formatItems(items, { full: true }));
  const r = await runSteps(conn, id, ['click "Most days"'], { jev: planJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(r.steps[0].checked, true);
  assert.equal(await state(id), 'Most days');
  await ops.closeTab(conn, id);
});

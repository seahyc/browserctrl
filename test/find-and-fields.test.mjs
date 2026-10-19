// find, fields and items, and the CLI's click and fill targets: refs, selectors, coordinates,
// labels and the nearest field.
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
import * as finder from '../lib/find.mjs';
import { formatRead } from '../lib/refs.mjs';
import { itemsExpression, formatItems } from '../lib/items.mjs';
import { mainLinks } from '../lib/steps.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-memo-'));
process.env.CDP_AGENT_ID = 'test-find-and-fields';
process.env.BROWSERCTRL_NOTIFY = '0';
process.env.BROWSERCTRL_TRACES = TRACES;
process.env.BROWSERCTRL_NOTES = 'off';
process.env.BROWSERCTRL_READ_TOKENS = path.join(MEMO, 'read-tokens.json');
process.env.BROWSERCTRL_SETTLE_MEMORY = path.join(MEMO, 'never.json');
process.env.BROWSERCTRL_SITE_TROUBLE = path.join(MEMO, 'trouble.json');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliRun = (args, env = process.env, timeout = 120000) => promisify(execFile)(process.execPath, [path.join(ROOT, 'bin/browserctrl.mjs'), ...args], { env, timeout });
const cli = (...args) => cliRun([...args, '--port', String(TEST_PORT)]);
// One agent identity for every CLI call: the test's own calls and its CLI calls are one owner.
const cliEnv = (args, env = {}) => cliRun(args, { ...process.env, ...env });

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
const rowOf = (snap, re) => snap.elements.find(e => re.test(e.name || ''));
const page = { url: 'https://x.io/s', title: 't', scroll: { y: 0, h: 1, vh: 1 }, groups: [
  { id: 'g1', region: 'nav', chrome: true, count: 3, items: [{ id: 'i1', text: 'Home', link: '/' }] },
  { id: 'g2', region: 'main', count: 4, items: [
    { id: 'i2', text: 'Spotlight · Chair A · S$10', link: '/p/a' },
    { id: 'i3', text: 'Chair B · S$20', link: '/p/b' },
    { id: 'i4', text: 'Chair C · S$30', link: '/p/c', hints: ['card-sponsored'] },
    { id: 'i5', text: 'Chair D · S$40', link: '/p/d' },
  ] },
  { id: 'g3', region: 'aside', count: 3, items: [{ id: 'i6', text: 'Related one' }, { id: 'i7', text: 'Related two' }, { id: 'i8', text: 'Related three' }] },
] };

t('read shows a disclosure button as collapsed or expanded, and items lists the section it opened first', async () => {
  const id = await open('slice-controls.html');
  let snap = await ops.readPage(conn, id);
  assert.match(formatRead(snap), /Number of seats\s+\(collapsed\)/);
  await ops.evaluate(conn, id, itemsExpression({ maxGroups: 1 }));
  await ops.click(conn, id, { ref: rowOf(snap, /^Number of seats$/).ref, token: snap.token });
  snap = await ops.readPage(conn, id);
  assert.match(formatRead(snap), /Number of seats\s+\(expanded\)/);
  // The opened section's options are their own group even though they sit inside the
  // accordion list's item, and they come first under the group cap.
  const r = await ops.evaluate(conn, id, itemsExpression({ maxGroups: 1 }));
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].revealed, 'expanded', JSON.stringify(r.groups.map(g => [g.heading, g.revealed])));
  assert.deepEqual(r.groups[0].items.map(i => i.text), ['1 seat', '2 seats', '3 seats', '4 seats', '5 seats']);
  assert.match(formatItems(r), /\(in an expanded section\)/);
});

t('click and fill take a positional ref or selector; a word that is neither says what to do instead', async () => {
  const id = await open('slice-controls.html');
  const short = id.slice(0, 8);
  const { stdout } = await cli('read', short);
  const ref = /^\s*\*?(ref_\d+)\s+e\d+\s+textbox\s+Destination/m.exec(stdout)?.[1];
  assert.ok(ref, stdout);
  await cli('fill', short, ref, 'Lisbon');
  assert.equal(await ops.evaluate(conn, id, 'document.querySelector("[name=q]").value'), 'Lisbon');
  await cli('click', short, '#seats');
  assert.equal(await ops.evaluate(conn, id, 'seats.getAttribute("aria-expanded")'), 'true');
  await cli('fill', short, '#checkin', '2026-11-01');
  assert.equal(await ops.evaluate(conn, id, 'checkin.value'), '2026-11-01');
  await assert.rejects(cli('click', short, 'Add to bag'), /not a ref .* or a CSS selector[\s\S]*do .* 'click "Add to bag"'/);
  await assert.rejects(cli('click', short, 'i140'), /item id from `items`/);
});

t('refs from read keep meaning what it saw after another read; fill follows a label and names the nearest field', async () => {
  const id = await open('slice-controls.html');
  const short = id.slice(0, 8);
  const { stdout } = await cli('read', short);
  const dest = /^\s*\*?(ref_\d+)\s+e\d+\s+textbox\s+Destination/m.exec(stdout)[1];
  // A newer snapshot (as do or --intent take) with an element added at the top shifts every ref.
  await ops.evaluate(conn, id, 'document.body.insertAdjacentHTML("afterbegin", "<button>New banner</button><input aria-label=Coupon>")');
  await ops.readPage(conn, id);
  await cli('fill', short, dest, 'Porto');
  assert.equal(await ops.evaluate(conn, id, 'document.querySelector("[name=q]").value'), 'Porto');
  assert.equal(await ops.evaluate(conn, id, 'document.querySelector("[aria-label=Coupon]").value'), '');
  // A label wrapping its input fills the input; a span is not a field.
  await ops.fill(conn, id, { selector: '#wrap', value: '2026-12-24' });
  assert.equal(await ops.evaluate(conn, id, 'checkin.value'), '2026-12-24');
  const snap = await ops.readPage(conn, id);
  await assert.rejects(ops.fill(conn, id, { selector: '#hint', value: 'x' }), /#hint is a <span> "Where to\?", not a field you can type into\. Nearest field: ref_\d+ \(Destination\)/);
  void snap;
});

t('the CLI takes positional coordinates, any selector the page accepts, and a browser from the environment', async () => {
  const id = await open('slice-r1.html?acc');
  const tab = id.slice(0, 8);
  const xy = JSON.parse((await cliEnv(['click', tab, '5', '5', '--port', String(TEST_PORT)])).stdout);
  assert.deepEqual([xy.clicked.x, xy.clicked.y], [5, 5]);
  const sel = await cliEnv(['click', tab, 'x-acc:nth-of-type(1) h2', '--port', String(TEST_PORT)]);
  assert.match(sel.stdout, /"clicked"/);
  const env = await cliEnv(['tabs'], { BROWSERCTRL_PORT: String(TEST_PORT) });
  assert.match(env.stdout, new RegExp(tab));
  await ops.closeTab(conn, id);
});

t('find names hidden matches and their opener; fields lists what the form holds', async () => {
  const id = await open('steps-friction5.html');
  const f = await ops.evaluate(conn, id, finder.FIND('middle income'));
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].hidden, 'in a hidden section');
  assert.equal(f.rows[0].opens_with.name, 'Salary');
  assert.match(finder.formatFind(f, 'middle income'), /opens with button "Salary"/);
  const fl = await ops.evaluate(conn, id, finder.FIELDS());
  const text = finder.formatFields(fl);
  assert.match(text, /checkbox\s+"Spa \(3\)"\s+= "checked"/);
  assert.match(text, /select\s+"State"\s+= "ID"/);
  assert.match(text, /1 unticked box/);
  await ops.closeTab(conn, id);
});

test('the drill-down takes the main list in order and skips ads', () => {
  assert.deepEqual(mainLinks(page, 2, page.url), ['https://x.io/p/b', 'https://x.io/p/d']);
});

test('the lean view shows the main list in full and folds the rest; grep filters items', () => {
  const lean = formatItems(page, { main: true });
  assert.match(lean, /Chair B/);
  assert.match(lean, /Related one \| Related two .*--group g3/);
  const only = formatItems(page, { grep: 'S\\$40' });
  assert.match(only, /Chair D/);
  assert.doesNotMatch(only, /Chair B/);
});

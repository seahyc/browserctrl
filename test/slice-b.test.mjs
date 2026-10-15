// Friction found by the Online-Mind2Web round 1 runs, on offline fixtures:
// read waits for a loading page; an open dropdown rendered outside its dialog is the
// active layer; icon-only stepper buttons get names from their row; a custom checkbox is
// not "covered" by its own input; an expanded accordion's options lead items; click and
// fill take natural positional targets; refs keep meaning what their read saw; fill
// follows a label to its field and names the nearest field otherwise; a page that stopped
// answering says why (a JavaScript dialog, a stuck main thread) and what to run.
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
import { formatRead } from '../lib/refs.mjs';
import { itemsExpression, formatItems } from '../lib/items.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

process.env.CDP_AGENT_ID = 'test-slice-b';
process.env.BROWSERCTRL_NOTIFY = '0';
process.env.BROWSERCTRL_READ_TOKENS = path.join(os.tmpdir(), `browserctrl-test-read-tokens-${process.pid}.json`);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = (...args) => promisify(execFile)(process.execPath, [path.join(ROOT, 'bin/browserctrl.mjs'), ...args, '--port', String(TEST_PORT)], { env: process.env, timeout: 90000 });

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
  fs.rmSync(process.env.BROWSERCTRL_READ_TOKENS, { force: true });
});

const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
const open = async (page) => {
  const id = (await ops.newTab(conn, fixture.url + 'fixtures/' + page)).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  return id;
};
const rowOf = (snap, re) => snap.elements.find(e => re.test(e.name || ''));

t('read waits for a loading page to fill in, and says how long it waited', async () => {
  const id = await open('slice-loading.html');
  const { stdout } = await cli('read', id.slice(0, 8));
  assert.match(stdout, /^wait: waited \d+\.\d s for the page to finish loading$/m, stdout);
  assert.match(stdout, /Condo B · \$2,100/);
  assert.doesNotMatch(stdout, /^loading:.*skeleton/m);
  const quick = await cli('read', id.slice(0, 8));
  assert.doesNotMatch(quick.stdout, /^wait:/m, 'a loaded page is read at once');
});

t('a page whose loading markers never change is read once they hold still; --no-wait reads at once', async () => {
  const id = await open('read-skeleton.html');
  const t0 = Date.now();
  const { stdout } = await cli('read', id.slice(0, 8));
  assert.ok(Date.now() - t0 < 8000, 'did not wait the full 8 s');
  assert.match(stdout, /^wait: waited .* stopped changing, so the page is read as loaded$/m, stdout);
  const st = await ops.settle(conn, id, { timeoutMs: 600, stableMs: 5000 });
  assert.equal(st.cleared, false);
  assert.match(ops.describeSettle(st), /still loading .*skeleton/);
  const raw = await cli('read', id.slice(0, 8), '--no-wait');
  assert.doesNotMatch(raw.stdout, /^wait:/m);
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

t('a page waiting on a JavaScript dialog says so and how to answer it; dialog answers it', async () => {
  const id = await open('slice-controls.html');
  const t0 = Date.now();
  const clicked = await ops.click(conn, id, { selector: '#alerter' });
  assert.ok(Date.now() - t0 < 5000, `the click returned when the dialog opened (${Date.now() - t0} ms)`);
  assert.equal(clicked.dialog?.message, 'Are you sure?');
  assert.match(clicked.next, /browserctrl dialog \w{8} --accept/);
  await assert.rejects(ops.evaluate(conn, id, 'document.title', { timeoutMs: 1500 }),
    /timed out after 1500ms .*JavaScript alert dialog: "Are you sure\?"[\s\S]*browserctrl dialog \w{8} --accept/);
  const { stdout } = await cli('dialog', id.slice(0, 8), '--accept');
  assert.match(stdout, /"answered": "accept"/);
  assert.match(stdout, /Are you sure\?/);
  assert.equal(await ops.evaluate(conn, id, 'document.title', { timeoutMs: 5000 }), 'Steppers, custom checkboxes and accordions');
});

t('a stuck main thread is diagnosed with the command to run', async () => {
  const id = await open('slice-controls.html');
  // A long task started from a timer, as a heavy page script runs (not inside our own input event).
  // Background tabs can align timers to 1 s, so wait until the task has really started.
  await ops.evaluate(conn, id, 'window.__busyFrom = 0; setTimeout(function () { window.__busyFrom = Date.now(); var t = Date.now(); while (Date.now() - t < 15000) {} }, 0); 1');
  for (let i = 0; i < 40; i++) {
    const started = await ops.evaluate(conn, id, 'window.__busyFrom', { timeoutMs: 400 }).catch(() => 'blocked');
    if (started === 'blocked' || started > 0) break;
    await new Promise(r => setTimeout(r, 100));
  }
  await assert.rejects(ops.evaluate(conn, id, 'document.title', { timeoutMs: 1500 }), e => {
    assert.match(e.message, /outcome is uncertain[\s\S]*not responding: its main thread has been stuck[\s\S]*browserctrl reload \w{8}/);
    assert.equal(e.diagnosis.kind, 'hung');
    return true;
  });
  await ops.closeTab(conn, id).catch(() => {});
});

t('a read that times out while the page is briefly busy runs again once it answers', async () => {
  const id = await open('slice-controls.html');
  await ops.evaluate(conn, id, 'window.__busyFrom = 0; setTimeout(function () { window.__busyFrom = Date.now(); var t = Date.now(); while (Date.now() - t < 4000) {} }, 0); 1');
  const t0 = Date.now();
  const r = await ops.evaluate(conn, id, '({ title: document.title, busyFrom: window.__busyFrom })', { timeoutMs: 1000, retry: true });
  assert.equal(r.title, 'Steppers, custom checkboxes and accordions');
  assert.ok(r.busyFrom > 0, 'the busy task ran before the read');
  assert.ok(Date.now() - t0 >= 1000, `the read was blocked (took ${Date.now() - t0} ms), so it timed out and ran again`);
});

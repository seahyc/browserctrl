// Notes inside do (reveal, on and URL notes, confirmed or contradicted) and the per-tab run
// trace with the hints it prints.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import * as trace from '../lib/trace.mjs';
import * as notes from '../lib/notes.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { planJev, scenarioJev } from './fake-jev.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-memo-'));
const NOTES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-notes-'));
process.env.CDP_AGENT_ID = 'test-do-notes';
process.env.BROWSERCTRL_NOTIFY = '0';
process.env.BROWSERCTRL_TRACES = TRACES;
process.env.BROWSERCTRL_NOTES_DIR = NOTES;
process.env.BROWSERCTRL_NOTES = 'on';
process.env.BROWSERCTRL_READ_TOKENS = path.join(MEMO, 'read-tokens.json');
process.env.BROWSERCTRL_SETTLE_MEMORY = path.join(MEMO, 'never.json');
process.env.BROWSERCTRL_SITE_TROUBLE = path.join(MEMO, 'trouble.json');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERE = path.dirname(fileURLToPath(import.meta.url));

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
  fs.rmSync(NOTES, { recursive: true, force: true });
});
const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
const url = (page) => fixture.url + 'fixtures/' + page;
const open = async (page, waitUntil = 'load') => {
  const id = (await ops.newTab(conn, url(page))).targetId;
  await ops.waitForReady(conn, id, { waitUntil });
  return id;
};
const text = (id, sel) => ops.evaluate(conn, id, `document.querySelector(${JSON.stringify(sel)}).textContent`);

t('a reveal note whose first step is already done still runs the rest and is confirmed', async () => {
  const n = await notes.add(url('steps-friction3.html'), 'Gym is under Search all filters in the Filters dialog', { force: true, reveal: { target: 'Gym', steps: ['click "Filters"', 'click "Search all filters"'] } });
  assert.equal(n.ok, true, n.reason);
  const id = await open('steps-friction3.html?filters=open');
  const r = await runSteps(conn, id, ['click Gym'], { jev: planJev({ Gym: [/^Gym$/, 0.9] }, { blocks: false }) });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(await text(id, '#gymmed'), 'gym on');
  assert.deepEqual(r.notes_applied, [{ id: n.id, ok: true }]);
  assert.equal(notes.show('127.0.0.1').facts.find(f => f.id === n.id).count, 2);
  notes.clear('127.0.0.1');
  await ops.closeTab(conn, id);
});

t('a reveal note whose steps cannot run at all is neither confirmed nor contradicted', async () => {
  const n = await notes.add(url('steps-friction3.html'), 'Gym hides behind a Spa toggle', { force: true, reveal: { target: 'Gym', steps: ['click "Spa toggle"'] } });
  const id = await open('steps-friction3.html');
  const r = await runSteps(conn, id, ['click Gym'], { jev: planJev({ Gym: [/^Gym$/, 0.9] }) });
  assert.equal(r.done, false);
  assert.deepEqual(r.notes_applied || [], []);
  assert.equal(notes.show('127.0.0.1').facts.find(f => f.id === n.id).count, 1);
  notes.clear('127.0.0.1');
  await ops.closeTab(conn, id);
});

// Notes act inside do: a reveal note brings out a hidden target, an on note handles a
// situation Jev sees, the page's notes ride along as context, and the notes that ran are
// confirmed or contradicted.
t('a reveal note brings out a hidden target, then do confirms it', async () => {
  const shop = fixture.url + 'fixtures/steps-shop.html';
  const n = await notes.add(shop, 'The Maximum price box sits inside More filters', { force: true, reveal: { target: 'Maximum', steps: ['click "More filters"'] } });
  assert.equal(n.ok, true, n.reason);
  const ctx = await notes.add(shop, 'Search submits on Enter', { force: true });
  const id = await open('steps-shop.html');
  const jev = scenarioJev({ targets: { Maximum: /^Maximum$/ } });
  const r = await runSteps(conn, id, ['fill Search = aeron', 'key Enter', 'fill Maximum = 600'], { jev: jev });
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  const step3 = r.steps[2];
  assert.match(step3.how, new RegExp(`via note ${n.id}`));
  assert.deepEqual(step3.via_notes, [{ id: n.id, kind: 'reveal', ok: true }]);
  assert.deepEqual(r.notes_applied, [{ id: n.id, ok: true }]);
  // The page's notes went to Jev as context with the grounding request.
  assert.ok(jev.calls.some(c => c.state.site_notes?.some(x => /Search submits on Enter/.test(x))), JSON.stringify(jev.calls[0]?.state).slice(0, 400));
  const out = formatSteps(r);
  console.log(out);
  assert.match(out, new RegExp(`via note ${n.id} \\(reveal\\): click "More filters"`));
  assert.match(out, new RegExp(`notes: ${n.id} confirmed`));
  const stored = notes.show('127.0.0.1').facts.find(f => f.id === n.id);
  assert.equal(stored.count, 2);
  assert.ok(notes.show('127.0.0.1').facts.find(f => f.id === ctx.id).count === 1, 'context-only notes are not confirmed');
  notes.clear('127.0.0.1');
  await ops.closeTab(conn, id);
});

t('a reveal note that does not bring the target out is contradicted', async () => {
  const shop = fixture.url + 'fixtures/steps-shop.html';
  const n = await notes.add(shop, 'Maximum appears after Search', { force: true, reveal: { target: 'Maximum', steps: ['click Search'] } });
  const id = await open('steps-shop.html');
  const r = await runSteps(conn, id, ['fill Maximum = 600'], { jev: scenarioJev({ targets: { Maximum: /^Maximum$/ } }) });
  // The step may still find Maximum by opening the section that holds it; the note is wrong
  // either way.
  assert.deepEqual(r.notes_applied, [{ id: n.id, ok: false }]);
  // Worked once (when added), failed once: dropped.
  assert.equal(notes.show('127.0.0.1').facts.find(f => f.id === n.id), undefined);
  notes.clear('127.0.0.1');
  await ops.closeTab(conn, id);
});

t('an on note handles the situation Jev sees and the plan carries on', async () => {
  const shop = fixture.url + 'fixtures/steps-shop.html';
  const n = await notes.add(shop, 'A cookie popup covers the shop on first visit', { force: true, on: { situation: 'a cookie consent popup covers the page', steps: ['click "Accept cookies"'] } });
  const id = await open('steps-shop.html?overlay=cookie');
  const jev = scenarioJev({ nouls: { 'a cookie consent popup': text => /We use cookies/.test(text) } });
  // No --dismiss: without the note this plan would stop at the popup.
  const r = await runSteps(conn, id, ['fill Search = aeron', 'key Enter'], { jev: jev });
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(await ops.evaluate(conn, id, 'window.clicked'), ['accept']);
  assert.deepEqual(r.steps[0].via_notes, [{ id: n.id, kind: 'on', ok: true }]);
  assert.ok(r.events.some(e => e.type === 'note' && e.id === n.id && e.ok));
  assert.deepEqual(r.notes_applied, [{ id: n.id, ok: true }]);
  console.log(formatSteps(r));
  assert.equal(notes.show('127.0.0.1').facts.find(f => f.id === n.id).count, 2);
  notes.clear('127.0.0.1');
  await ops.closeTab(conn, id);
});

t('a URL note that covers a planned click is suggested, the plan untouched', async () => {
  const id = await open('steps-shop.html');
  const url = await ops.evaluate(conn, id, 'location.href');
  notes.record([{ site: '127.0.0.1', key: `url ${notes.pathTemplate(url)} more filters`, kind: 'url', path: notes.pathTemplate(url), ok: true,
    text: `on ${notes.pathTemplate(url)}, click "More filters" sets ?panel=open in the URL; nav to it directly` }]);
  const r = await runSteps(conn, id, ['click "More filters"'], { jev: scenarioJev() });
  assert.equal(r.done, true);
  assert.equal(r.suggestions?.length, 1);
  assert.match(formatSteps(r), /note \w{5}: on .*click "More filters" sets \?panel=open/);
  const r2 = await runSteps(conn, id, ['click "More filters"'], { jev: scenarioJev(), noNotes: true });
  assert.equal(r2.suggestions, undefined);
  notes.clear('127.0.0.1');
  await ops.closeTab(conn, id);
});

t('every run is traced per tab and `trace` prints it', async () => {
  const id = await open('steps-shop.html?overlay=cookie');
  const jev = scenarioJev({ category: 'cookie banner', nouls: { 'the panel is open': text => /Maximum/.test(text) } });
  const r = await runSteps(conn, id, ['click "More filters" => "the panel is open"', 'fill Maximum = 600', 'click Apply'], { jev: jev, dismiss: 'cookie banner' });
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.ok(r.trace.startsWith(TRACES));
  const runs = trace.read(id.slice(0, 8), { last: 1 });
  assert.equal(runs.length, 1);
  const [first] = runs[0].steps;
  assert.equal(first.action, 'click');
  assert.deepEqual(first.target.name, 'More filters');
  assert.equal(first.how, 'exact, dismissed cookie banner before retrying');
  assert.equal(first.expect, 'the panel is open');
  assert.equal(first.expect_p, 0.93);
  assert.equal(first.dismissed[0].category, 'cookie banner');
  assert.ok(first.url_before && first.url_after && first.settle_ms >= 0);
  assert.deepEqual(runs[0].steps[2].events, [{ text: 'Price changed to S$590' }]);
  assert.equal(runs[0].summary.done, true);
  const cli = execFileSync(process.execPath, [path.join(HERE, '..', 'bin', 'browserctrl.mjs'), 'trace', id.slice(0, 8), '--last', '1'], { env: { ...process.env, BROWSERCTRL_TRACES: TRACES }, encoding: 'utf8' });
  console.log(cli);
  assert.match(cli, /run \w+ {2}done/);
  assert.match(cli, /✓ 1\. click "More filters" => "the panel is open" {2}→ button "More filters" ref_\d+ {2}\(exact, dismissed cookie banner before retrying\) {2}expect "the panel is open" p=0\.93/);
  assert.match(cli, /dismissed cookie banner: "We use cookies/);
  assert.match(cli, /notice: "Price changed to S\$590"/);
  const json = JSON.parse(execFileSync(process.execPath, [path.join(HERE, '..', 'bin', 'browserctrl.mjs'), 'trace', id.slice(0, 8), '--json'], { env: { ...process.env, BROWSERCTRL_TRACES: TRACES }, encoding: 'utf8' }));
  assert.equal(json.at(-1).steps.length, 3);
  // Flows, Enter submits and overlays are no longer written by rule; agents write notes.
  assert.ok(!notes.show('127.0.0.1').facts.some(f => ['overlay', 'flow', 'enter'].includes(f.kind)));
  // A step that lands on a kind of page not yet hinted in the run prints that page's notes.
  const form = fixture.url + 'fixtures/steps-form.html';
  const added = await notes.add(form, 'The form keeps its fields after a failed submit', { force: true });
  const r4 = await runSteps(conn, id, [`nav ${form}`], { jev: scenarioJev() });
  assert.equal(r4.done, true, JSON.stringify(r4.stopped));
  assert.ok(r4.steps[0].hints?.some(h => h.includes(added.id)), JSON.stringify(r4.steps[0]));
  assert.match(formatSteps(r4), new RegExp(`hint: +${added.id} The form keeps its fields`));
  const r5 = await runSteps(conn, id, [`nav ${form}?again=1`], { jev: scenarioJev(), noNotes: true });
  assert.equal(r5.steps[0].hints, undefined);
  notes.clear('127.0.0.1');
  await ops.closeTab(conn, id);
});

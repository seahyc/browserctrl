// do v2: expected results ride along with the next grounding request, optional steps,
// listed overlays dismissed, notices recorded, pagination loops and traces. Jev is a
// deterministic fake: no request leaves the machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import * as trace from '../lib/trace.mjs';
import * as notes from '../lib/notes.mjs';
import { parseStep, runSteps, formatSteps } from '../lib/steps.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
process.env.BROWSERCTRL_TRACES = TRACES;

// A fake System One. `targets` maps an intent to a pattern for the element name it should
// pick; `nouls` maps text found in a noul's instructions to a test over the state; a
// blocker is true whenever the state shows an overlay; `category` names the overlay kind;
// for a closing control the fake reaches for "subscribe" first, to prove it is never offered.
function fakeJev({ targets = {}, nouls = {}, category = null } = {}) {
  const calls = [];
  const choose = (q, key) => {
    const keys = Object.keys(q.criteria);
    const probabilities = Object.fromEntries(keys.map(k => [k, k === key ? 0.94 : 0.06 / (keys.length - 1)]));
    return { type: 'choice', choice: key, probabilities, confidence: 0.9 };
  };
  const byName = (q, re) => Object.keys(q.criteria).find(k => k !== 'none' && re.test(q.criteria[k].name || '')) || 'none';
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const text = JSON.stringify(body.state);
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      if (q.type === 'noul') {
        const rule = id !== 'blocker' && Object.entries(nouls).find(([k]) => q.instructions.includes(k));
        const yes = rule ? rule[1](text, body.state) : id === 'blocker' ? Boolean(body.state.page?.overlay) : false;
        answers[id] = { type: 'noul', noul: yes ? 0.93 : 0.04 };
      } else if (id === 'target') {
        const intent = Object.keys(targets).find(k => q.instructions.includes(`"${k}"`));
        answers[id] = choose(q, intent ? byName(q, targets[intent]) : 'none');
      } else if (id === 'category') {
        answers[id] = choose(q, Object.keys(q.criteria).find(k => q.criteria[k] === category) || 'other');
      } else if (id === 'control') {
        const sub = byName(q, /subscribe|buy/i);
        answers[id] = choose(q, sub !== 'none' ? sub : byName(q, /accept|close|no thanks|not now/i));
      }
    }
    return { ok: true, status: 200, json: async () => ({ answers, model: 'fake' }) };
  };
  return { calls, opts: { cfg: { key: 'fake', model: 'fake' }, fetchImpl } };
}

test('steps parse optional and expected results', () => {
  assert.deepEqual(parseStep('click Apply => "results are filtered"'), { action: 'click', target: 'Apply', expect: 'results are filtered' });
  assert.deepEqual(parseStep('optional click "Close"'), { action: 'click', target: 'Close', optional: true });
  assert.deepEqual(parseStep('fill "q" = "a => b"'), { action: 'fill', target: 'q', value: 'a => b' });
  assert.deepEqual(parseStep("click Men's shoes => 'shoes are listed'"), { action: 'click', target: "Men's shoes", expect: 'shoes are listed' });
  assert.throws(() => parseStep('click Apply =>'), /expected result/);
});

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
});
const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
const open = async (page) => {
  const id = (await ops.newTab(conn, fixture.url + 'fixtures/' + page)).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  return id;
};
const filtered = (text) => /Aeron A/.test(text) && !/Aeron C/.test(text);

t('an expected result is checked in the same request that grounds the next step', async () => {
  const id = await open('steps-shop.html');
  const jev = fakeJev({
    targets: { 'the maximum price box': /^Maximum$/ },
    nouls: { 'the Maximum box is shown': text => /Maximum/.test(text), 'results are filtered': filtered },
  });
  const r = await runSteps(conn, id, [
    'fill Search = aeron', 'key Enter',
    'click "More filters" => "the Maximum box is shown"',
    'fill "the maximum price box" = 600',
    'click Apply => "results are filtered"',
  ], { jev: jev.opts });
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  // Step 4 needs Jev; the request that grounds it also checks step 3's expectation.
  // The last expectation rides with the final page checks: two requests in all.
  assert.equal(jev.calls.length, 2);
  assert.equal(r.jev_calls, 2);
  assert.deepEqual(Object.keys(jev.calls[0].questions).sort(), ['prev_expect', 'target']);
  assert.match(jev.calls[0].questions.prev_expect.instructions, /the Maximum box is shown/);
  assert.ok(jev.calls[1].questions.prev_expect && jev.calls[1].questions.challenge);
  assert.equal(r.steps[2].expect_p, 0.93);
  assert.equal(r.steps[4].expect_p, 0.93);
  assert.equal(r.steps[3].how, 'jev p=0.94');
  console.log(JSON.stringify(jev.calls[0], null, 1).slice(0, 1600));
  await ops.closeTab(conn, id);
});

t('a false expectation stops at its step before the next step runs', async () => {
  const id = await open('steps-shop.html');
  const jev = fakeJev({ targets: { 'the maximum price box': /^Maximum$/ }, nouls: { 'results are filtered': () => false } });
  const r = await runSteps(conn, id, [
    'fill Search = aeron', 'key Enter => "results are filtered"', 'click "More filters"', 'fill "the maximum price box" = 600',
  ], { jev: jev.opts });
  assert.equal(r.done, false);
  assert.equal(r.stopped.step, 2);
  assert.match(r.stopped.reason, /expected "results are filtered"/);
  assert.equal(r.steps.length, 2, 'step 3 never ran');
  assert.equal(r.steps[1].stopped, true);
  assert.equal(await ops.evaluate(conn, id, 'document.getElementById("panel").hidden'), true);
  assert.match(formatSteps(r), /Stopped at step 2/);
  // The last step's expectation is judged in the final request.
  const j2 = fakeJev({ nouls: { 'results are filtered': () => false } });
  const r2 = await runSteps(conn, id, ['click "More filters" => "results are filtered"'], { jev: j2.opts });
  assert.equal(r2.stopped.step, 1);
  assert.equal(j2.calls.length, 1);
  await ops.closeTab(conn, id);
});

t('an optional step that finds nothing is skipped and recorded', async () => {
  const id = await open('steps-shop.html');
  const jev = fakeJev();
  const r = await runSteps(conn, id, ['optional click "the close button of the welcome popup"', 'click "More filters"'], { jev: jev.opts });
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(r.steps[0].skipped, /no element/i);
  assert.equal(r.steps[1].how, 'exact');
  assert.match(formatSteps(r), /– 1\. optional click/);
  await ops.closeTab(conn, id);
});

t('a listed cookie banner is dismissed and recorded; unlisted it stops the plan', async () => {
  let id = await open('steps-shop.html?overlay=cookie');
  let jev = fakeJev({ category: 'cookie banner' });
  let r = await runSteps(conn, id, ['click "More filters"'], { jev: jev.opts, dismiss: 'cookie banner, app-install prompt' });
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(await ops.evaluate(conn, id, 'window.clicked'), ['accept']);
  assert.equal(await ops.evaluate(conn, id, 'document.getElementById("panel").hidden'), false);
  const d = r.events.find(e => e.type === 'dismissed');
  assert.equal(d.category, 'cookie banner');
  assert.match(d.text, /We use cookies/);
  assert.equal(d.control, 'button "Accept cookies"');
  assert.equal(d.after_step, 0);
  // The category question and the closing control come back from one request; the
  // privacy link is not offered.
  const ask = jev.calls.find(c => c.questions.category);
  assert.ok(ask.questions.control);
  assert.ok(!Object.values(ask.questions.control.criteria).some(c => /Privacy/.test(c.name || '')));
  await ops.closeTab(conn, id);

  id = await open('steps-shop.html?overlay=cookie');
  jev = fakeJev({ category: 'cookie banner' });
  r = await runSteps(conn, id, ['click "More filters"'], { jev: jev.opts, dismiss: 'app-install prompt' });
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /not one of the listed kinds/);
  assert.match(r.stopped.overlay, /We use cookies/);
  assert.ok(r.stopped.controls.includes('button "Accept cookies"'));
  assert.deepEqual(await ops.evaluate(conn, id, 'window.clicked'), []);

  // Without --dismiss the same banner stops the plan too, with no extra request.
  jev = fakeJev();
  r = await runSteps(conn, id, ['click "More filters"'], { jev: jev.opts });
  assert.match(r.stopped.reason, /blocking the page/);
  assert.match(formatSteps(r), /Overlay: "We use cookies/);
  await ops.closeTab(conn, id);
});

t('an overlay control that subscribes or buys is never clicked', async () => {
  let id = await open('steps-shop.html?overlay=newsletter');
  let jev = fakeJev({ category: 'newsletter popup' });
  let r = await runSteps(conn, id, ['click "More filters"'], { jev: jev.opts, dismiss: 'newsletter popup' });
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(await ops.evaluate(conn, id, 'window.clicked'), ['nothanks']);
  assert.equal(r.events[0].control, 'button "No thanks"');
  await ops.closeTab(conn, id);

  id = await open('steps-shop.html?overlay=subscribe');
  jev = fakeJev({ category: 'promotion popup' });
  r = await runSteps(conn, id, ['click "More filters"'], { jev: jev.opts, dismiss: 'newsletter popup, promotion popup' });
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /no safe control closes it/);
  assert.deepEqual(await ops.evaluate(conn, id, 'window.clicked'), []);
  assert.ok(!jev.calls.some(c => c.questions.control), 'Subscribe and Buy are never offered as closing controls');
  await ops.closeTab(conn, id);
});

t('a non-blocking toast is recorded as an event and not acted on', async () => {
  const id = await open('steps-shop.html');
  const jev = fakeJev();
  const r = await runSteps(conn, id, ['fill Search = aeron', 'key Enter', 'click "More filters"', 'fill Maximum = 600', 'click Apply'], { jev: jev.opts, dismiss: 'cookie banner' });
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  const n = r.events.filter(e => e.type === 'notice');
  assert.deepEqual(n.map(e => [e.after_step, e.text]), [[5, 'Price changed to S$590']]);
  assert.ok(!r.events.some(e => e.type === 'dismissed'));
  assert.equal(jev.calls.length, 1, 'only the final page check: the toast is not an overlay');
  assert.match(formatSteps(r), /notice after step 5: "Price changed to S\$590"/);
  await ops.closeTab(conn, id);
});

t('--repeat clicks Next until the condition holds and collects de-duplicated items', async () => {
  const id = await open('steps-pages.html?p=1');
  const jev = fakeJev({ nouls: { 'this is the last page': text => /Page 3 of 3/.test(text) } });
  const r = await runSteps(conn, id, [], { jev: jev.opts, repeat: 'click Next', until: 'this is the last page', collect: 'items' });
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(r.loop.pages, 3);
  assert.match(r.loop.ended, /until/);
  // One request per page: the until check rides with grounding (Next is an exact name).
  assert.equal(jev.calls.filter(c => c.questions.until).length, 3);
  const texts = r.collected.groups.flatMap(g => g.items.map(i => i.text));
  assert.equal(texts.filter(x => /Featured/.test(x)).length, 1);
  for (let n = 1; n <= 9; n++) assert.ok(texts.some(x => x.startsWith(`Chair ${n} `)), `Chair ${n} collected`);
  assert.equal(r.collected.duplicates, 2);
  assert.equal(r.page.url.endsWith('p=3'), true);
  assert.match(formatSteps(r), /collected 10 items over 3 pages \(2 duplicates dropped\)/);

  // Without a reachable condition the loop ends when Next is gone, and --max bounds it.
  await ops.navigate(conn, id, fixture.url + 'fixtures/steps-pages.html?p=1');
  const r2 = await runSteps(conn, id, [], { jev: fakeJev().opts, repeat: 'click Next', until: 'never true', collect: 'items' });
  assert.equal(r2.done, true);
  assert.equal(r2.loop.pages, 3);
  assert.match(r2.loop.ended, /could not be done/);
  await ops.navigate(conn, id, fixture.url + 'fixtures/steps-pages.html?p=1');
  const r3 = await runSteps(conn, id, [], { jev: fakeJev().opts, repeat: 'click Next', until: 'never true', max: 1, collect: 'text' });
  assert.equal(r3.loop.pages, 2);
  assert.match(r3.collected.text, /Page 2 of 3/);
  await ops.closeTab(conn, id);
});

t('every run is traced per tab and `trace` prints it', async () => {
  const id = await open('steps-shop.html?overlay=cookie');
  const jev = fakeJev({ category: 'cookie banner', nouls: { 'the panel is open': text => /Maximum/.test(text) } });
  const r = await runSteps(conn, id, ['click "More filters" => "the panel is open"', 'fill Maximum = 600', 'click Apply'], { jev: jev.opts, dismiss: 'cookie banner' });
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.ok(r.trace.startsWith(TRACES));
  const runs = trace.read(id.slice(0, 8), { last: 1 });
  assert.equal(runs.length, 1);
  const [first] = runs[0].steps;
  assert.equal(first.action, 'click');
  assert.deepEqual(first.target.name, 'More filters');
  assert.equal(first.how, 'exact');
  assert.equal(first.expect, 'the panel is open');
  assert.equal(first.expect_p, 0.93);
  assert.equal(first.dismissed[0].category, 'cookie banner');
  assert.ok(first.url_before && first.url_after && first.settle_ms >= 0);
  assert.deepEqual(runs[0].steps[2].events, [{ text: 'Price changed to S$590' }]);
  assert.equal(runs[0].summary.done, true);
  const cli = execFileSync(process.execPath, [path.join(HERE, '..', 'bin', 'browserctrl.mjs'), 'trace', id.slice(0, 8), '--last', '1'], { env: { ...process.env, BROWSERCTRL_TRACES: TRACES }, encoding: 'utf8' });
  console.log(cli);
  assert.match(cli, /run \w+ {2}done/);
  assert.match(cli, /✓ 1\. click "More filters" => "the panel is open" {2}→ button "More filters" ref_\d+ {2}\(exact\) {2}expect "the panel is open" p=0\.93/);
  assert.match(cli, /dismissed cookie banner: "We use cookies/);
  assert.match(cli, /notice: "Price changed to S\$590"/);
  const json = JSON.parse(execFileSync(process.execPath, [path.join(HERE, '..', 'bin', 'browserctrl.mjs'), 'trace', id.slice(0, 8), '--json'], { env: { ...process.env, BROWSERCTRL_TRACES: TRACES }, encoding: 'utf8' }));
  assert.equal(json.at(-1).steps.length, 3);
  // Flows, Enter submits and overlays are no longer written by rule; agents write notes.
  assert.ok(!notes.show('127.0.0.1').facts.some(f => ['overlay', 'flow', 'enter'].includes(f.kind)));
  // A step that lands on a kind of page not yet hinted in the run prints that page's notes.
  const form = fixture.url + 'fixtures/steps-form.html';
  const added = await notes.add(form, 'The form keeps its fields after a failed submit', { force: true });
  const r4 = await runSteps(conn, id, [`nav ${form}`], { jev: fakeJev().opts });
  assert.equal(r4.done, true, JSON.stringify(r4.stopped));
  assert.ok(r4.steps[0].hints?.some(h => h.includes(added.id)), JSON.stringify(r4.steps[0]));
  assert.match(formatSteps(r4), new RegExp(`hint: +${added.id} The form keeps its fields`));
  const r5 = await runSteps(conn, id, [`nav ${form}?again=1`], { jev: fakeJev().opts, noNotes: true });
  assert.equal(r5.steps[0].hints, undefined);
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
  const jev = fakeJev({ targets: { Maximum: /^Maximum$/ } });
  const r = await runSteps(conn, id, ['fill Search = aeron', 'key Enter', 'fill Maximum = 600'], { jev: jev.opts });
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
  const r = await runSteps(conn, id, ['fill Maximum = 600'], { jev: fakeJev({ targets: { Maximum: /^Maximum$/ } }).opts });
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
  const jev = fakeJev({ nouls: { 'a cookie consent popup': text => /We use cookies/.test(text) } });
  // No --dismiss: without the note this plan would stop at the popup.
  const r = await runSteps(conn, id, ['fill Search = aeron', 'key Enter'], { jev: jev.opts });
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
  const r = await runSteps(conn, id, ['click "More filters"'], { jev: fakeJev().opts });
  assert.equal(r.done, true);
  assert.equal(r.suggestions?.length, 1);
  assert.match(formatSteps(r), /note \w{5}: on .*click "More filters" sets \?panel=open/);
  const r2 = await runSteps(conn, id, ['click "More filters"'], { jev: fakeJev().opts, noNotes: true });
  assert.equal(r2.suggestions, undefined);
  notes.clear('127.0.0.1');
  await ops.closeTab(conn, id);
});

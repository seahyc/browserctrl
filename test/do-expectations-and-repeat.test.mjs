// Plan control: expected results checked with the next grounding request, optional steps, and
// --repeat/--until/--collect loops.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { parseStep, runSteps, formatSteps } from '../lib/steps.mjs';
import { scenarioJev } from './fake-jev.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-memo-'));
process.env.CDP_AGENT_ID = 'test-do-expectations-and-repeat';
process.env.BROWSERCTRL_NOTIFY = '0';
process.env.BROWSERCTRL_TRACES = TRACES;
process.env.BROWSERCTRL_NOTES = 'off';
process.env.BROWSERCTRL_READ_TOKENS = path.join(MEMO, 'read-tokens.json');
process.env.BROWSERCTRL_SETTLE_MEMORY = path.join(MEMO, 'never.json');
process.env.BROWSERCTRL_SITE_TROUBLE = path.join(MEMO, 'trouble.json');

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
const filtered = (text) => /Aeron A/.test(text) && !/Aeron C/.test(text);

test('steps parse optional and expected results', () => {
  assert.deepEqual(parseStep('click Apply => "results are filtered"'), { action: 'click', target: 'Apply', expect: 'results are filtered' });
  assert.deepEqual(parseStep('optional click "Close"'), { action: 'click', target: 'Close', optional: true });
  assert.deepEqual(parseStep('fill "q" = "a => b"'), { action: 'fill', target: 'q', value: 'a => b' });
  assert.deepEqual(parseStep("click Men's shoes => 'shoes are listed'"), { action: 'click', target: "Men's shoes", expect: 'shoes are listed' });
  assert.throws(() => parseStep('click Apply =>'), /expected result/);
});

t('an expected result is checked in the same request that grounds the next step', async () => {
  const id = await open('steps-shop.html');
  const jev = scenarioJev({
    targets: { 'the maximum price box': /^Maximum$/ },
    nouls: { 'the Maximum box is shown': text => /Maximum/.test(text), 'results are filtered': filtered },
  });
  const r = await runSteps(conn, id, [
    'fill Search = aeron', 'key Enter',
    'click "More filters" => "the Maximum box is shown"',
    'fill "the maximum price box" = 600',
    'click Apply => "results are filtered"',
  ], { jev: jev });
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
  const jev = scenarioJev({ targets: { 'the maximum price box': /^Maximum$/ }, nouls: { 'results are filtered': () => false } });
  const r = await runSteps(conn, id, [
    'fill Search = aeron', 'key Enter => "results are filtered"', 'click "More filters"', 'fill "the maximum price box" = 600',
  ], { jev: jev });
  assert.equal(r.done, false);
  assert.equal(r.stopped.step, 2);
  assert.match(r.stopped.reason, /expected "results are filtered"/);
  assert.equal(r.steps.length, 2, 'step 3 never ran');
  assert.equal(r.steps[1].stopped, true);
  assert.equal(await ops.evaluate(conn, id, 'document.getElementById("panel").hidden'), true);
  assert.match(formatSteps(r), /Stopped at step 2/);
  // The last step's expectation is judged in the final request.
  const j2 = scenarioJev({ nouls: { 'results are filtered': () => false } });
  const r2 = await runSteps(conn, id, ['click "More filters" => "results are filtered"'], { jev: j2 });
  assert.equal(r2.stopped.step, 1);
  assert.equal(j2.calls.length, 1);
  await ops.closeTab(conn, id);
});

t('an optional step that finds nothing is skipped and recorded', async () => {
  const id = await open('steps-shop.html');
  const jev = scenarioJev();
  const r = await runSteps(conn, id, ['optional click "the close button of the welcome popup"', 'click "More filters"'], { jev: jev });
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(r.steps[0].skipped, /no element/i);
  assert.equal(r.steps[1].how, 'exact');
  assert.match(formatSteps(r), /– 1\. optional click/);
  await ops.closeTab(conn, id);
});

t('--repeat clicks Next until the condition holds and collects de-duplicated items', async () => {
  const id = await open('steps-pages.html?p=1');
  const jev = scenarioJev({ nouls: { 'this is the last page': text => /Page 3 of 3/.test(text) } });
  const r = await runSteps(conn, id, [], { jev: jev, repeat: 'click Next', until: 'this is the last page', collect: 'items' });
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
  const r2 = await runSteps(conn, id, [], { jev: scenarioJev(), repeat: 'click Next', until: 'never true', collect: 'items' });
  assert.equal(r2.done, true);
  assert.equal(r2.loop.pages, 3);
  assert.match(r2.loop.ended, /could not be done/);
  await ops.navigate(conn, id, fixture.url + 'fixtures/steps-pages.html?p=1');
  const r3 = await runSteps(conn, id, [], { jev: scenarioJev(), repeat: 'click Next', until: 'never true', max: 1, collect: 'text' });
  assert.equal(r3.loop.pages, 2);
  assert.match(r3.collected.text, /Page 2 of 3/);
  await ops.closeTab(conn, id);
});

// Whole-task plans: extract, pick, if, alternatives, and the commit check for labels the
// word lists cannot judge, end to end against a fixture page with a fake Jev.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { fakeJev, optionWith } from './fake-jev.mjs';
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
  try { await conn?.stop(); } catch {}
  try { conn?.close(); } catch {}
  await browser?.close();
  await fixture?.close();
});
const t = (name, fn) => test(name, { skip: !haveBrowser && 'no Chromium-family browser installed' }, fn);
const open = async () => { const { targetId } = await ops.newTab(conn, `${fixture.url}fixtures/judge.html`); await ops.waitForReady(conn, targetId); return targetId; };
const run = async (tab, steps, jev) => { const r = await runSteps(conn, tab, steps, { jev, noNotes: true, prefetch: false }); console.log(formatSteps(r)); return r; };

t('extract copies the line that answers into the report, from below the fold too', async () => {
  const tab = await open();
  const jev = fakeJev({ choice: (q, id) => (id === 'extract' ? optionWith(q, 'Total for 3 nights') : undefined) });
  const r = await run(tab, ['extract "the total price for the stay"'], jev);
  assert.equal(r.done, true);
  assert.equal(r.extracted[0].value, 'Total for 3 nights: $597');
  assert.match(formatSteps(r), /extracted:\n {2}the total price for the stay: "Total for 3 nights: \$597"/);
  assert.equal(jev.calls.length, 2, 'one request for the step, one closing check');
});

t('pick opens the item that fits, by its link', async () => {
  const tab = await open();
  const jev = fakeJev({ choice: (q, id) => (id === 'pick' ? optionWith(q, '$199') : undefined) });
  const r = await run(tab, ['pick "the cheapest hotel with free cancellation"'], jev);
  assert.equal(r.done, true);
  assert.match(r.steps[0].picked.text, /Hotel C/);
  assert.match(r.page.url, /page\.html\?h=c$/);
});

t('pick stops with the closest items when none fits', async () => {
  const tab = await open();
  const r = await run(tab, ['pick "a hotel with a pool"'], fakeJev());
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /No listed item fits "a hotel with a pool"/);
});

t('if runs its step only when the page shows the condition', async () => {
  const tab = await open();
  const shows = (q) => (/cookie/i.test(q.instructions) ? 0.95 : /popup appeared/i.test(q.instructions) ? 0.02 : undefined);
  const r = await run(tab, ['if "a cookie banner" then click "Accept all"', 'if "a popup appeared" then click "Filters"'], fakeJev({ noul: shows }));
  assert.equal(r.done, true);
  assert.equal(r.steps[0].skipped, undefined);
  assert.equal(await ops.evaluate(conn, tab, '!document.getElementById("cookies")'), true, 'the banner was accepted');
  assert.match(r.steps[1].skipped, /does not show "a popup appeared"/);
  assert.equal(await ops.evaluate(conn, tab, 'document.getElementById("f").hidden'), true, 'its step did not run');
});

t('alternatives take the first name the page has, with no model call', async () => {
  const tab = await open();
  const jev = fakeJev();
  const r = await run(tab, ['click "All filters" | "Filters"'], jev);
  assert.equal(r.done, true);
  assert.match(r.steps[0].how, /^exact/);
  assert.equal(await ops.evaluate(conn, tab, 'document.getElementById("f").hidden'), false);
  assert.ok(jev.calls.every(c => !c.questions.target), 'no grounding question was asked');
});

t('a button in a language the word lists do not cover is checked before it is clicked', async () => {
  const tab = await open();
  const yes = fakeJev({ noul: (q, id) => (id === 'commits' ? 0.92 : undefined) });
  const r = await run(tab, ['click "Αγορά τώρα"'], yes);
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /"Αγορά τώρα" can commit something \(p=0\.92\); to click it, mark the step: click! "Αγορά τώρα"/);
  // With the step marked, it is clicked.
  const marked = await run(tab, ['click! "Αγορά τώρα"'], yes);
  assert.equal(marked.done, true);
  assert.equal(marked.steps[0].committed, true);
  // No Jev: browserctrl cannot tell, so it does not click unmarked.
  const off = await run(tab, ['click "Αγορά τώρα"'], fakeJev({ fail: true }));
  assert.match(off.stopped.reason, /cannot tell whether "Αγορά τώρα" commits something/);
});

const longLines = n => Array.from({ length: n }, (_, i) => `primary language entry ${i} ${'x'.repeat(130)}`);
t('extract offers a distant short answer with heading context in one request', async () => {
  const tab = await open();
  const lines = [...Array.from({length: 350}, (_, i) => `Unrelated row ${i}`), 'Languages', 'JavaScript 100.0%'];
  await ops.evaluate(conn, tab, `document.body.innerText=${JSON.stringify(lines.join('\n'))}`);
  const jev = fakeJev({choice: q => optionWith(q, 'Languages: JavaScript 100.0%')});
  const r = await run(tab, ['extract "the primary language" as $lang'], jev);
  assert.equal(r.done, true);
  assert.equal(r.bindings[0].raw, 'JavaScript 100.0%');
  assert.equal(jev.calls.filter(c => c.questions.extract).length, 1);
});
t('extract retries omitted lines once and respects the question budget', async () => {
  const tab = await open();
  const lines = longLines(500);
  await ops.evaluate(conn, tab, `document.body.innerText=${JSON.stringify(lines.join('\n'))}`);
  let first;
  const jev = fakeJev({choice: q => {
    first ||= new Set(Object.values(q.criteria));
    return Object.entries(q.criteria).find(([id, text]) => id !== 'none' && !first.has(text))?.[0] || 'none';
  }});
  const r = await run(tab, ['extract "primary language" as $lang'], jev);
  assert.equal(r.done, true);
  const calls = jev.calls.filter(c => c.questions.extract);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => JSON.stringify(c.questions.extract).length <= 24000));
  assert.match(formatSteps(r), /second pass/);
});
t('none diagnostics show probability and coverage without zero candidates', async () => {
  const tab = await open();
  await ops.evaluate(conn, tab, `document.body.innerText=${JSON.stringify(longLines(500).join('\n'))}`);
  const jev = fakeJev({choice: () => ({choice:'none', probabilities:{none:.97}})});
  const r = await run(tab, ['extract "primary language" as $lang'], jev);
  assert.match(r.stopped.reason, /Jev: no offered line answers \(none p=0\.97\); \d+ of 500 lines offered/);
  assert.equal(jev.calls.filter(c => c.questions.extract).length, 3, 'two evidence passes plus one young-page retry');
});

t('extraction diagnostics print two decimal probabilities', async () => {
  const tab = await open();
  const jev = fakeJev({choice: q => ({choice: optionWith(q, 'Total for 3 nights'), probabilities: {
    [optionWith(q, 'Total for 3 nights')]: .14 + .15, none: .71,
  }})});
  const r = await run(tab, ['extract "the total" as $price'], jev);
  assert.match(r.stopped.reason, /p=0\.29/);
  assert.doesNotMatch(formatSteps(r), /0\.29000000000000004/);
});

t('extract joins sidebar inline facts and marks attribute evidence', async () => {
  const tab = await open();
  await ops.evaluate(conn, tab, `document.body.innerHTML='<h2>Languages</h2><div role="progressbar" aria-label="JavaScript: 100%"><span>JavaScript</span><span style="display:block">100%</span></div>'`);
  const joined = await run(tab, ['extract "the primary language" as $lang'], fakeJev({choice: q => optionWith(q, 'Languages: JavaScript 100%')}));
  assert.equal(joined.done, true);
  assert.equal(joined.bindings[0].raw, 'JavaScript 100%');
  const attr = await run(tab, ['extract "the primary language" as $lang'], fakeJev({choice: q => optionWith(q, 'JavaScript: 100%')}));
  assert.equal(attr.done, true);
  assert.equal(attr.bindings[0].source_attribute, 'aria-label');
  assert.match(formatSteps(attr), /aria-label/);
});

t('extract asks once more for late content after an initial none', async () => {
  const tab = await open();
  let asks = 0;
  const jev = fakeJev({choice: (q, id) => {
    if (id !== 'extract') return;
    asks++;
    if (asks === 1) {
      // Schedule from the first ask so initial plan readiness cannot consume the delay.
      void ops.evaluate(conn, tab, `setTimeout(() => { document.body.innerHTML='<h2>Languages</h2><p>JavaScript 100%</p>'; }, 1500)`);
      return 'none';
    }
    return optionWith(q, 'JavaScript 100%');
  }});
  const r = await run(tab, ['extract "the primary language" as $lang'], jev);
  assert.equal(r.done, true);
  assert.equal(asks, 2);
  assert.match(formatSteps(r), /waited \d+ ms for the page to fill in/);
});

t('old quiet page with no answer does not wait or ask again', async () => {
  const tab = await open();
  await new Promise(resolve => setTimeout(resolve, 8100));
  const jev = fakeJev();
  const start = Date.now();
  const r = await run(tab, ['extract "a missing answer" as $missing'], jev);
  assert.equal(r.done, false);
  assert.equal(jev.calls.filter(c => c.questions.extract).length, 1);
  assert.equal(r.steps[0].content_wait_ms, undefined);
  assert.ok(Date.now() - start < 3000);
});

t('pick retries a young empty list after none', async () => {
  const tab = await open();
  await ops.evaluate(conn, tab, `document.body.innerHTML='<h1>Loading hotels</h1>'`);
  let asks = 0;
  const jev = fakeJev({choice: (q, id) => {
    if (id !== 'pick') return;
    if (++asks === 1) {
      void ops.evaluate(conn, tab, `setTimeout(() => { document.body.innerHTML='<main><ul><li><a href="/fixtures/page.html">Hotel A</a></li><li><a href="/fixtures/page.html">Hotel B</a></li><li><a href="/fixtures/page.html">Hotel C</a></li></ul></main>'; }, 1500)`);
      return 'none';
    }
    return optionWith(q, 'Hotel B');
  }});
  const r = await run(tab, ['pick "Hotel B"'], jev);
  assert.equal(r.done, true);
  assert.equal(asks, 2);
  assert.ok(r.steps[0].content_wait_ms >= 1500);
});

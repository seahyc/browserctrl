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

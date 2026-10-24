// open $x after a pick, the missing-key check before a plan acts, and resuming a stopped plan
// from its trace, against fixture pages with a fake Jev.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { remainingSteps, replacements, resumeLines } from '../lib/do/resume.mjs';
import { fakeJev, optionWith } from './fake-jev.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

// One agent identity for the test's own calls and its CLI calls, so they share tab claims.
process.env.CDP_AGENT_ID = 'test-do-open-resume';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = (...args) => promisify(execFile)(process.execPath, [path.join(ROOT, 'bin/browserctrl.mjs'), ...args, '--port', String(TEST_PORT)], { env: process.env, timeout: 120000 }).catch(e => e);
const haveBrowser = Boolean(chromeBinary());
let fixture, browser, conn;
before(async () => {
  delete process.env.TYPESAFE_API_KEY;
  process.env.BROWSERCTRL_JEV_ENV = path.join(os.tmpdir(), 'no-such-jev.env');
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
const t = (name, fn) => test(name, { skip: !haveBrowser && 'no Chromium-family browser installed' }, async () => {
  const tab = (await ops.newTab(conn, `${fixture.url}fixtures/open-items.html`)).targetId;
  await ops.waitForReady(conn, tab);
  await ops.evaluate(conn, tab, `sort.onclick = () => { window.sorted = (window.sorted || 0) + 1; }`);
  try { await fn(tab); } finally { await ops.closeTab(conn, tab).catch(() => {}); }
});
const run = (tab, plan, jev, opts = {}) => runSteps(conn, tab, plan, { ...(jev ? { jev } : {}), noNotes: true, prefetch: false, ...opts });
const ranked = (rules = {}) => fakeJev({
  noul: (q, id) => id.endsWith('.eligible') || id === 'prev_expect' || id === 'extract_verify' ? .95 : .04,
  choice: (q, id) => id.endsWith('.key') ? Object.keys(q.criteria).find(k => k !== 'none') || 'none' : id === 'extract' ? optionWith(q, '4.6') : 'none',
  ...rules,
});

// open
t('open $x after a pick goes to the chosen item and the next extract reads it there', async tab => {
  const r = await run(tab, ['pick "lowest price" top 1 as $x', 'open $x', 'extract "the rating"'], ranked());
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(r.page.url, /open-detail\.html\?id=2$/);
  assert.equal(r.current_tab, tab);
  assert.match(r.steps[1].rendered.target, /open-detail\.html\?id=2$/);
  assert.match(r.extracted[0].value, /4\.6 out of 5/);
  assert.match(formatSteps(r), /✓ 2\. open \$x/);
});

t('open ${x.link} in new tab runs the rest there and leaves the list where it was', async tab => {
  const r = await run(tab, ['pick "lowest price" top 1 as $x', 'open ${x.link} in new tab', 'extract "the rating"'], ranked());
  try {
    assert.equal(r.done, true, JSON.stringify(r.stopped));
    assert.notEqual(r.current_tab, tab);
    assert.equal(r.steps[1].opened_tab, r.current_tab);
    assert.match(await ops.evaluate(conn, r.current_tab, 'location.href'), /open-detail\.html\?id=2$/);
    assert.match(await ops.evaluate(conn, tab, 'location.href'), /open-items\.html$/);
    assert.match(r.extracted[0].value, /4\.6/);
    assert.match(formatSteps(r), /opened in new tab [0-9A-F]+; the steps after it ran there/);
    assert.equal(r.changes, undefined);
  } finally { if (r.current_tab !== tab) await ops.closeTab(conn, r.current_tab).catch(() => {}); }
});

t('open on a binding of several items stops before navigating', async tab => {
  const r = await run(tab, ['pick "lowest price" top 2 as $x', 'open $x'], ranked());
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /\$x holds 2 items; open one, so pick top 1/);
  assert.match(await ops.evaluate(conn, tab, 'location.href'), /open-items\.html$/);
});

// missing key
t('without a key, a plan with an extract stops before its first step acts, in one line', async tab => {
  const r = await run(tab, ['click "Sort by price"', 'extract "the rating"']);
  assert.equal(r.done, false);
  assert.equal(r.stopped.step, 0);
  assert.match(r.stopped.reason, /^No TypeSafe API key, and step "extract "the rating"" needs one \(extract reads the page with Jev\)\. Set TYPESAFE_API_KEY, or put TYPESAFE_API_KEY=\.\.\. in .*no-such-jev\.env; plans of exact names, refs and CSS selectors run without one$/);
  assert.equal(r.steps.length, 0);
  assert.equal(await ops.evaluate(conn, tab, 'window.sorted ?? null'), null);
  assert.doesNotMatch(formatSteps(r), /resume:/);
});

t('without a key, a first name that is not exact stops before acting', async tab => {
  const r = await run(tab, ['click "the sort button"']);
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /step "click "the sort button"" needs one \(its name is not an exact name on the page\)/);
  assert.equal(await ops.evaluate(conn, tab, 'window.sorted ?? null'), null);
});

t('without a key, exact names and a page-order pick then open still run', async tab => {
  const r = await run(tab, ['click "Sort by price"', 'pick "first" top 1 as $x', 'open $x']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(r.page.url, /open-detail\.html\?id=1$/);
});

// resume
t('a stopped plan prints a resume line with the closest control, and --resume runs the rest', async tab => {
  const jev = fakeJev({
    choice: (q, id) => id === 'target' ? { choice: 'none', probabilities: { none: 0.5, [optionWith(q, 'Sort by price')]: 0.4 } } : 'none',
    noul: (q, id) => id === 'prev_expect' ? .95 : .04,
  });
  const r = await run(tab, ['click "Sort by price"', 'click "Sort by rating"', 'click "Polar 500"'], jev);
  assert.equal(r.done, false);
  assert.equal(r.stopped.step, 2);
  assert.ok(r.trace, 'the run wrote a trace');
  const out = formatSteps(r);
  assert.match(out, new RegExp(`resume: browserctrl do '${tab}' --resume --replace 'click "Sort by price"' {3}# closest control, p=0\\.40`));
  assert.match(out, new RegExp(`or as planned: browserctrl do '${tab}' --resume`));
  // do <tab> --resume [--replace]: from the trace, from the failed step on.
  assert.deepEqual(resumeLines(tab), ['click "Sort by rating"', 'click "Polar 500"']);
  const lines = resumeLines(tab, { replace: 'click "Sort by price"' });
  assert.deepEqual(lines, ['click "Sort by price"', 'click "Polar 500"']);
  const again = await run(tab, lines, jev);
  assert.equal(again.done, true, JSON.stringify(again.stopped));
  assert.equal(await ops.evaluate(conn, tab, 'location.pathname'), '/fixtures/open-detail.html');
  assert.throws(() => resumeLines(tab), /finished; there is nothing to resume/);
});

test('resume refuses plans whose rest needs earlier bindings, blocks or commits, and a step that moved the page', () => {
  assert.deepEqual(remainingSteps({ plan: ['click "A"', 'click "B"', 'click "C"'], step: 2 }).lines, ['click "B"', 'click "C"']);
  assert.deepEqual(remainingSteps({ plan: ['click "A"', 'click "B"', 'click "C"'], step: 2, acted: true }).lines, ['click "C"']);
  assert.match(remainingSteps({ plan: ['click "A"', 'click "B"'], step: 2, acted: true, moved: true }).why, /already acted and the page moved on/);
  assert.match(remainingSteps({ plan: ['pick "lowest price" top 1 as $x', 'click "B"', 'open $x'], step: 2 }).why, /uses \$x, bound by an earlier step/);
  assert.match(remainingSteps({ plan: ['click "A"', 'click "Next"', 'if "a banner" { click "Close" }'], step: 2 }).why, /block, loop or try/);
  assert.match(remainingSteps({ plan: ['click "A"', 'click "B"', 'click! "Place order"'], step: 2 }).why, /commits something/);
  assert.deepEqual(remainingSteps({ plan: ['click "A"', 'click "B"'], step: 2, replace: 'click! "Place order"' }).lines, ['click! "Place order"']);
  assert.match(remainingSteps({ plan: ['click "A"'], step: '1.then.1' }).why, /inside a block/);
  assert.deepEqual(replacements({ action: 'fill', target: 'Serch', value: 'aeron', expect: 'results' }, [{ ref: 'ref_3', name: 'Search', p: 0.4 }, { ref: 'ref_4', name: 'Say "hi"', p: 0.2 }]),
    [{ step: 'fill "Search" = "aeron" => "results"', p: 0.4 }]);
});

t('browserctrl do <tab> --resume --replace runs the stopped plan from its failed step', async tab => {
  const jev = fakeJev({
    choice: (q, id) => id === 'target' ? { choice: 'none', probabilities: { none: 0.6, [optionWith(q, 'Sort by price')]: 0.3 } } : 'none',
    noul: (q, id) => id === 'prev_expect' ? .95 : .04,
  });
  const stopped = await run(tab, ['click "Sort by price"', 'click "Sort by size"', 'click "Frostline 210"'], jev);
  assert.equal(stopped.stopped.step, 2);
  const r = await cli('do', tab, '--resume', '--replace', 'click "Sort by price"');
  assert.equal(r.code ?? 0, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /✓ 1\. click "Sort by price"/);
  assert.match(r.stdout, /✓ 2\. click "Frostline 210"/);
  assert.match(r.stdout, /✓ done: 2\/2 steps/);
  assert.equal(await ops.evaluate(conn, tab, 'location.search'), '?id=2');
  const none = await cli('do', tab, '--resume');
  assert.notEqual(none.code ?? 0, 0);
  assert.match(none.stderr || none.stdout, /finished; there is nothing to resume/);
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { judgment, retryExtract, retryContent, settleJudgment } from '../lib/do/judgments.mjs';
import { shortlistSpans } from '../lib/judge.mjs';

process.env.BROWSERCTRL_CAPTURE = '0';
let browser, conn;
before(async () => {
  if (!chromeBinary()) return;
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => { try { await conn?.stop(); } finally { conn?.close(); await browser?.close(); } });

test('previous step new control names reserve slots on a crowded page', { skip: !chromeBinary() }, async () => {
  const tab = (await ops.newTab(conn, 'about:blank')).targetId;
  try {
    await ops.evaluate(conn, tab, `document.body.innerHTML = Array.from({length: 1480}, (_, i) => '<button aria-label="'+(i === 1187 ? '11 Mar 2027 - Site E101 is available' : 'Reserve site '+i+' for 12 Mar 2027')+'">'+i+'</button>').join('')`);
    const ctx = { conn, tab, previousNewControlNames: ['11 Mar 2027 - Site E101 is available', 'not on the page'] };
    const j = await judgment(ctx, { action: 'extract', target: 'the first available date' });
    assert.ok(j.spans.some(s => s.text === ctx.previousNewControlNames[0]));
    assert.ok(!j.spans.some(s => s.text === 'not on the page'));
    assert.ok(j.spans.length <= 254);
  } finally { await ops.closeTab(conn, tab); }
});

test('reserved candidates still obey exclusion and question budget', () => {
  const all = Array.from({ length: 1480 }, (_, i) => ({ text: `A fact ${i}`, recent_control: i >= 1400 }));
  const first = shortlistSpans(all, 'available date');
  assert.ok(first.filter(s => s.i >= 1400).length >= 32);
  const second = shortlistSpans(all, 'available date', undefined, new Set(first.map(s => s.i)));
  assert.ok(second.every(s => !first.some(f => f.i === s.i)));
});

test('split votes for a count and its complete range heading need verification', async () => {
  const spans = [{ i: 0, text: '277' }, { i: 1, text: 'Showing 1-15 of 277 results' }];
  const answer = { type: 'choice', choice: 'none', probabilities: { none: 0.52, l1: 0.39, l2: 0.09 } };
  for (const p of [0.95, 0.2]) {
    const row = {}, report = {};
    const ctx = { view: {}, report, ask: async () => ({ answers: { extract_verify: { noul: p } }, ms: 1 }) };
    await settleJudgment(ctx, { action: 'extract', target: 'number of results' }, row, { spans, all: spans }, { extract: answer });
    assert.equal(row.extracted.value, p > 0.7 ? '277' : null);
    assert.equal(row.extract_verify.p, p);
  }
});

test('tag extraction refuses a prose version conflicting with an observed href identifier', async () => {
  const title = { i: 1, text: '2027-03-11, Version 42.3.1 (Current)' };
  const href = { i: 0, text: 'v42.3.1', source_attribute: 'href' };
  const step = { action: 'extract', target: 'the latest release tag', binding: 'tag', extraction: { type: 'text' } };
  const ctx = () => ({ view: {}, report: {}, bindings: new Map(), ask: async () => ({ answers: { extract_verify: { noul: 1 } }, ms: 1 }) });
  const j = { what: step.target, spans: [title], all: [href, title], valueResolutions: new Map([[title.text, { values: ['42.3.1'], probabilities: { v1: 1 } }]]) };
  const answer = { extract: { type: 'choice', choice: 'l1', probabilities: { l1: 0.9, none: 0.1 } } };
  const row = {};
  const stopped = await settleJudgment(ctx(), step, row, j, answer);
  assert.match(stopped.result.stop.reason, /identifier.*conflict/i);
  assert.equal(row.binding, undefined);
  const exactRow = {};
  const exact = await settleJudgment(ctx(), step, exactRow, { what: step.target, spans: [href], all: [href, title] }, answer);
  assert.equal(exact.result.stop, undefined);
  assert.equal(exactRow.binding.value, 'v42.3.1');
});


test('unbound extraction preserves a pooled first pass before retrying omitted promotions', async () => {
  const spans = [{ i: 0, text: '277' }, { i: 1, text: 'Showing 1-15 of 277 results' }];
  for (const verify of [0.95, 0.2]) {
    const j = { spans: [...spans], all: [...spans, { i: 2, text: 'Save up to 70% on 50000 adventures' }] };
    const answers = { extract: { type: 'choice', choice: 'none', probabilities: { none: 0.52, l1: 0.39, l2: 0.09 } } };
    const row = {}, step = { action: 'extract', target: 'number of results' };
    let asks = 0;
    const ctx = { view: {}, report: {}, ask: async (_state, questions) => {
      asks++;
      return { answers: questions.extract_verify ? { extract_verify: { noul: verify } } : { extract: { type: 'choice', choice: 'none', probabilities: { none: 1 } } }, ms: 1 };
    } };
    await retryExtract(ctx, step, row, j, answers);
    assert.equal(asks, 0, 'pooled first-pass evidence must reach settlement before a second extraction');
    await settleJudgment(ctx, step, row, j, answers);
    assert.equal(asks, 1);
    assert.equal(row.extracted.value, verify > 0.7 ? '277' : null);
    assert.equal(row.extract_second_pass, undefined);
  }
});


test('unrelated page churn does not retry already pooled unbound evidence', { skip: !chromeBinary() }, async () => {
  const tab = (await ops.newTab(conn, 'about:blank')).targetId;
  try {
    await ops.evaluate(conn, tab, `document.body.innerHTML = '<h2>Showing 1-15 of 277 results</h2><p>277</p>'`);
    const j = { spans: [{ i: 0, text: '277' }, { i: 1, text: 'Showing 1-15 of 277 results' }], pageText: await ops.evaluate(conn, tab, 'document.body.innerHTML') };
    await ops.evaluate(conn, tab, `document.body.innerHTML += '<p>Save up to 70% on adventures</p>'`);
    let asks = 0;
    const ctx = { conn, tab, view: {}, deadline: Date.now() + 10000, ask: async () => { asks++; return { answers: { extract: { type: 'choice', choice: 'none', probabilities: { none: 1 } } }, ms: 1 }; } };
    const row = {};
    await retryContent(ctx, { action: 'extract', target: 'number of results' }, row, j, { extract: { type: 'choice', choice: 'none', probabilities: { none: 0.52, l1: 0.39, l2: 0.09 } } });
    assert.equal(asks, 0);
    assert.equal(row.content_wait_ms, undefined);
  } finally { await ops.closeTab(conn, tab); }
});

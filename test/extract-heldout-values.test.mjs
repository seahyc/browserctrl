import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortlistSpans, extractQuestion } from '../lib/judge.mjs';
import { settleJudgment } from '../lib/do/judgments.mjs';

async function bind(lines, probabilities, type = 'number', verify = .95) {
  const questions = [];
  const ctx = { bindings: new Map(), report: {}, view: {}, ask: async (_, q) => {
    questions.push(q);
    return { ms: 1, answers: { extract_verify: { noul: verify } } };
  } };
  const spans = lines.map((text, i) => ({ text, i }));
  const row = {};
  const result = await settleJudgment(ctx, { action: 'extract', target: 'the requested fact', binding: 'x', extraction: { type } }, row,
    { spans, all: spans, lang: 'en' }, { extract: { type: 'choice', choice: Object.keys(probabilities)[0], probabilities } });
  return { value: ctx.bindings.get('x'), result, row, questions };
}

test('equal price votes pool only with matching currencies and periods, then verify', async () => {
  const lines = ['USD 0 per user/month', '$0 USD per user/month', 'US$0 per user/month'];
  const p = { l1: .28, l2: .18, l3: .2, none: .34 };
  const ok = await bind(lines, p);
  assert.equal(ok.value.value, 0);
  assert.equal(ok.value.currency, 'USD');
  assert.equal(ok.value.unit, 'user/month');
  assert.equal(ok.questions.length, 1);
  assert.ok((await bind(lines, p, 'number', .69)).result.result.stop);
  for (const incompatible of [['0', '$0 USD', '€0'], ['0', '$0 per month', '$0 per year'], ['0', '$0 USD', '$0 USD per user/month'], ['USD 1000', 'USD 1000 per night', 'USD 1000']]) {
    assert.ok((await bind(incompatible, p)).result.result.stop);
  }
});

test('rounded votes pool at the rounding boundary and preserve finer observed precision', async () => {
  const r = await bind(['18k stars', '18.5k stars', '18.5k'], { l1: .3, l2: .25, l3: .2, none: .25 });
  assert.equal(r.value.value, 18500);
  assert.equal(r.value.precision_upgraded, true);
  assert.equal(r.questions.length, 1);
  for (const lines of [['18k stars', '18.6k stars', '18.6k'], ['18k stars', '18.5k forks', '18.5k']]) {
    assert.ok((await bind(lines, { l1: .3, l2: .25, l3: .2, none: .25 })).result.result.stop);
  }
});

test('agreeing date copies can verify pooled mass without lowering the clear-winner threshold', async () => {
  const r = await bind(['7 April 1932', 'Established: 7 April 1932'], { l1: .4, l2: .23, none: .37 }, 'date');
  assert.equal(r.value.value, '1932-04-07');
  assert.equal(r.questions.length, 1);
  assert.ok((await bind(['7 April 1932'], { l1: .4, none: .6 }, 'date', .69)).result.result.stop);
  assert.ok((await bind(['7 April 1932', '8 April 1932'], { l1: .4, l2: .23, none: .37 }, 'date')).result.result.stop);
});

test('date reservation offers complete embedded dates on pages with many unrelated digits', () => {
  const spans = Array.from({ length: 2000 }, (_, i) => `Archive entry ${i}`);
  spans[1701] = 'The observatory opened on 7 April 1932.';
  const offered = shortlistSpans(spans, 'when was the observatory founded', undefined, new Set(), { type: 'date' });
  assert.ok(offered.some(s => s.i === 1701));
  assert.ok(offered.length <= 254);
  assert.ok(JSON.stringify(extractQuestion('when was the observatory founded', offered)).length <= 24000);
});

test('cross-language verification still checks the fact and retains the .7 gate', async () => {
  const r = await bind(['64 forks'], { l1: .9, none: .1 });
  assert.match(r.questions[0].extract_verify.instructions, /different languages/);
  assert.match(r.questions[0].extract_verify.instructions, /64 forks/);
  assert.ok((await bind(['64 forks'], { l1: .9, none: .1 }, 'number', .55)).result.result.stop);
});

test('heading context does not repeat a fact already ending the heading', () => {
  const [span] = shortlistSpans([{ text: '$12 per month', heading: 'Starter: $12 per month' }], 'the monthly price');
  assert.equal(span.context, 'Starter: $12 per month');
});

test('typed questions omit valueless controls while keeping labelled numeric facts', () => {
  const offered = shortlistSpans(['per user/month', 'Starter', { text: '$12 per user/month', heading: 'Starter' }], 'the price', undefined, new Set(), { type: 'number' });
  assert.deepEqual(offered.map(s => s.text), ['$12 per user/month']);
  assert.equal(offered[0].context, 'Starter: $12 per user/month');
});

test('date questions require a complete date rather than a year-only distractor', () => {
  const offered = shortlistSpans(['Founded in 1932', 'Opened on 7 April 1932'], 'the founding date', undefined, new Set(), { type: 'date' });
  assert.deepEqual(offered.map(s => s.text), ['Opened on 7 April 1932']);
});

test('rescued counts prefer complete labelled facts over resolved button aggregates', async () => {
  const lines = ['Fork 64 (64)', '64 forks'];
  const spans = lines.map((text, i) => ({ text, i }));
  const questions = [];
  const ctx = { bindings: new Map(), report: {}, view: {}, ask: async (_, q) => {
    questions.push(q);
    return { ms: 1, answers: { extract_verify: { noul: .95 } } };
  } };
  const part = { spans, all: spans, valueResolutions: new Map([[lines[0], { values: ['Fork 64'], probabilities: { v1: 1 } }]]) };
  await settleJudgment(ctx, { action: 'extract', target: 'fork count', binding: 'x', extraction: { type: 'number' } }, {}, part,
    { extract: { type: 'choice', choice: 'l1', probabilities: { l1: .4, l2: .2, none: .4 } } });
  assert.equal(ctx.bindings.get('x').raw, '64 forks');
  assert.match(questions[0].extract_verify.instructions, /text: 64 forks/);
});

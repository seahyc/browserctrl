import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractValues, shortlistSpans, extractQuestion } from '../lib/judge.mjs';
import { resolveExtractValues, settleJudgment } from '../lib/do/judgments.mjs';

const schema = { type: 'number' };
const line = 'Public Watch 11 (11) Fork 202 (202) Star 3.3k (3.3k)';
const step = { action: 'extract', target: 'the number of stars', binding: 'stars', extraction: schema };
const answer = { type: 'choice', choice: 'l1', probabilities: { l1: .6, l2: .27, none: .13 } };
const setup = (probabilities = { v3: .95, none: .05 }) => {
  const calls = [];
  const ctx = {
    bindings: new Map(), report: {}, view: { url: 'https://example.test' },
    ask: async (state, questions) => {
      calls.push(questions);
      return { ms: 2, answers: questions.extract_verify ? { extract_verify: { noul: .9 } } :
        { extract_value: { type: 'choice', choice: Object.keys(probabilities)[0], probabilities } } };
    },
  };
  return { ctx, calls, part: { spans: [{ text: line, i: 0 }, { text: '3.3k stars', i: 1 }] } };
};

test('typed values retain labels and deduplicate repeated counts', () => {
  assert.deepEqual(extractValues(line, schema), ['11', 'Fork 202', 'Star 3.3k']);
  assert.deepEqual(extractValues('Arrival 2024-02-29 Departure March 4, 2025', { type: 'date' }), ['2024-02-29', 'March 4, 2025']);
  assert.deepEqual(extractValues('3.3k stars', schema), []);
  assert.deepEqual(extractValues('Version 1.2.3', schema), []);
});

test('chosen multi-value line asks once and contributes only its conditional mass', async () => {
  const { ctx, calls, part } = setup();
  const row = {};
  await resolveExtractValues(ctx, step, row, part, { extract: answer });
  await resolveExtractValues(ctx, step, row, part, { extract: answer });
  assert.equal(calls.length, 1);
  assert.match(calls[0].extract_value.instructions, /the number of stars/);
  assert.match(calls[0].extract_value.instructions, /Public Watch/);
  const result = await settleJudgment(ctx, step, row, part, { extract: answer });
  assert.deepEqual(result, { result: {} });
  const binding = ctx.bindings.get('stars');
  assert.equal(binding.value, 3300);
  assert.equal(binding.p, .84);
  assert.equal(binding.raw, line);
  assert.equal(binding.selected_value, 'Star 3.3k');
  assert.equal(binding.members.length, 2);
});

for (const probabilities of [{ none: .95, v3: .05 }, { v3: .5, v2: .5 }, { v99: .95 }, { v3: NaN }]) {
  test(`unresolved multi-value choice cannot manufacture a binding ${JSON.stringify(probabilities)}`, async () => {
    const { ctx, part } = setup(probabilities);
    await resolveExtractValues(ctx, step, {}, part, { extract: answer });
    const result = await settleJudgment(ctx, step, {}, part, { extract: answer });
    assert.ok(result.result.stop);
    assert.equal(ctx.bindings.size, 0);
  });
}

test('single-value and text paths never ask a value follow-up', async () => {
  const { ctx, calls, part } = setup();
  await resolveExtractValues(ctx, { ...step, extraction: { type: 'text' } }, {}, part, { extract: answer });
  await resolveExtractValues(ctx, step, {}, { spans: [{ text: '3.3k stars', i: 0 }] }, { extract: answer });
  assert.equal(calls.length, 0);
});

test('short lines leave relevance slots and deduplicate within the option cap', () => {
  const lines = Array.from({ length: 700 }, (_, i) => `row ${i}`);
  lines[621] = '3.3k stars';
  lines.push('3.3k stars');
  const offered = shortlistSpans(lines, 'the number of stars');
  assert.ok(offered.some(s => s.text === '3.3k stars'));
  assert.equal(offered.filter(s => s.text === '3.3k stars').length, 1);
  assert.ok(offered.length <= 254);
  assert.ok(JSON.stringify(extractQuestion('the number of stars', offered)).length <= 24000);
});

test('embedded single values still require a value judgment', async () => {
  assert.deepEqual(extractValues('Star 3.3k (3.3k)', schema), ['Star 3.3k']);
  assert.deepEqual(extractValues('Population estimate 6,110,200', schema), ['6,110,200']);
  assert.deepEqual(extractValues('Free plan costs $0 USD per user/month', schema), ['$0']);
  assert.deepEqual(extractValues('Independence on 9 August 1965', { type: 'date' }), ['9 August 1965']);
  assert.deepEqual(extractValues('100%', schema), []);
  const { ctx, calls } = setup({ v1: .96, none: .04 });
  const part = { spans: [{ text: 'Star 3.3k (3.3k)', i: 0 }] };
  const selected = { type: 'choice', choice: 'l1', probabilities: { l1: .95, none: .05 } };
  await resolveExtractValues(ctx, step, {}, part, { extract: selected });
  assert.equal(calls.length, 1);
  const result = await settleJudgment(ctx, step, {}, part, { extract: selected });
  assert.deepEqual(result, { result: {} });
  assert.equal(ctx.bindings.get('stars').value, 3300);
});

test('competing embedded lines need independent follow-ups before their masses agree', async () => {
  const { ctx, calls } = setup({ v1: .96, none: .04 });
  const part = { spans: [{ text: 'Star 3.3k (3.3k)', i: 0 }, { text: '3.3k stars', i: 1 }] };
  const selected = { type: 'choice', choice: 'l2', probabilities: { l1: .3, l2: .6, none: .1 } };
  let result = await settleJudgment(ctx, step, {}, part, { extract: selected });
  assert.ok(result.result.stop);
  await resolveExtractValues(ctx, step, {}, part, { extract: selected });
  assert.equal(calls.length, 1);
  result = await settleJudgment(ctx, step, {}, part, { extract: selected });
  assert.deepEqual(result, { result: {} });
  assert.equal(ctx.bindings.get('stars').p, .888);
});

test('different rounded counts with the same label must stop', async () => {
  const { ctx } = setup();
  const part = { spans: [{ text: '123k stars', i: 0 }, { text: '122.4k stars', i: 1 }] };
  const selected = { type: 'choice', choice: 'l1', probabilities: { l1: .8, l2: .1, none: .1 } };
  const result = await settleJudgment(ctx, step, {}, part, { extract: selected });
  assert.match(result.result.stop.reason, /conflicting labelled counts/);
  assert.equal(ctx.bindings.size, 0);
});

test('a named percentage can resolve to its observed name, but a bare percentage cannot', async () => {
  assert.deepEqual(extractValues('JavaScript: 66.6%', { type: 'text' }), ['JavaScript']);
  assert.deepEqual(extractValues('100%', { type: 'text' }), []);
  const { ctx } = setup({ v1: .98, none: .02 });
  const textStep = { ...step, target: 'primary language', extraction: { type: 'text' } };
  const part = { spans: [{ text: 'JavaScript: 66.6%', i: 0 }, { text: 'JavaScript', i: 1 }] };
  const selected = { type: 'choice', choice: 'l1', probabilities: { l1: .49, l2: .3, none: .1 } };
  await resolveExtractValues(ctx, textStep, {}, part, { extract: selected });
  const result = await settleJudgment(ctx, textStep, {}, part, { extract: selected });
  assert.deepEqual(result, { result: {} });
  assert.equal(ctx.bindings.get('stars').value, 'JavaScript');
});

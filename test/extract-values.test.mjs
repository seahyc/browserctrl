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

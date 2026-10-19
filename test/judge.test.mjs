// Plan judgments: building the questions and reading Jev's answers, without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spansOf, shortlistSpans, extractQuestion, readExtract, pickQuestion, readPick, conditionQuestion, alternatives } from '../lib/judge.mjs';

test('spans: lines in page order, long lines split, duplicates once', () => {
  const s = spansOf(`Price\n$1,299\n\nPrice\n${'A sentence about the product. '.repeat(12)}`);
  assert.deepEqual(s.slice(0, 2), ['Price', '$1,299']);
  assert.ok(s.every(x => x.length <= 220));
  assert.equal(s.filter(x => x === 'Price').length, 1);
});

test('shortlist keeps lines that share words, and numbers when an amount is asked', () => {
  const spans = [...Array(300)].map(() => 'filler line').concat(['Total prize: $50,000', 'Prize pool details']);
  const kept = shortlistSpans(spans, 'what is the total prize', 1000);
  assert.ok(kept.some(k => k.text === 'Total prize: $50,000'));
  assert.ok(JSON.stringify(extractQuestion('what is the total prize', kept)).length <= 1000);
});

test('extract: question lists lines and none; the answer is a line verbatim', () => {
  const spans = [{ text: 'Rating' }, { text: '4.7 out of 5' }];
  const q = extractQuestion('the rating', spans);
  assert.equal(q.type, 'choice');
  assert.deepEqual(Object.keys(q.criteria), ['none', 'l1', 'l2']);
  const r = readExtract({ type: 'choice', choice: 'l2', probabilities: { l2: 0.62, l1: 0.3, none: 0.08 } }, spans);
  assert.equal(r.value, '4.7 out of 5');
  assert.equal(r.p, 0.62);
  assert.deepEqual(r.alternatives, [{ value: 'Rating', p: 0.3 }]);
  assert.equal(readExtract({ type: 'choice', choice: 'none', probabilities: { none: 0.9 } }, spans).value, null);
  assert.throws(() => readExtract({ type: 'noul' }, spans));
});

test('pick: chooses an item by id and names the runners-up', () => {
  const items = [{ id: 'i1', text: 'Hotel A · $220 · 4.1', link: '/a' }, { id: 'i2', text: 'Hotel B · $180 · 4.6', link: '/b' }];
  const q = pickQuestion('the cheapest', items);
  assert.deepEqual(Object.keys(q.criteria), ['none', 'i1', 'i2']);
  const r = readPick({ type: 'choice', choice: 'i2', probabilities: { i2: 0.8, i1: 0.15, none: 0.05 } }, items);
  assert.equal(r.item.link, '/b');
  assert.deepEqual(r.runnersUp.map(x => x.id), ['i1']);
});

test('condition and alternatives', () => {
  assert.equal(conditionQuestion('no results').type, 'noul');
  assert.deepEqual(alternatives('"Filters" | "All filters"'), ['Filters', 'All filters']);
  assert.equal(alternatives('"Size | Fit"'), null);
  assert.equal(alternatives('Filters'), null);
});

test('extraction budget covers page regions as well as matching lines', () => {
  const lines = Array.from({length: 500}, (_, i) => `primary language ${i} ${'x'.repeat(130)}`);
  lines[400] = 'Languages'; lines[401] = 'JavaScript 100.0%';
  const spans = shortlistSpans(lines, 'primary language');
  assert.ok(spans.some(s => s.i > 450));
  assert.ok(spans.some(s => s.i < 30));
  assert.ok(JSON.stringify(extractQuestion('primary language', spans)).length <= 24000);
});

test('an extract question never offers more lines than a Jev choice allows', () => {
  const spans = Array.from({ length: 600 }, (_, i) => `n${i}`);
  const offered = shortlistSpans(spans, 'the number of stars');
  assert.ok(offered.length <= 254, `offered ${offered.length}`);
  assert.ok(Object.keys(extractQuestion('the number of stars', offered).criteria).length <= 255);
});

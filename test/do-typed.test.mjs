import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExtractValue, parseExtractEvidence } from '../lib/judge.mjs';
import { settleJudgment, JUDGED } from '../lib/do/judgments.mjs';

const number = (raw, currency) => parseExtractValue(raw, { type: 'number', ...(currency ? { currency } : {}) });
const date = raw => parseExtractValue(raw, { type: 'date' });
const choice = (id = 'l1', p = 0.95) => ({ type: 'choice', choice: id, probabilities: { [id]: p } });
const context = () => ({ bindings: new Map(), report: {}, view: { url: 'https://example.test/offer' } });

test('typed numbers parse localized separators, negatives and explicit currencies', () => {
  for (const [raw, value, currency] of [
    ['SGD 1,234.56', 1234.56, 'SGD'], ['1.234,56 €', 1234.56, 'EUR'],
    ['S$180 per night', 180, 'SGD'], ['SGD $180', 180, 'SGD'], ['Price: SGD180', 180, 'SGD'], ['-1 234,50', -1234.5], ['USD -12.50', -12.5, 'USD'],
    ['1’234.50 CHF', 1234.5, 'CHF'], ['$180', 180],
  ]) assert.equal(number(raw, currency), value, raw);
  assert.equal(parseExtractValue('  exact text  ', { type: 'text' }), '  exact text  ');
});

test('typed numbers reject ranges, multiple values, missing currencies and unsupported units', () => {
  for (const raw of ['SGD 180–200', 'SGD 180 to 200', 'SGD 180 / SGD 200', 'SGD 180, 200', '12 kg', '12%', '1,23,456', 'NaN', '12abc']) {
    assert.throws(() => number(raw), undefined, raw);
  }
  for (const raw of ['$180', '180', 'USD 180', 'S$180 USD']) assert.throws(() => number(raw, 'SGD'), undefined, raw);
});

test('typed evidence preserves observed currency and normalization without converting', () => {
  const usd = parseExtractEvidence('USD 180', { type: 'number' });
  const sgd = parseExtractEvidence('S$180', { type: 'number' });
  assert.equal(parseExtractEvidence('S$180 per night', { type: 'number' }).unit, 'night');
  assert.equal(usd.currency, 'USD');
  assert.equal(sgd.currency, 'SGD');
  assert.notEqual(usd.currency, sgd.currency);
  assert.equal(parseExtractEvidence('$180', { type: 'number' }).currency, 'dollar');
  assert.match(parseExtractEvidence('1.234', { type: 'number' }).normalization, /three digits.*group/i);
});

test('typed dates require an explicit unambiguous valid year and calendar date', () => {
  for (const [raw, value] of [['2024-02-29', '2024-02-29'], ['29 February 2024', '2024-02-29'], ['March 4, 2025', '2025-03-04'], ['31/03/2025', '2025-03-31'], ['Check-in: 4 March 2025', '2025-03-04']]) assert.equal(date(raw), value);
  for (const raw of ['03/04', '03/04/2025', '29 February 2025', '2025-02-29', '2024-02-30', '31 April 2025', 'March 4', '2025-03-04 to 2025-03-05']) assert.throws(() => date(raw), undefined, raw);
});

test('bindings retain exact selected evidence and stop for uncertain or malformed choices', () => {
  const ctx = context();
  const step = { action: 'extract', target: 'price', binding: 'p', extraction: { type: 'number', currency: 'SGD' } };
  const row = { step: '2.then.1' };
  assert.deepEqual(settleJudgment(ctx, step, row, { spans: [{ text: 'S$180', i: 4 }] }, { extract: choice() }), { result: {} });
  assert.deepEqual(ctx.bindings.get('p'), { normalization: parseExtractEvidence('S$180', step.extraction).normalization, source_step: '2.then.1', value: 180, raw: 'S$180', p: 0.95, type: 'number', currency: 'SGD', url: 'https://example.test/offer', span: 4 });
  assert.equal(ctx.report.bindings[0].name, 'p');
  assert.equal(ctx.report.bindings[0].step, '2.then.1');
  for (const answer of [choice('l1', 0.74), choice('none'), choice('l99'), { type: 'choice', choice: 'l1', probabilities: { l1: NaN } }, choice('l1', 1.1), choice('l1', '0.95'), { ...choice(), probabilities: { l1: 0.95, l2: -0.1 } }]) {
    const bad = context();
    assert.ok(settleJudgment(bad, { ...step, optional: true }, {}, { spans: [{ text: 'S$180', i: 0 }] }, { extract: answer }).result.stop);
    assert.equal(bad.bindings.size, 0);
  }
});

test('records bind only when every field has evidence and preserve field sources', () => {
  const step = { action: 'extract', binding: 'offer', fields: [{ name: 'price', type: 'number', currency: 'SGD' }, { name: 'cancellation', type: 'text' }] };
  const j = { fields: { price: { spans: [{ text: 'SGD 180', i: 2 }] }, cancellation: { spans: [{ text: 'Free cancellation', i: 3 }] } } };
  const ctx = context();
  assert.deepEqual(settleJudgment(ctx, step, { step: 1 }, j, { 'extract.price': choice(), 'extract.cancellation': choice() }), { result: {} });
  const offer = ctx.bindings.get('offer');
  assert.deepEqual(offer.value, { price: 180, cancellation: 'Free cancellation' });
  assert.equal(offer.fields.price.raw, 'SGD 180');
  const bad = context();
  assert.ok(settleJudgment(bad, step, {}, j, { 'extract.price': choice(), 'extract.cancellation': choice('none') }).result.stop);
  assert.equal(bad.bindings.size, 0);
});

test('block conditions require decisive finite probabilities; inline conditions retain 0.5', () => {
  assert.ok(JUDGED.has('branch'));
  for (const [p, side] of [[0.75, 'then'], [1, 'then'], [0.25, 'else'], [0, 'else']]) {
    const row = {};
    assert.deepEqual(settleJudgment(context(), { action: 'branch' }, row, {}, { cond: { noul: p } }), { result: {} });
    assert.equal(row.branch, side);
    assert.equal(row.skipped_branch, side === 'then' ? 'else' : 'then');
  }
  for (const p of [0.5, NaN, -1, 2, undefined]) assert.match(settleJudgment(context(), { action: 'branch' }, {}, {}, { cond: { noul: p } }).result.stop.reason, /condition unresolved/);
  assert.deepEqual(settleJudgment(context(), { action: 'if', then: { action: 'click' } }, {}, {}, { cond: { noul: 0.5 } }), { then: { action: 'click' } });
});

test('record names preserve __proto__ as an own data field', () => {
  const ctx = context();
  const fields = Object.fromEntries([['__proto__', { spans: [{ text: 'Observed policy', i: 1 }] }]]);
  const result = settleJudgment(ctx, { action: 'extract', binding: 'r', fields: [{ name: '__proto__', type: 'text' }] }, { step: 1 }, { fields }, { 'extract.__proto__': choice() });
  assert.deepEqual(result, { result: {} });
  const binding = ctx.bindings.get('r');
  assert.ok(Object.hasOwn(binding.value, '__proto__'));
  assert.equal(binding.value.__proto__, 'Observed policy');
  assert.equal(binding.p, 0.95);
});

test('failed records retain selected partial evidence without creating a binding', () => {
  const ctx = context(), row = { step: 2 };
  const step = { action: 'extract', binding: 'offer', fields: [{ name: 'price', type: 'number', currency: 'SGD' }, { name: 'policy', type: 'text' }] };
  const j = { fields: { price: { spans: [{ text: 'SGD 180', i: 0 }] }, policy: { spans: [{ text: 'No policy', i: 1 }] } } };
  assert.ok(settleJudgment(ctx, step, row, j, { 'extract.price': choice(), 'extract.policy': choice('none') }).result.stop);
  assert.equal(ctx.bindings.size, 0);
  assert.equal(row.extracted.fields.price.value, 180);
  assert.equal(ctx.report.extracted[0].fields.price.raw, 'SGD 180');
  assert.equal(ctx.report.extracted[0].partial, true);
});

test('unbound extraction retains exact line and source metadata', () => {
  const ctx = context(), row = { step: '3.then.1' };
  settleJudgment(ctx, { action: 'extract', target: 'policy' }, row, { spans: [{ text: 'Exact policy', i: 7 }] }, { extract: choice() });
  const evidence = ctx.report.extracted[0];
  assert.equal(evidence.raw, 'Exact policy');
  assert.equal(evidence.url, ctx.view.url);
  assert.equal(evidence.span, 7);
  assert.equal(evidence.source_step, '3.then.1');
  assert.equal(evidence.normalization, 'Exact observed text');
});

test('bound extraction rejects numeric-equivalent unoffered choice identifiers', () => {
  const ctx = context();
  const result = settleJudgment(ctx, { action: 'extract', target: 'policy', binding: 'p' }, {}, { spans: [{ text: 'Observed policy', i: 0 }] }, { extract: choice('l01') });
  assert.ok(result.result.stop);
  assert.equal(ctx.bindings.size, 0);
});
test('required three-letter currencies are parsed from explicit evidence', () => {
  assert.equal(parseExtractValue('NOK 180', {type:'number',currency:'NOK'}),180);
  assert.throws(()=>parseExtractValue('180',{type:'number',currency:'NOK'}));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExtractValue, parseExtractEvidence } from '../lib/judge.mjs';
import { settleJudgment, JUDGED } from '../lib/do/judgments.mjs';

const number = (raw, currency) => parseExtractValue(raw, { type: 'number', ...(currency ? { currency } : {}) });
const date = raw => parseExtractValue(raw, { type: 'date' });
const choice = (id = 'l1', p = 0.95) => ({ type: 'choice', choice: id, probabilities: { [id]: p } });
const context = () => ({ ask: async () => ({ answers: { extract_verify: { noul: .9 } }, ms: 1 }), bindings: new Map(), report: {}, view: { url: 'https://example.test/offer' } });

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
  assert.throws(() => parseExtractEvidence('1.234', { type: 'number' }), /ambiguous/i);
});

test('typed dates require an explicit unambiguous valid year and calendar date', () => {
  for (const [raw, value] of [['2024-02-29', '2024-02-29'], ['29 February 2024', '2024-02-29'], ['March 4, 2025', '2025-03-04'], ['31/03/2025', '2025-03-31'], ['Check-in: 4 March 2025', '2025-03-04']]) assert.equal(date(raw), value);
  for (const raw of ['03/04', '03/04/2025', '29 February 2025', '2025-02-29', '2024-02-30', '31 April 2025', 'March 4', '2025-03-04 to 2025-03-05']) assert.throws(() => date(raw), undefined, raw);
});

test('bindings retain exact selected evidence and stop for uncertain or malformed choices', async () => {
  const ctx = context();
  const step = { action: 'extract', target: 'price', binding: 'p', extraction: { type: 'number', currency: 'SGD' } };
  const row = { step: '2.then.1' };
  assert.deepEqual(await settleJudgment(ctx, step, row, { spans: [{ text: 'S$180', i: 4 }] }, { extract: choice() }), { result: {} });
  assert.deepEqual(ctx.bindings.get('p'), { normalization: parseExtractEvidence('S$180', step.extraction).normalization, members: [{ value: 'S$180', p: .95, span: 4 }], source_step: '2.then.1', value: 180, raw: 'S$180', p: 0.95, type: 'number', currency: 'SGD', url: 'https://example.test/offer', span: 4 });
  assert.equal(ctx.report.bindings[0].name, 'p');
  assert.equal(ctx.report.bindings[0].step, '2.then.1');
  for (const answer of [choice('none'), choice('l99'), { type: 'choice', choice: 'l1', probabilities: { l1: NaN } }, choice('l1', 1.1), choice('l1', '0.95'), { ...choice(), probabilities: { l1: 0.95, l2: -0.1 } }]) {
    const bad = context();
    assert.ok((await settleJudgment(bad, { ...step, optional: true }, {}, { spans: [{ text: 'S$180', i: 0 }] }, { extract: answer })).result.stop);
    assert.equal(bad.bindings.size, 0);
  }
});

test('records bind only when every field has evidence and preserve field sources', async () => {
  const step = { action: 'extract', binding: 'offer', fields: [{ name: 'price', type: 'number', currency: 'SGD' }, { name: 'cancellation', type: 'text' }] };
  const j = { fields: { price: { spans: [{ text: 'SGD 180', i: 2 }] }, cancellation: { spans: [{ text: 'Free cancellation', i: 3 }] } } };
  const ctx = context();
  assert.deepEqual(await settleJudgment(ctx, step, { step: 1 }, j, { 'extract.price': choice(), 'extract.cancellation': choice() }), { result: {} });
  const offer = ctx.bindings.get('offer');
  assert.deepEqual(offer.value, { price: 180, cancellation: 'Free cancellation' });
  assert.equal(offer.fields.price.raw, 'SGD 180');
  const bad = context();
  assert.ok((await settleJudgment(bad, step, {}, j, { 'extract.price': choice(), 'extract.cancellation': choice('none') })).result.stop);
  assert.equal(bad.bindings.size, 0);
});

test('block conditions require decisive finite probabilities; inline conditions retain 0.5', async () => {
  assert.ok(JUDGED.has('branch'));
  for (const [p, side] of [[0.75, 'then'], [1, 'then'], [0.25, 'else'], [0, 'else']]) {
    const row = {};
    assert.deepEqual(await settleJudgment(context(), { action: 'branch' }, row, {}, { cond: { noul: p } }), { result: {} });
    assert.equal(row.branch, side);
    assert.equal(row.skipped_branch, side === 'then' ? 'else' : 'then');
  }
  for (const p of [0.5, NaN, -1, 2, undefined]) assert.match((await settleJudgment(context(), { action: 'branch' }, {}, {}, { cond: { noul: p } })).result.stop.reason, /condition unresolved/);
  assert.deepEqual(await settleJudgment(context(), { action: 'if', then: { action: 'click' } }, {}, {}, { cond: { noul: 0.5 } }), { then: { action: 'click' } });
});

test('record names preserve __proto__ as an own data field', async () => {
  const ctx = context();
  const fields = Object.fromEntries([['__proto__', { spans: [{ text: 'Observed policy', i: 1 }] }]]);
  const result = await settleJudgment(ctx, { action: 'extract', binding: 'r', fields: [{ name: '__proto__', type: 'text' }] }, { step: 1 }, { fields }, { 'extract.__proto__': choice() });
  assert.deepEqual(result, { result: {} });
  const binding = ctx.bindings.get('r');
  assert.ok(Object.hasOwn(binding.value, '__proto__'));
  assert.equal(binding.value.__proto__, 'Observed policy');
  assert.equal(binding.p, 0.95);
});

test('failed records retain selected partial evidence without creating a binding', async () => {
  const ctx = context(), row = { step: 2 };
  const step = { action: 'extract', binding: 'offer', fields: [{ name: 'price', type: 'number', currency: 'SGD' }, { name: 'policy', type: 'text' }] };
  const j = { fields: { price: { spans: [{ text: 'SGD 180', i: 0 }] }, policy: { spans: [{ text: 'No policy', i: 1 }] } } };
  assert.ok((await settleJudgment(ctx, step, row, j, { 'extract.price': choice(), 'extract.policy': choice('none') })).result.stop);
  assert.equal(ctx.bindings.size, 0);
  assert.equal(row.extracted.fields.price.value, 180);
  assert.equal(ctx.report.extracted[0].fields.price.raw, 'SGD 180');
  assert.equal(ctx.report.extracted[0].partial, true);
});

test('unbound extraction retains exact line and source metadata', async () => {
  const ctx = context(), row = { step: '3.then.1' };
  await settleJudgment(ctx, { action: 'extract', target: 'policy' }, row, { spans: [{ text: 'Exact policy', i: 7 }] }, { extract: choice() });
  const evidence = ctx.report.extracted[0];
  assert.equal(evidence.raw, 'Exact policy');
  assert.equal(evidence.url, ctx.view.url);
  assert.equal(evidence.span, 7);
  assert.equal(evidence.source_step, '3.then.1');
  assert.equal(evidence.normalization, 'Exact observed text');
});

test('bound extraction rejects numeric-equivalent unoffered choice identifiers', async () => {
  const ctx = context();
  const result = await settleJudgment(ctx, { action: 'extract', target: 'policy', binding: 'p' }, {}, { spans: [{ text: 'Observed policy', i: 0 }] }, { extract: choice('l01') });
  assert.ok(result.result.stop);
  assert.equal(ctx.bindings.size, 0);
});
test('required three-letter currencies are parsed from explicit evidence', () => {
  assert.equal(parseExtractValue('NOK 180', {type:'number',currency:'NOK'}),180);
  assert.throws(()=>parseExtractValue('180',{type:'number',currency:'NOK'}));
});

test('split probability mass binds agreeing text lines', async () => {
  const ctx = context(), row = { step: 1 };
  const result = await settleJudgment(ctx, { action: 'extract', binding: 's' }, row,
    { spans: [{ text: '3.3k stars', i: 0 }, { text: 'Star3.3k', i: 1 }] },
    { extract: { type: 'choice', choice: 'l1', probabilities: { l1: .56, l2: .27, none: .17 } } });
  assert.deepEqual(result, { result: {} });
  assert.equal(ctx.bindings.get('s').p, .83);
  assert.equal(ctx.bindings.get('s').members.length, 2);
});

test('compact numbers preserve locale parsing and describe rounding', () => {
  for (const [raw, value] of [['3.3k',3300], ['3.3k stars',3300], ['Star3.3k',3300], ['2K',2000], ['2M',2000000], ['2B',2000000000], ['2 lakh',200000], ['2 crore',20000000]]) {
    assert.equal(number(raw), value, raw);
    assert.match(parseExtractEvidence(raw, { type: 'number' }).normalization, /rounded by the page/);
  }
  assert.throws(() => number('1,234'), /ambiguous/i);
  assert.equal(parseExtractValue('1,234', { type: 'number', lang: 'en' }), 1234);
  assert.throws(() => number('1.234'), /ambiguous/i);
  assert.equal(parseExtractValue('1.234', { type: 'number', lang: 'de' }), 1234);
  for (const raw of ['3.3k to 4k', '3.3k stars 202 forks']) assert.throws(() => number(raw));
});

test('binding calibrates distinct values and explains failed candidates', async () => {
  for (const [a,b,ok] of [[.5,.4,false],[.6,.14,true],[.6,.3,false]]) {
    const ctx = context();
    const result = await settleJudgment(ctx, { action: 'extract', binding: 'n', extraction: { type: 'number' } }, {},
      { spans: [{ text: '100', i: 0 }, { text: '200', i: 1 }] },
      { extract: { type: 'choice', choice: 'l1', probabilities: { l1: a, l2: b } } });
    assert.equal(ctx.bindings.has('n'),ok);
    if (!ok) {
      assert.match(result.result.stop.reason,/100.*p=0\.[56].*200.*p=0\.[34]/);
      assert.match(result.result.stop.reason,/0\.75.*0\.5.*0\.15/);
    }
  }
});

test('typed grouping combines parsed values while separating currency and units', async () => {
  for (const [raw,ok] of [['USD 1,000',true],['SGD 1000',false],['USD 1000 per night',false]]) {
    const ctx=context();
    await settleJudgment(ctx,{action:'extract',binding:'n',extraction:{type:'number'}},{},
      {lang:'en',spans:[{text:'USD 1k',i:0},{text:raw,i:1}]},
      {extract:{type:'choice',choice:'l1',probabilities:{l1:.56,l2:.27,none:.17}}});
    assert.equal(ctx.bindings.has('n'),ok,raw);
  }
});

test('failed typed binding reports parse failure with the observed line', async () => {
  const result=await settleJudgment(context(),{action:'extract',binding:'n',extraction:{type:'number'}},{},
    {spans:[{text:'No count',i:0}]},{extract:choice()});
  assert.match(result.result.stop.reason,/could not read a number from "No count"/);
});

test('typed count groups keep stars and forks distinct', async () => {
  const ctx=context();
  const result=await settleJudgment(ctx,{action:'extract',binding:'n',extraction:{type:'number'}},{},
    {spans:[{text:'3.3k stars',i:0},{text:'3.3k forks',i:1}]},
    {extract:{type:'choice',choice:'l1',probabilities:{l1:.56,l2:.27,none:.17}}});
  assert.ok(result.result.stop);
});

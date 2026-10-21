import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExtractValue, extractValues, shortlistSpans, extractQuestion } from '../lib/judge.mjs';

const number = (text, lang) => parseExtractValue(text, { type: 'number', lang });

test('localized grouping and CJK multipliers preserve displayed numeric value', () => {
  for (const text of ['6.110.200', '6 110 200', '6\u00a0110\u00a0200', '6\u202f110\u202f200', '6\u2009110\u2009200', '6,110,200', "6'110'200"]) assert.equal(number(text), 6110200, text);
  assert.equal(number('6.110.200', 'en'), 6110200);
  assert.equal(number('6,110,200', 'de'), 6110200);
  assert.equal(number('1405万'), 14050000);
  assert.equal(number('1.4億'), 140000000);
  assert.equal(number('1.4亿'), 140000000);
  assert.deepEqual(extractValues('人口は1405万です', { type: 'number' }), ['1405万']);
  assert.deepEqual(extractValues('人口: 1405万', { type: 'number' }), []);
});

test('ambiguous single separators require page language', () => {
  for (const text of ['1.234', '1,234']) assert.throws(() => number(text), /ambiguous/);
  assert.equal(number('1.234', 'de-DE'), 1234);
  assert.equal(number('1.234', 'en'), 1.234);
  assert.equal(number('1,234', 'fr'), 1.234);
  assert.equal(number('1,234', 'en-US'), 1234);
  assert.throws(() => number('1.23', 'de'), /ambiguous/);
  for (const text of ['6.11.200', '6 11 200', "6'11'200"]) assert.throws(() => number(text), /ambiguous/);
});

test('structured and heading facts survive a different question language within caps', () => {
  const spans = Array.from({ length: 5000 }, (_, i) => ({ text: `irrelevant paragraph ${i} ${'x'.repeat(100)}` }));
  spans[4201] = { text: 'Capitale: Paris', structured: true };
  spans[4202] = { text: '人口: 14,050,000', structured: true };
  spans[4203] = { text: '6.110.200', heading: 'Einwohner' };
  const offered = shortlistSpans(spans, 'the capital city');
  for (const i of [4201, 4202, 4203]) assert.ok(offered.some(s => s.i === i));
  assert.ok(offered.length <= 254);
  assert.ok(JSON.stringify(extractQuestion('the capital city', offered)).length <= 24000);
});

test('typed digit boost works independently of question words', () => {
  const spans = Array.from({ length: 1000 }, (_, i) => `unrelated prose ${String.fromCharCode(0x4e00 + i)}`);
  spans[811] = '1405万';
  spans[812] = '2007-03-14';
  assert.ok(shortlistSpans(spans, '東京都の人口', 24000, new Set(), { type: 'number' }).some(s => s.i === 811));
  assert.ok(shortlistSpans(spans, '独立日', 24000, new Set(), { type: 'date' }).some(s => s.i === 812));
});

test('embedded CJK facts retain typed value boundaries without spaces', () => {
  assert.deepEqual(extractValues('独立于1965年8月9日', { type: 'date' }), ['1965年8月9日']);
  assert.deepEqual(extractValues('人口は1405万人です', { type: 'number' }), ['1405万人']);
});

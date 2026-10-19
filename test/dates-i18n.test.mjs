// Dates in the languages calendars use, in Node and (the same function) in the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseDateText, monthNumber } from '../lib/page/shared.mjs';
import { helperSource, page } from '../lib/page/index.mjs';

const want = { y: 2026, m: 10, d: 16 };
const SAMPLES = [
  'Friday, 16 October 2026', 'Oct 16, 2026', '16, Friday, October 2026. Available', 'October 16th, 2026', '10/16/2026', '2026-10-16',
  'Freitag, 16. Oktober 2026', '16.10.2026', 'vendredi 16 octobre 2026', 'viernes, 16 de octubre de 2026', 'sexta-feira, 16 de outubro de 2026',
  'venerdì 16 ottobre 2026', 'vrijdag 16 oktober 2026', 'fredag 16 oktober 2026', 'piątek, 16 października 2026', '16 Ekim 2026 Cuma',
  'пятница, 16 октября 2026 г.', '16 жовтня 2026', 'Jumat, 16 Oktober 2026', 'Thứ Sáu, 16 tháng 10, 2026', '2026年10月16日 (金)', '2026년 10월 16일 금요일',
];

test('a date in many languages and formats', () => {
  for (const s of SAMPLES) assert.deepEqual(parseDateText(s), want, s);
  assert.equal(parseDateText('When Add dates'), null);
  assert.equal(parseDateText('16 oktober'), null, 'no year');
  assert.equal(parseDateText('Settings 12 2026'), null, 'a word that only looks like a month prefix is not one with a day');
});

test('month words', () => {
  assert.equal(monthNumber('März'), 3);
  assert.equal(monthNumber('juin'), 6);
  assert.equal(monthNumber('juillet'), 7);
  assert.equal(monthNumber('mayo'), 5);
  assert.equal(monthNumber('мая'), 5);
  assert.equal(monthNumber('марта'), 3);
  assert.equal(monthNumber('Friday'), null);
  assert.equal(monthNumber('12'), null);
});

test('the page runs the same parser', () => {
  const inPage = vm.runInNewContext(`(() => { ${helperSource('parseDateText')}; return ${JSON.stringify(SAMPLES)}.map(parseDateText); })()`);
  for (const r of inPage) assert.deepEqual({ ...r }, want);
  assert.doesNotThrow(() => new vm.Script(page('date-page', { iso: '2026-10-16', pin: 'x' })));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseDateText } from '../lib/page/shared.mjs';
import { helperSource } from '../lib/page/index.mjs';
import { parsePlan } from '../lib/do/plan.mjs';

const locales = [
  ['CJK', '1965年8月9日', '2024年2月29日', '2023年2月29日'],
  ['German', '9. August 1965', '29. Februar 2024', '29. Februar 2023'],
  ['French', '9 août 1965', '29 février 2024', '29 février 2023'],
  ['Spanish', '9 de agosto de 1965', '29 de febrero de 2024', '29 de febrero de 2023'],
  ['Italian', '9 agosto 1965', '29 febbraio 2024', '29 febbraio 2023'],
  ['Portuguese', '9 de agosto de 1965', '29 de fevereiro de 2024', '29 de fevereiro de 2023'],
  ['Dutch', '9 augustus 1965', '29 februari 2024', '29 februari 2023'],
];
for (const [locale, regular, leap, invalid] of locales) {
  test(`${locale} extraction dates validate actual calendar days`, () => {
    assert.deepEqual(parseDateText(regular), { y: 1965, m: 8, d: 9 });
    assert.deepEqual(parseDateText(leap), { y: 2024, m: 2, d: 29 });
    assert.equal(parseDateText(invalid), null);
  });
}
test('ISO, year-first slash and localized dates reject invalid and ambiguous values', () => {
  for (const value of ['1965-08-09', '独立年: 1965/8/9']) assert.deepEqual(parseDateText(value), { y: 1965, m: 8, d: 9 });
  for (const value of ['2024-02-30', '2023-04-31', '1900-02-29', '1965年8月900日', '9/8/1965', '9.8.1965']) assert.equal(parseDateText(value), null, value);
  assert.deepEqual(parseDateText('2000-02-29'), { y: 2000, m: 2, d: 29 });
  const pageParser = vm.runInNewContext(`(() => { ${helperSource('parseDateText')}; return parseDateText; })()`);
  assert.equal(JSON.stringify(pageParser('9 août 1965')), JSON.stringify({ y: 1965, m: 8, d: 9 }));
  assert.equal(pageParser('29 février 2023'), null);
});
test('top-level semicolons and newlines split extraction steps', () => {
  for (const delimiter of ['; ', '\n']) {
    const plan = parsePlan(`extract "a"${delimiter}extract "b"`);
    assert.deepEqual(plan.map(node => node.target), ['a', 'b']);
    assert.deepEqual(plan.map(node => node.path), ['1', '2']);
  }
  const plan = parsePlan('extract "a" as $a; extract "b" as $b\nanswer "${a} ${b}"');
  assert.equal(plan.length, 3);
  assert.equal(plan[1].binding, 'b');
});
test('quoted separators and existing single-step arguments remain literal', () => {
  for (const source of ['extract "a;b"', 'extract "a\nb"', 'type "a;b"', 'fill "Name" = "a;b"']) assert.equal(parsePlan(source).length, 1, source);
  assert.equal(parsePlan('extract "a;b"')[0].target, 'a;b');
  assert.equal(parsePlan('type first; second')[0].target, 'first; second');
  assert.equal(parsePlan('fill "Name" = first\nsecond')[0].value, 'first\nsecond');
  assert.equal(parsePlan('type "a;b"; extract "c"').length, 2);
  assert.throws(() => parsePlan('extract "a"; nonsense "b"'), /Unknown step/);
});

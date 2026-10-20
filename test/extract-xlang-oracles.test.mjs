import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const cases = JSON.parse(fs.readFileSync(new URL('../bench/extract-eval/cases.json', import.meta.url)));
const source = fs.readFileSync(new URL('../bench/extract-eval/run.mjs', import.meta.url), 'utf8');
// Exercise only the independent oracle helpers, without starting an eval browser.
const helpers = source.slice(source.indexOf('const normalize ='), source.indexOf('\ntry {\n  if (!dia)'));
function fixture(rows) {
  const document = { querySelectorAll: () => rows.map(([label, value]) => ({
    textContent: `${label}: ${value}`,
    querySelector: selector => ({ textContent: /^(?:th|th, td:first-child)$/.test(selector) ? label : value }),
  })) };
  return vm.runInNewContext(helpers + '\n({ oracle, matches })', {
    conn: null, ops: { evaluate: async (_conn, _tab, expression) => vm.runInNewContext(expression, { document }) }, setTimeout,
  });
}
const get = id => cases.find(c => c.id === id);
test('all ten requested cases have independent oracles', () => {
  const ids = ['de-population','fr-capital','ja-population','zh-founded','zh-question-en-page','es-question-en-page','paraphrase-forks','paraphrase-python','absent-xlang','pypi-license'];
  for (const id of ids) assert.ok(get(id), id);
  for (const id of ids.filter(id => id !== 'absent-xlang')) assert.ok(get(id).expect.selector, id);
  assert.equal(get('absent-xlang').expect, 'stop');
});
test('localized table oracles select the labelled row and independently parse values', async () => {
  for (const [id, rows, expected] of [
    ['de-population', [['Fläche', '736,3'], ['Einwohnerzahl', '6.110.200 (2026)']], 6110200],
    ['ja-population', [['面積', '2194'], ['総人口', '14,050,000人']], 14050000],
    ['zh-founded', [['建國', '1819年2月6日'], ['獨立建國', '1965年8月9日']], '1965-08-09'],
  ]) {
    const { oracle, matches } = fixture(rows);
    const result = await oracle(null, get(id));
    assert.equal(result.exact, expected);
    assert.equal(matches(expected, result), true);
    assert.equal(matches(expected === 6110200 ? 6000000 : 'wrong', result), false);
  }
});
test('capital oracle retains exact selected value', async () => {
  const { oracle, matches } = fixture([['Superficie', '643801'], ['Capitale', 'Paris']]);
  const result = await oracle(null, get('fr-capital'));
  assert.equal(matches('Paris', result), true);
  assert.equal(matches('Lyon', result), false);
});
test('fork oracle rejects rounded header count when sidebar displays greater precision', async () => {
  const { matches } = fixture([]);
  assert.equal(matches(40000, { exact: 40300 }), false);
  assert.equal(matches(40300, { exact: 40300 }), true);
});
test('license equivalence does not accept a different license', () => {
  const { matches } = fixture([]);
  const expected = { exactText: 'MIT License (MIT)', kind: 'license' };
  for (const value of ['MIT', 'MIT License', 'PyCDP: MIT License', 'License: MIT License (MIT)']) assert.equal(matches(value, expected), true, value);
  assert.equal(matches('Apache-2.0', expected), false);
});

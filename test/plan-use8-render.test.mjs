import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// runSteps always initializes a browser. Exercise its private, pure interpolation
// boundary directly, using the production functions rather than a copied version.
const source = readFileSync(new URL('../lib/steps.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function render(ctx, template, sources) {');
const end = source.indexOf('\nasync function runPlan(', start);
assert.ok(start >= 0 && end > start, 'render function section exists');
// Exported helpers may sit in this section; a vm script can't contain `export`.
const render = vm.runInNewContext(`${source.slice(start, end).replace(/^export /gm, '')}\nrender`);

function interpolate(value, template = 'Selected: ${picked}') {
  const binding = { type: 'record', value, raw: 'visible list', p: 0.98, step: 1 };
  const bindings = new Map([['picked', binding]]);
  const sources = [];
  const answer = render({ bindings }, template, sources);
  return { answer, binding, bindings, sources };
}

test('ranked pick answers show record text and retain structured sources', () => {
  const records = [
    { text: '11 Mar 2027 - Site E101 is available', key: '2027-03-11', evidence: '11 Mar 2027', order: 2 },
    { text: '12 Mar 2027 - Site E102 is available', key: '2027-03-12', evidence: '12 Mar 2027', order: 3 },
  ];
  const before = structuredClone(records);
  const result = interpolate(records);
  assert.equal(result.answer, `Selected: ${records[0].text}; ${records[1].text}`);
  assert.equal(result.bindings.get('picked'), result.binding);
  assert.equal(result.sources[0].name, 'picked');
  assert.equal(result.sources[0].value, records);
  for (const key of ['type', 'raw', 'p', 'step']) assert.equal(result.sources[0][key], result.binding[key]);
  assert.deepEqual(records, before);
});

test('ranked pick answer templates expose title, link, and key fields', () => {
  const records = [{ title: 'Chair', text: 'Chair · $50', link: 'https://example.test/chair', key: 50 }];
  const result = interpolate(records, '${picked.title} | ${picked.link} | ${picked.key}');
  assert.equal(result.answer, 'Chair | https://example.test/chair | 50');
  assert.equal(result.sources.length, 3);
});

test('plain arrays render semicolon-separated values including nested arrays', () => {
  assert.equal(interpolate(['Cabin A', 'Cabin B', 0, false, ['Cabin C', 'Cabin D']]).answer,
    'Selected: Cabin A; Cabin B; 0; false; Cabin C; Cabin D');
  assert.equal(interpolate([]).answer, 'Selected: ');
});

test('objects without string text keep their JSON fallback', () => {
  for (const value of [{ key: 12, evidence: 'Score 12' }, { text: 42, key: 12 }, { text: null }]) {
    assert.equal(interpolate(value).answer, `Selected: ${JSON.stringify(value)}`);
  }
  assert.equal(interpolate({ text: '', key: 12 }).answer, 'Selected: ');
});

test('escaped interpolation stays literal and missing bindings still stop', () => {
  const result = interpolate({ text: 'Cabin A' }, '\\${picked} / ${picked}');
  assert.equal(result.answer, '${picked} / Cabin A');
  assert.equal(result.sources.length, 1);
  assert.throws(() => interpolate([], '${missing}'), /Missing binding \$missing/);
});

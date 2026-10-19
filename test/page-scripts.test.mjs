// Every page script in lib/page parses on its own, and the loader's expression for it (with
// the shared helpers it names put in front) parses too. No browser: a syntax slip in a page
// file shows up here instead of as a failed evaluate on some site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { page, pageNames, source, helperSource } from '../lib/page/index.mjs';
import * as shared from '../lib/page/shared.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'page');

// Sample args for each script: enough that JSON.stringify gives what callers pass.
const SAMPLE = {
  'date-page': { iso: '2026-10-17', pin: 'bc1' },
  'date-opener': { pin: 'bc1' },
  'date-look': { selector: '[data-bc-pin="bc1-day"]', iso: '2026-10-17' },
  'date-shown': { selector: '[data-bc-pin="bc1-day"]', iso: '2026-10-17', before: { look: 'a|b', lines: 1 } },
  'slider-find': { pin: 'bc1', only: null },
  'slider-set-native': { selector: '#r', value: 40 },
  'pin-refs': { pins: [['ref_1', 'bc1'], ['ref_2', 'bc2']], token: '1:ab' },
  'find-direct': { kind: 'selector', value: '#x', key: 'bc1', action: 'click' },
  'name-unnamed': { refs: ['ref_1'] },
  'near-context': { refs: ['ref_1'] },
  'disclosure-state': { selector: '#x', activate: true },
  'find': { pattern: 'a"b\\s', limit: 6, pin: true },
  'fields': { all: true },
  'items': { maxItems: 30, maxGroups: 8 },
  'snapshot': { maxText: 0, max: 1500, all: true, includeHidden: false },
  'resolve-element': { ref: 'ref_3', token: '1:ab' },
  'ref-lookup': { ref: 'e12', token: null },
  'settle-watch': { longPoll: 3000 },
  'settle-state': { beforeStep: 300 },
  'net-watch': { longPoll: 3000 },
};
const SELECTOR_ONLY = { selector: '[data-bc-pin="bc1"]' };

test('every lib/page script is one function expression that parses', () => {
  const names = pageNames();
  assert.ok(names.length >= 30, `found ${names.length} page scripts`);
  for (const name of names) {
    const src = fs.readFileSync(path.join(DIR, `${name}.js`), 'utf8');
    assert.doesNotThrow(() => new vm.Script(src, { filename: `${name}.js` }), `${name}.js does not parse`);
    // One expression: wrapping it as a call parses only if the file is a single function.
    assert.doesNotThrow(() => new vm.Script(`(${source(name)})({})`), `${name}.js is not a single function expression`);
    assert.equal(typeof vm.runInNewContext(`(${source(name)})`), 'function', `${name}.js is not a function`);
  }
});

test('the loader output parses for sample args, with the helpers each script uses', () => {
  for (const name of pageNames()) {
    const expr = page(name, SAMPLE[name] || SELECTOR_ONLY);
    assert.doesNotThrow(() => new vm.Script(expr, { filename: `${name} (loaded)` }), `${name}: the loader's expression does not parse`);
  }
  // Helpers come along by name, and the helpers they use with them.
  assert.match(page('date-page', SAMPLE['date-page']), /function parseDateText\(/);
  assert.match(page('date-page', SAMPLE['date-page']), /const MONTHS = \[/);
  assert.match(page('date-shown', SAMPLE['date-shown']), /function dateCheck\([\s\S]*function findDeep\(/);
  assert.doesNotMatch(page('page-params'), /function \w+\(/, 'a script that names no helper gets none');
});

test('shared helpers stand alone: each one parses as page source', () => {
  for (const name of Object.keys(shared)) assert.doesNotThrow(() => new vm.Script(helperSource(name)), `${name}`);
});

test('no double escaping is left in page scripts', () => {
  for (const name of pageNames()) {
    const src = source(name);
    // In a real file a regex says \s, \d, \b; a doubled backslash before one of those inside a
    // regex literal is a leftover from a template string. (A string passed to new RegExp still
    // needs '\\b', and does not match this.)
    assert.doesNotMatch(src, /\/[^/\n'"`]*\\\\[sdbwSDBW][^/\n]*\/[gimsuy]*[.,;)\s]/, `${name}.js still has a doubled escape in a regex literal`);
  }
});

test('the shared date parser in Node and in the page is one function', async () => {
  const { parseDateText } = await import('../lib/steps.mjs');
  assert.equal(parseDateText, shared.parseDateText);
  const inPage = vm.runInNewContext(`(() => { ${helperSource('parseDateText')}; return parseDateText('Friday, 16 October 2026'); })()`);
  assert.deepEqual({ ...inPage }, { y: 2026, m: 10, d: 16 });
});

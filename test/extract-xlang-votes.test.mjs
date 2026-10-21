import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleJudgment, resolveExtractValues } from '../lib/do/judgments.mjs';

function setup(lines, probabilities, type = 'text', verify = .95) {
  const calls = [];
  const ctx = { bindings: new Map(), report: {}, view: { url: 'https://example.test' }, ask: async (_, questions) => {
    calls.push(questions);
    return { ms: 1, answers: questions.extract_verify ? { extract_verify: { noul: verify } } : { extract_value: { type: 'choice', choice: 'v1', probabilities: { v1: 1 } } } };
  } };
  const spans = lines.map((text, i) => ({ text, i }));
  return { ctx, calls, step: { action: 'extract', target: type === 'text' ? 'the license' : 'the number of forks', binding: 'x', extraction: { type } }, part: { spans, all: spans }, answers: { extract: { type: 'choice', choice: Object.keys(probabilities)[0], probabilities } } };
}
async function settle(s) {
  await resolveExtractValues(s.ctx, s.step, {}, s.part, s.answers);
  return settleJudgment(s.ctx, s.step, {}, s.part, s.answers);
}
test('none-leading compatible license votes pool and verify exactly once', async () => {
  const s = setup(['PyCDP: MIT License', 'License: MIT License (MIT)', 'Classifiers: OSI Approved :: MIT License'], { none: .54, l1: .19, l2: .16, l3: .08 });
  const r = await settle(s);
  assert.equal(r.result.stop, undefined);
  assert.equal(s.ctx.bindings.get('x').rescued, true);
  assert.equal(s.calls.filter(c => c.extract_verify).length, 1);
});
test('conflicting license votes never pool', async () => {
  const s = setup(['MIT License', 'GPL License'], { none: .54, l1: .25, l2: .21 });
  assert.ok((await settle(s)).result.stop);
  assert.equal(s.ctx.bindings.size, 0);
});
test('rescue requires verification at least .7', async () => {
  const s = setup(['MIT License'], { none: .6, l1: .4 }, 'text', .69);
  assert.ok((await settle(s)).result.stop);
  assert.equal(s.ctx.bindings.size, 0);
});
test('rounded button count uses precise sidebar and verifies', async () => {
  const s = setup(['Fork 40k (40k)', '40.3k forks'], { l1: .9, l2: .1 }, 'number');
  assert.equal((await settle(s)).result.stop, undefined);
  assert.equal(s.ctx.bindings.get('x').value, 40300);
  assert.equal(s.ctx.bindings.get('x').precision_upgraded, true);
});
test('conflicting sidebar count stops with both values', async () => {
  const s = setup(['Fork 40k (40k)', '42.3k forks'], { l1: .9, l2: .1 }, 'number');
  const r = await settle(s);
  assert.match(r.result.stop.reason, /40k.*42.3k/);
  assert.equal(s.ctx.bindings.size, 0);
});

test('unbound extraction rescues compatible votes and refuses failed verification', async () => {
  for (const verify of [.95, .69]) {
    const s = setup(['PyCDP: MIT License', 'License: MIT License (MIT)', 'Classifiers: OSI Approved :: MIT License'], { none: .54, l1: .19, l2: .16, l3: .08 }, 'text', verify);
    delete s.step.binding;
    const row = {};
    await settleJudgment(s.ctx, s.step, row, s.part, s.answers);
    assert.equal(row.extracted.value, verify >= .7 ? 'PyCDP: MIT License' : null);
    assert.equal(s.calls.length, 1);
  }
});

test('one uncertain non-none title cannot use split-vote rescue', async () => {
  const s = setup(['2026-10-14, Version 26.12.0 (Current) Latest Oct 14, 2026'], { l1: .48, none: .42 });
  assert.ok((await settle(s)).result.stop);
  assert.equal(s.ctx.bindings.size, 0);
});

test('precise alternatives must agree with each other, including comma decimals', async () => {
  for (const [lines, lang] of [[['40k forks', '40.3k forks', '40.4k forks'], 'en'], [['40k forks', '40,3k forks', '40,4k forks'], 'de']]) {
    const s = setup(lines, { l1: .9, l2: .05, l3: .05 }, 'number');
    s.part.lang = lang;
    assert.match((await settle(s)).result.stop.reason, /conflicting labelled counts/);
    assert.equal(s.ctx.bindings.size, 0);
  }
});
test('release identifier stays separate from adjacent date metadata', async () => {
  const s = setup(['v1.64.1 Latest Oct 14, 2026'], { l1: .9, none: .1 });
  s.step.target = 'the latest release tag';
  assert.equal((await settle(s)).result.stop, undefined);
  assert.equal(s.ctx.bindings.get('x').value, 'v1.64.1');
});

test('pooled text selects the shortest observed value, not its context block', async () => {
  const s = setup(['Capitale: Paris 48° 52′ N, 2° 19,59′ E', 'Paris'], { l1: .49, l2: .35, none: .16 });
  s.step.target = 'the capital city';
  assert.equal((await settle(s)).result.stop, undefined);
  assert.equal(s.ctx.bindings.get('x').value, 'Paris');
});
test('an exact population does not conflict with unrelated person counts', async () => {
  const s = setup(['14,296,683 人', '6,499 人'], { l1: .95, none: .05 }, 'number');
  s.part.lang = 'ja';
  assert.equal((await settle(s)).result.stop, undefined);
  assert.equal(s.ctx.bindings.get('x').value, 14296683);
});

test('compact prices and unitless numbers upgrade only under the same quantity label', async () => {
  for (const [coarse, precise, expected] of [['Price: $1.2M', 'Price: $1.23M', 1230000], ['Population: 1.2M', 'Population: 1.23M', 1230000]]) {
    const s = setup([coarse, precise], { l1: .95, none: .05 }, 'number');
    assert.equal((await settle(s)).result.stop, undefined);
    assert.equal(s.ctx.bindings.get('x').value, expected);
  }
  const s = setup(['Revenue: $1.2M', 'Cost: $1.23M'], { l1: .95, none: .05 }, 'number');
  assert.equal((await settle(s)).result.stop, undefined);
  assert.equal(s.ctx.bindings.get('x').value, 1200000);
});

test('precision upgrades keep the source index of previously omitted page objects', async () => {
  const s = setup(['40k forks'], { l1: .95, none: .05 }, 'number');
  s.part.all = [{ text: '40k forks' }, { text: '40.3k forks' }];
  assert.equal((await settle(s)).result.stop, undefined);
  assert.equal(s.ctx.bindings.get('x').span, 1);
  assert.equal(s.ctx.bindings.get('x').value, 40300);
});

test('precision never upgrades from a differently labelled quantity with the same unit', async () => {
  const s = setup(['Repo A forks: 40k forks', 'Repo B forks: 40.3k forks'], { l1: .95, none: .05 }, 'number');
  assert.equal((await settle(s)).result.stop, undefined);
  assert.equal(s.ctx.bindings.get('x').value, 40000);
});

test('version titles pool with the observed href identifier and emit only that identifier', async () => {
  const s = setup(['v7.8.9', 'June 12, 2031, Version 7.8.9 (Stable) Latest'], { l1: .35, l2: .25, none: .4 });
  s.part.spans[0].source_attribute = 'href';
  s.step.target = 'the latest release tag';
  assert.equal((await settle(s)).result.stop, undefined);
  assert.equal(s.ctx.bindings.get('x').value, 'v7.8.9');
  assert.equal(s.ctx.bindings.get('x').source_attribute, 'href');
  const conflict = setup(['v7.8.9', 'Version 8.0.0'], { l1: .35, l2: .25, none: .4 });
  conflict.part.spans[0].source_attribute = 'href';
  assert.ok((await settle(conflict)).result.stop);
});

test('a confident version title resolves to its single observed identifier', async () => {
  const s = setup(['Version 7.8.9, published June 12, 2031'], { l1: .95, none: .05 });
  s.step.target = 'the published version';
  assert.equal((await settle(s)).result.stop, undefined);
  assert.equal(s.ctx.bindings.get('x').value, '7.8.9');
});

test('a confident named percentage preserves the direct text path without extra judgments', async () => {
  const s = setup(['JavaScript 100%'], { l1: .95, none: .05 });
  s.step.target = 'the primary language';
  assert.equal((await settle(s)).result.stop, undefined);
  assert.equal(s.ctx.bindings.get('x').value, 'JavaScript 100%');
  assert.equal(s.calls.length, 0);
});

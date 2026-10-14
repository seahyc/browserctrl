import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { candidatesFor, shortlist, refusal, pickTarget, checkPage, jevKey, CHECKS } from '../lib/jev.mjs';

const els = [
  { ref: 'ref_1', role: 'button', name: 'Grey' },
  { ref: 'ref_2', role: 'button', name: 'Buy Now' },
  { ref: 'ref_3', role: 'textbox', name: 'Search' },
  { ref: 'ref_4', role: 'button', name: 'Add To Cart', disabled: true },
  { ref: 'ref_5', role: 'link', name: 'Home', href: 'https://shop.example/home?x=1' },
];
const snap = { url: 'https://shop.example/p/1', title: 'Cable ties', text: 'Colour Grey Black', elements: els };
const cfg = { key: 'k', model: 'jev-latest' };

function fakeFetch(answers, seen = []) {
  return async (url, init) => {
    seen.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ model: 'jev-1.13.0', answers }) };
  };
}

test('candidates match the action and skip disabled elements', () => {
  assert.deepEqual(candidatesFor(els, 'click').map(e => e.ref), ['ref_1', 'ref_2', 'ref_3', 'ref_5']);
  assert.deepEqual(candidatesFor(els, 'fill').map(e => e.ref), ['ref_3']);
});

test('shortlist keeps the elements that share words with the intent, in page order', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ ref: `ref_${i}`, role: 'button', name: i === 7 ? 'grey colour' : `x${i}` }));
  assert.deepEqual(shortlist(many, 'the grey one', 3).map(e => e.ref), ['ref_0', 'ref_1', 'ref_7']);
});

test('pickTarget sends candidates as Choice options and returns the ranked distribution', async () => {
  const seen = [];
  const r = await pickTarget(cfg, snap, { intent: 'pick grey' }, {
    fetchImpl: fakeFetch({ target: { type: 'choice', choice: 'ref_1', confidence: 0.9, probabilities: { ref_1: 0.91, ref_2: 0.05, none: 0.04 } } }, seen),
  });
  const q = seen[0].questions.target;
  assert.equal(q.type, 'choice');
  assert.deepEqual(Object.keys(q.criteria), ['none', 'ref_1', 'ref_2', 'ref_3', 'ref_5']);
  assert.equal(q.criteria.ref_5.link, '/home?x=1');
  assert.equal(r.pick.ref, 'ref_1');
  assert.equal(r.p, 0.91);
  assert.equal(r.ranked[0].name, 'Grey');
  assert.equal(refusal(r), null);
});

test('an invalid choice is an error, not an action', async () => {
  await assert.rejects(pickTarget(cfg, snap, { intent: 'x' }, { fetchImpl: fakeFetch({ target: { type: 'choice', choice: 'ref_99' } }) }), /invalid choice/);
});

test('refusal: none, low probability, and consequential labels never act', () => {
  assert.match(refusal({ pick: null, ranked: [] }), /no element/);
  assert.match(refusal({ pick: els[0], p: 0.4 }), /unsure/);
  assert.match(refusal({ pick: els[1], p: 0.99 }), /intents never click it/);
  assert.equal(refusal({ pick: els[0], p: 0.7 }), null);
});

test('checkPage asks every check plus the expectation in one request', async () => {
  const seen = [];
  const answers = Object.fromEntries([...Object.keys(CHECKS), 'expect'].map((id, i) => [id, { type: 'noul', noul: id === 'dialog' ? 0.8 : 0.1 }]));
  const r = await checkPage(cfg, { url: 'u', title: 't', overlay: 'Filters', view: 'body' }, { expect: 'filters are open' }, { fetchImpl: fakeFetch(answers, seen) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].state.overlay, 'Filters');
  assert.deepEqual(r.flags, ['dialog']);
  assert.equal(r.expected, false);
});

test('jevKey reads the environment first, then the private env file', () => {
  assert.equal(jevKey({ TYPESAFE_API_KEY: 'a' }).key, 'a');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-')), '.env');
  fs.writeFileSync(file, 'OTHER=1\nTYPESAFE_API_KEY="b"\n');
  assert.equal(jevKey({ BROWSERCTRL_JEV_ENV: file }).key, 'b');
  assert.throws(() => jevKey({ BROWSERCTRL_JEV_ENV: path.join(os.tmpdir(), 'missing.env') }), /TYPESAFE_API_KEY/);
});

test('a label cut through an emoji still makes a valid request', async () => {
  const seen = [];
  const half = 'Free🚚'.slice(0, 5); // ends in a lone surrogate
  await pickTarget(cfg, { ...snap, elements: [{ ref: 'ref_1', role: 'button', name: half }] }, { intent: 'free' }, {
    fetchImpl: async (url, init) => { seen.push(init.body); return { ok: true, json: async () => ({ answers: { target: { type: 'choice', choice: 'ref_1', probabilities: { ref_1: 1 } } } }) }; },
  });
  assert.doesNotMatch(seen[0], /\\ud83d(?!\\ud)/i);
  assert.ok(Buffer.from(seen[0], 'utf8').toString('utf8') === seen[0]);
});

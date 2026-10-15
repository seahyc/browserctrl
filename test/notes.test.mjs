// Flow notes: agent notes checked by Jev, the URL rule from do traces, bookkeeping (counts,
// contradictions, decay, purging retired rules), ranked hints with ids, and the CLI.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as notes from '../lib/notes.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-notes-'));
process.env.BROWSERCTRL_NOTES_DIR = DIR;
beforeEach(() => { fs.rmSync(DIR, { recursive: true, force: true }); delete process.env.BROWSERCTRL_NOTES; });

const MRS = 'https://gitlab.example.com/acme/web/-/merge_requests';
const step = (n, r) => ({ run: 'r1', at: '2026-10-15T10:00:00Z', tab: 'T', step: n, ms: 100, ...r });
const runLine = (r) => ({ run: 'r1', at: '2026-10-15T10:00:00Z', tab: 'T', kind: 'run', ...r });

// The shape of a real GitLab trace: a tab click that put the filter in the URL.
const closedRun = (done = true, stop) => [
  step(1, { do: 'click "Closed"', action: 'click', target: { role: 'tab', name: 'Closed 12', ref: 'ref_31' }, how: 'jev p=0.98',
    url_before: MRS, url_after: `${MRS}/?sort=merged_at_desc&state=closed&first_page_size=20`, ...(stop ? { stop } : {}) }),
  step(2, { do: 'fill "Search or filter results" = "jane"', action: 'fill', url_before: `${MRS}/?state=closed`, url_after: `${MRS}/?state=closed` }),
  step(3, { do: 'key Enter', action: 'key', url_before: `${MRS}/?state=closed`, url_after: `${MRS}/?state=closed&search=jane`,
    dismissed: [{ category: 'cookie banner', text: 'We use cookies to improve your experience', control: 'button "Accept all"' }] }),
  runLine({ done, url: `${MRS}/?state=closed&search=jane`, ...(done ? {} : { stopped: stop, stopped_step: 1 }) }),
];

test('path templates hide ids', () => {
  assert.equal(notes.pathTemplate('https://x.com/acme/web/-/issues/123'), '/acme/web/-/issues/*');
  assert.equal(notes.pathTemplate('https://shop.sg/p/9f8e7d6c5b4a3f2e1d0c'), '/p/*');
  assert.equal(notes.pathTemplate('https://shop.sg/'), '/');
});

test('a do run yields only the URL fact, with typed values templated', () => {
  const facts = notes.derive(closedRun());
  assert.deepEqual(facts.map(f => f.kind), ['url']);
  const url = facts[0];
  assert.equal(url.site, 'example.com');
  // Short enums stay (they are the site's vocabulary); numbers could be a task's price or id.
  assert.match(url.text, /click "Closed" sets \?sort=merged_at_desc&state=closed&first_page_size=… in the URL/);
  assert.ok(!facts.some(f => f.text.includes('jane')), 'the typed value is the task, not the site');
});

// Regression: on PyPI a select for the sort order produced a note carrying the previous
// task's classifier filter, because a repeated parameter (?c=a&c=b) looked newly added.
test('the URL rule records only what this step changed, and hides task values', () => {
  const base = 'https://pypi.org/search/?q=&c=Programming+Language+%3A%3A+Python&c=License+%3A%3A+OSI+Approved+%3A%3A+MIT+License';
  const sorted = notes.derive([
    step(1, { do: 'select "Order by" = "Date last updated"', action: 'select', url_before: base, url_after: `${base}&o=-created` }),
    runLine({ done: true, url: `${base}&o=-created` }),
  ]);
  assert.equal(sorted.length, 1);
  assert.match(sorted[0].text, /sets \?o=-created in the URL/);
  assert.ok(!/License|MIT|Python/.test(sorted[0].text.replace(/select "Order by = Date last updated"/, '')), sorted[0].text);
  const filtered = notes.derive([
    step(1, { do: 'click "Web Environment"', action: 'click', url_before: base, url_after: `${base}&c=Environment+%3A%3A+Web+Environment` }),
    runLine({ done: true, url: base }),
  ]);
  assert.match(filtered[0].text, /sets \?c=… in the URL/);
  const priced = notes.derive([
    step(1, { do: 'click "Under $40"', action: 'click', url_before: 'https://wine.example.com/list', url_after: 'https://wine.example.com/list?price=0-40' }),
    runLine({ done: true }),
  ]);
  assert.match(priced[0].text, /sets \?price=… in the URL/);
});

test('notes from retired rules or older rule versions are purged on load; agent notes stay', () => {
  fs.mkdirSync(DIR, { recursive: true });
  const f = (kind, extra = {}) => ({ key: `${kind} k`, kind, text: kind, count: 1, fails: 0, first: '2026-10-15T00:00:00Z', last: new Date().toISOString(), ...extra });
  fs.writeFileSync(path.join(DIR, 'pypi.org.json'), JSON.stringify({ site: 'pypi.org', facts: [
    f('flow'), f('enter'), f('overlay'), f('url'), f('url', { key: 'url v2', v: 2 }), f('agent', { author: 'agent' }), f('challenge', { v: 2 }),
  ] }));
  const note = notes.show('pypi.org');
  assert.deepEqual(note.facts.map(x => x.kind).sort(), ['agent', 'challenge', 'url']);
  assert.equal(note.purged, 4);
  assert.ok(note.facts.every(x => /^[0-9a-f]{5}$/.test(x.id)));
});

test('a failed run contradicts facts but never creates them', () => {
  const failed = notes.derive(closedRun(false, 'Step 1 expected "only closed MRs"'));
  assert.ok(failed.filter(f => f.kind === 'url' || f.kind === 'flow').every(f => !f.ok));
  notes.record(failed.filter(f => !f.ok));
  assert.equal(notes.show('example.com').facts.length, 0);
});

test('counts grow with each run, one contradiction drops a once-seen fact, a well-worn one survives', () => {
  const t0 = Date.parse('2026-10-15T10:00:00Z');
  notes.record(notes.derive(closedRun()), { now: t0 });
  let f = notes.show('example.com').facts.find(x => x.kind === 'url');
  assert.equal(f.count, 1);
  notes.record(notes.derive(closedRun(false, 'no')).filter(x => !x.ok), { now: t0 + 1000 });
  assert.equal(notes.show('example.com').facts.find(x => x.kind === 'url'), undefined);

  for (let i = 0; i < 3; i++) notes.record(notes.derive(closedRun()), { now: t0 + i });
  notes.record(notes.derive(closedRun(false, 'no')).filter(x => !x.ok), { now: t0 + 10 });
  f = notes.show('example.com').facts.find(x => x.kind === 'url');
  assert.equal(f.count, 3);
  assert.equal(f.fails, 1);
});

test('facts unseen for 90 days are pruned on the next write', () => {
  const old = Date.parse('2026-01-01T00:00:00Z');
  notes.record(notes.derive(closedRun()), { now: old });
  notes.record([{ site: 'example.com', key: 'other', kind: 'url', text: 'fresh', ok: true }], { now: old + 91 * 864e5 });
  assert.deepEqual(notes.show('example.com').facts.map(x => x.text), ['fresh']);
});

test('hints list this page\'s facts first, capped, and respect BROWSERCTRL_NOTES', () => {
  notes.record(notes.derive(closedRun()));
  for (let i = 0; i < 8; i++) notes.record([{ site: 'example.com', key: `k${i}`, kind: 'url', path: '/other', text: `elsewhere ${i}`, ok: true }]);
  const lines = notes.hintLines(`${MRS}?state=opened`);
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^ {2}[0-9a-f]{5} on \/acme/);
  assert.ok(lines.slice(1).every(l => l.includes('elsewhere')), lines.join('\n'));
  process.env.BROWSERCTRL_NOTES = 'quiet';
  assert.deepEqual(notes.hintLines(MRS), []);
  notes.record([{ site: 'example.com', key: 'quiet', kind: 'url', text: 'recorded while quiet', ok: true }]);
  assert.ok(notes.show('example.com').facts.some(x => x.key === 'quiet'));
  process.env.BROWSERCTRL_NOTES = 'off';
  notes.record([{ site: 'example.com', key: 'off', kind: 'url', text: 'not recorded', ok: true }]);
  assert.ok(!notes.show('example.com').facts.some(x => x.key === 'off'));
});

// A fake System One answering the leak question with a fixed probability.
const judgeWith = (p) => ({ cfg: { key: 'k', model: 'm' }, fetchImpl: async (url, init) => {
  const body = JSON.parse(init.body);
  assert.match(body.questions.reusable.instructions, /reusable fact about how the website works/);
  return { ok: true, json: async () => ({ answers: { reusable: { noul: p } } }) };
} });

test('an agent note is stored only when Jev judges it a reusable site fact', async () => {
  const good = await notes.add('https://www.airbnb.com/s/Cleveland/homes', 'The total price with fees is behind the "Display total before taxes" toggle', judgeWith(0.91));
  assert.equal(good.ok, true);
  assert.equal(good.p, 0.91);
  const stored = notes.show('airbnb.com').facts;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].author, 'agent');
  assert.equal(stored[0].path, '/s/Cleveland/homes');
  assert.equal(stored[0].id, good.id);

  const leak = await notes.add('airbnb.com', 'The cheapest pet-friendly place in Cleveland is "Cozy Loft", $142 a night', judgeWith(0.08));
  assert.equal(leak.ok, false);
  assert.match(leak.reason, /task-specific \(p=0\.08/);
  assert.equal(notes.show('airbnb.com').facts.length, 1);

  assert.match((await notes.add('airbnb.com', 'x'.repeat(201), judgeWith(0.9))).reason, /at most 200 characters/);
  assert.match((await notes.add('airbnb.com', 'line one\nline two', judgeWith(0.9))).reason, /one line/);
  const forced = await notes.add('airbnb.com', 'Prices default to the visitor\'s local currency', { ...judgeWith(0.1), force: true });
  assert.equal(forced.ok, true);
});

test('hints rank this page\'s notes, then site-wide ones, then other pages\'', async () => {
  // Distinct times: among equally proven notes, the most recent comes first.
  const t0 = Date.now() - 60_000;
  await notes.add('https://example.com/login', 'Login accepts SSO', { force: true, now: t0 });
  await notes.add('example.com', 'Search submits on Enter', { force: true, now: t0 + 1000 });
  await notes.add('https://example.com/cart', 'The cart keeps items for 30 minutes', { force: true, now: t0 + 2000 });
  const order = (url) => notes.hintLines(url).map(l => l.replace(/^ +[0-9a-f]{5} | \(worked.*$/g, ''));
  assert.deepEqual(order('https://example.com/'), ['Search submits on Enter', 'The cart keeps items for 30 minutes', 'Login accepts SSO']);
  assert.equal(order('https://example.com/login')[0], 'Login accepts SSO');
});

test('an agent note is kept but marked unchecked when Jev cannot be asked', async () => {
  const r = await notes.add('example.com', 'Search submits on Enter', { cfg: { key: 'k', model: 'm' }, fetchImpl: async () => { throw new Error('network down'); } });
  assert.equal(r.ok, true);
  assert.match(r.unchecked, /network down/);
  assert.equal(notes.show('example.com').facts[0].verified, false);
  assert.match(notes.hintLines('https://example.com/')[0], /unchecked/);
});

test('confirm counts a note that held; drop removes a wrong one and keeps why', async () => {
  const { id } = await notes.add('example.com', 'Filters live under "More filters"', { force: true });
  assert.equal(notes.confirm(id).count, 2);
  assert.equal(notes.confirm(`#${id}`).count, 3);
  assert.equal(notes.show('example.com').facts[0].count, 3);
  const d = notes.drop(id, { why: 'the button is now called "All filters"' });
  assert.equal(d.ok, true);
  assert.equal(notes.show('example.com').facts.length, 0);
  assert.equal(notes.confirm(id).ok, false);
});

test('browserctrl notes adds, lists, shows, confirms, drops and clears without a browser', async () => {
  notes.record(notes.derive(closedRun()));
  const env = { ...process.env, TYPESAFE_API_KEY: '', BROWSERCTRL_JEV_ENV: path.join(DIR, 'missing.env') };
  const run = (...a) => promisify(execFile)('node', [path.join(ROOT, 'bin/browserctrl.mjs'), 'notes', ...a], { env });
  const added = (await run('add', 'example.com', '--force', 'Sorting is a dropdown called "Sort by"')).stdout;
  const id = added.match(/Added ([0-9a-f]{5}) to example\.com/)?.[1];
  assert.ok(id, added);
  // Without a Jev key the note is kept and marked unchecked.
  assert.match((await run('add', 'example.com', 'Search submits on Enter')).stdout, /not checked by Jev/);
  assert.match((await run()).stdout, /^example\.com {2}3 notes/);
  const shown = (await run('https://gitlab.example.com/x')).stdout;
  assert.match(shown, /[0-9a-f]{5} \[url\] on \/acme\/web\/-\/merge_requests, click "Closed" sets/);
  assert.match(shown, new RegExp(`${id} \\[agent\\] Sorting is a dropdown`));
  assert.match((await run('confirm', id)).stdout, /Confirmed .* \(worked 2×\)/);
  assert.match((await run('drop', id, '--why', 'renamed')).stdout, new RegExp(`Dropped ${id} from example\\.com`));
  assert.match((await run('example.com', '--clear')).stdout, /Cleared flow notes: example\.com/);
  assert.match((await run()).stdout, /no flow notes yet/);
});

test('runnable notes: reveal and on steps are validated, matched and contradicted', async () => {
  const bad = await notes.add('shop.sg', 'x', { force: true, reveal: { target: 'Pets', steps: ['fill Search = dog'] } });
  assert.equal(bad.ok, false); assert.match(bad.reason, /types a value/);
  const commit = await notes.add('shop.sg', 'x', { force: true, on: { situation: 'a popup', steps: ['click! "Buy"'] } });
  assert.equal(commit.ok, false); assert.match(commit.reason, /commits/);
  const both = await notes.add('shop.sg', 'x', { force: true, reveal: { target: 'a', steps: ['click b'] }, on: { situation: 'c', steps: ['click d'] } });
  assert.equal(both.ok, false);
  const r = await notes.add('https://shop.sg/search', 'Pets sits under Guests', { force: true, reveal: { target: 'Pets', steps: ['click "Guests"'] } });
  assert.equal(r.ok, true, r.reason);
  const o = await notes.add('shop.sg', 'A cookie banner appears on first visit', { force: true, on: { situation: 'a cookie banner', steps: ['click Accept'] } });
  const run = notes.runnable('https://shop.sg/search?q=1');
  assert.deepEqual(run.map(f => f.id).sort(), [r.id, o.id].sort());
  assert.deepEqual(notes.runnable('https://shop.sg/other').map(f => f.id), [o.id]);
  assert.equal(notes.revealFor(run, 'the Pets stepper').id, r.id);
  assert.equal(notes.revealFor(run, 'Price'), null);
  assert.match(notes.line(run.find(f => f.id === r.id)), /do runs it: to reach "Pets": click "Guests"/);
  // The leak check sees the steps too.
  const seen = [];
  await notes.add('shop.sg', 'Pets sits under Guests', { reveal: { target: 'Pets', steps: ['click "Guests"'] }, cfg: { key: 'k', model: 'm' },
    fetchImpl: async (u, init) => { seen.push(JSON.parse(init.body).state.note); return { ok: true, json: async () => ({ answers: { reusable: { noul: 0.9 } } }) }; } });
  assert.match(seen[0], /steps it runs: click "Guests"/);
  assert.equal(notes.contradict(o.id).ok, true);
  assert.equal(notes.show('shop.sg').facts.find(f => f.id === o.id), undefined, 'worked once, failed once: dropped');
  process.env.BROWSERCTRL_NOTES = 'quiet';
  assert.deepEqual(notes.runnable('https://shop.sg/search'), [], 'quiet: notes never act');
});

test('www. and two-level suffixes share one site, and old www. files are merged', async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(DIR, 'www.gov.uk.json'), JSON.stringify({ site: 'www.gov.uk', facts: [
    { id: 'aaaaa', key: 'agent  the checker asks about savings', kind: 'agent', author: 'agent', v: 2, text: 'The checker asks about savings', count: 1, fails: 0, first: now, last: now }] }));
  assert.equal(notes.siteOfUrl('https://www.gov.uk/check-benefits'), 'gov.uk');
  const shown = notes.show('gov.uk');
  assert.equal(shown.facts.length, 1);
  assert.equal(shown.facts[0].text, 'The checker asks about savings');
  assert.ok(!fs.existsSync(path.join(DIR, 'www.gov.uk.json')));
  assert.equal(notes.show('https://www.gov.uk/x').facts.length, 1);
  assert.equal(notes.siteOfUrl('https://www.bbc.co.uk/news'), 'bbc.co.uk');
});

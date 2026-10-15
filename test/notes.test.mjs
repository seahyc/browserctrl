// Flow notes: facts derived from do traces (URL filters, Enter submits, overlays, flows),
// counted, contradicted and dropped, ranked for a page, hinted, and shown by the CLI.
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

test('a do run yields URL, Enter, overlay and flow facts, with typed values templated', () => {
  const facts = notes.derive(closedRun());
  const kinds = facts.map(f => f.kind).sort();
  assert.deepEqual(kinds, ['enter', 'flow', 'overlay', 'url']);
  const url = facts.find(f => f.kind === 'url');
  assert.equal(url.site, 'example.com');
  assert.match(url.text, /click "Closed" sets \?sort=merged_at_desc&state=closed&first_page_size=20 in the URL/);
  const enter = facts.find(f => f.kind === 'enter');
  assert.match(enter.text, /"Search or filter results" submits on Enter → .*\?search=<text>; nav there directly/);
  assert.match(facts.find(f => f.kind === 'overlay').text, /cookie banner appears .*button "Accept all" closes it/);
  const flow = facts.find(f => f.kind === 'flow');
  assert.equal(flow.text, 'on /acme/web/-/merge_requests, worked: click "Closed" (tab "Closed 12") → fill "Search or filter results" → key Enter');
  assert.ok(!facts.some(f => f.text.includes('jane')), 'the typed value is the task, not the site');
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
  assert.equal(lines.length, 6);
  assert.match(lines[0], /^Flow notes for example\.com/);
  assert.ok(lines.slice(1, 4).every(l => l.includes('/acme/web/-/merge_requests')), lines.join('\n'));
  process.env.BROWSERCTRL_NOTES = 'quiet';
  assert.deepEqual(notes.hintLines(MRS), []);
  notes.record([{ site: 'example.com', key: 'quiet', kind: 'url', text: 'recorded while quiet', ok: true }]);
  assert.ok(notes.show('example.com').facts.some(x => x.key === 'quiet'));
  process.env.BROWSERCTRL_NOTES = 'off';
  notes.record([{ site: 'example.com', key: 'off', kind: 'url', text: 'not recorded', ok: true }]);
  assert.ok(!notes.show('example.com').facts.some(x => x.key === 'off'));
});

test('browserctrl notes lists, shows and clears without a browser', async () => {
  notes.record(notes.derive(closedRun()));
  const run = (...a) => promisify(execFile)('node', [path.join(ROOT, 'bin/browserctrl.mjs'), 'notes', ...a], { env: process.env });
  assert.match((await run()).stdout, /^example\.com {2}4 notes/);
  const shown = (await run('https://gitlab.example.com/x')).stdout;
  assert.match(shown, /\[url\] on \/acme\/web\/-\/merge_requests, click "Closed" sets/);
  assert.match(shown, /worked 1×, first 20\d\d-/);
  assert.match((await run('example.com', '--clear')).stdout, /Cleared flow notes: example\.com/);
  assert.match((await run()).stdout, /no flow notes yet/);
});

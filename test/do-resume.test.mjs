import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { formatSteps } from '../lib/steps.mjs';

const report = extra => ({
  steps: [{ step: 1, do: 'click First' }, { step: 2, do: 'click Missing', stopped: true }],
  plan: ['click First', 'click Missing', 'fill Search = later'],
  current_tab: 'tab-1', page: { title: 'Fixture', url: 'https://fixture.test/' },
  planned_leaves: 3, executed_leaves: 1, ms: 0, jev_calls: 0,
  stopped: { step: 2, reason: 'Target absent', candidates: [{ ref: 'ref_8', role: 'button', name: 'Closest', p: .7 }] },
  ...extra,
});

test('stopped plans resume with the stopped target first and preserve listed candidates', () => {
  const text = formatSteps(report());
  assert.match(text, /70%  ref_8 button "Closest"/);
  assert.match(text, /✗ stopped at step 2\/3: Target absent\nresume: browserctrl do 'tab-1' 'click Missing' 'fill Search = later' # candidates: ref_8 button \"Closest\" \(70%\)$/);
  assert.doesNotMatch(text.split('\n').at(-1).split(' # candidates:')[0], /First|ref_8/);
});

test('resume shell quoting preserves apostrophes and shell syntax without execution', () => {
  const step = `fill Search = "O'Brien $(touch forbidden) \`touch forbidden\`"`;
  const text = formatSteps(report({ plan: ['click First', step], current_tab: 'tab\'1' }));
  const command = text.split('\n').at(-1).replace('resume: browserctrl do ', 'set -- ');
  const args = execFileSync('/bin/sh', ['-c', command + '\nprintf "%s\\n" "$@"'], { encoding: 'utf8' }).trimEnd().split('\n');
  assert.deepEqual(args, ["tab'1", step]);
});

test('resume is omitted for commits, exhausted plans, and nested plans', () => {
  for (const extra of [
    { stopped: { step: 'end', reason: 'Final check failed' } },
    { stopped: { step: 4, reason: 'Nothing remains' } },
    { stopped: { step: 2, reason: 'This can commit something' } },
    { plan: ['click First', 'click! Buy'] },
    { plan: ['click First', 'click Submit'] },
    { plan: ['click First', 'if "ready" { click Next }'] },
    { stopped: { step: '2.then.1', reason: 'Missing' } },
    { stopped: undefined, done: true },
  ]) assert.doesNotMatch(formatSteps(report(extra)), /^resume:/m);
});

test('the final stopped step remains resumable', () => {
  assert.match(formatSteps(report({ plan: ['click First', 'click Missing'] })), /resume: browserctrl do 'tab-1' 'click Missing' # candidates: ref_8 button \"Closest\" \(70%\)$/);
});

test('resume keeps embedded newlines on one physical command line', () => {
  const step = 'fill Search = "first\nsecond\rthird"';
  const text = formatSteps(report({ plan: ['click First', step] }));
  const command = text.split('\n').find(line => line.startsWith('resume:')).replace('resume: browserctrl do ', 'set -- ');
  const args = execFileSync('/bin/zsh', ['-c', command + '\nprintf "%s\\0" "$@"'], { encoding: 'utf8' }).split('\0').slice(0,-1);
  assert.deepEqual(args, ['tab-1', step]);
});

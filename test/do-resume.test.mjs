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

const resumeLine = text => text.split('\n').find(line => line.startsWith('resume:'));
const noCandidates = { stopped: { step: 2, reason: 'Target absent' } };

test('stopped plans resume from the failed step with the closest control swapped in', () => {
  const text = formatSteps(report());
  assert.match(text, /70%  ref_8 button "Closest"/);
  assert.match(text, /✗ stopped at step 2\/3: Target absent\nresume: browserctrl do 'tab-1' 'click "Closest"' 'fill Search = later' {3}# closest control, p=0\.70\n {4}or as planned: browserctrl do 'tab-1' 'click Missing' 'fill Search = later'$/);
  assert.doesNotMatch(resumeLine(text), /First|ref_8/);
});

test('with a trace, the resume line is do --resume with the replacement', () => {
  const text = formatSteps(report({ trace: '/traces/tab-1.jsonl' }));
  assert.match(text, /resume: browserctrl do 'tab-1' --resume --replace 'click "Closest"' {3}# closest control, p=0\.70\n {4}or as planned: browserctrl do 'tab-1' --resume$/);
  assert.match(formatSteps(report({ trace: '/traces/tab-1.jsonl', ...noCandidates })), /resume: browserctrl do 'tab-1' --resume {3}# add --replace '<step>' to fix step 2$/);
  assert.match(formatSteps(report({ trace: '/traces/tab-1.jsonl', tab_switched: true })), /resume: browserctrl do 'tab-1' 'click "Closest"' 'fill Search = later'/);
});

test('resume shell quoting preserves apostrophes and shell syntax without execution', () => {
  const step = `fill Search = "O'Brien $(touch forbidden) \`touch forbidden\`"`;
  const text = formatSteps(report({ plan: ['click First', step], current_tab: 'tab\'1', ...noCandidates }));
  const command = resumeLine(text).replace('resume: browserctrl do ', 'set -- ');
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
    { plan: ['click First', 'click! Buy'], trace: '/traces/tab-1.jsonl' },
    { stopped: undefined, done: true },
  ]) assert.doesNotMatch(formatSteps(report(extra)), /^resume:/m);
});

test('the final stopped step remains resumable', () => {
  assert.match(formatSteps(report({ plan: ['click First', 'click Missing'] })), /resume: browserctrl do 'tab-1' 'click "Closest"' {3}# closest control, p=0\.70\n {4}or as planned: browserctrl do 'tab-1' 'click Missing'$/);
});

test('resume keeps embedded newlines on one physical command line', () => {
  const step = 'fill Search = "first\nsecond\rthird"';
  const text = formatSteps(report({ plan: ['click First', step], ...noCandidates }));
  const command = resumeLine(text).replace('resume: browserctrl do ', 'set -- ');
  const args = execFileSync('/bin/zsh', ['-c', command + '\nprintf "%s\\0" "$@"'], { encoding: 'utf8' }).split('\0').slice(0,-1);
  assert.deepEqual(args, ['tab-1', step]);
});

test('the printed replacement runs in a shell as one argument per step', () => {
  const command = resumeLine(formatSteps(report())).replace('resume: browserctrl do ', 'set -- ');
  const args = execFileSync('/bin/sh', ['-c', command + '\nprintf "%s\\n" "$@"'], { encoding: 'utf8' }).trimEnd().split('\n');
  assert.deepEqual(args, ['tab-1', 'click "Closest"', 'fill Search = later']);
});

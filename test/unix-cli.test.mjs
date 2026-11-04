// Unix spellings: grep/head/tail/cat/ls/cd/pwd/url/whoami/back/forward, --agent-id, --tab,
// --name=value, -- and short options where a command has them, and a flag a command would
// ignore is a usage error (exit 2) on every command, not only actions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';
import { EXIT } from '../lib/exit-codes.mjs';
import { resolve, checkFlags, parseArgs, autocorrect, GLOBAL, ACTION_FLAGS, ACTION_COMMON, COMMAND_FLAGS, THEN_FLAGS } from '../lib/cli-flags.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-unix-cli-'));
const BASE_ENV = {
  ...process.env, CDP_AGENT_ID: 'test-unix-cli', BROWSERCTRL_NOTIFY: '0', BROWSERCTRL_NOTES: 'off',
  BROWSERCTRL_JEV_ENV: path.join(TMP, 'no-such-jev.env'), BROWSERCTRL_TRACES: path.join(TMP, 'traces'),
  BROWSERCTRL_USAGE_DIR: path.join(TMP, 'usage'),
};
delete BASE_ENV.TYPESAFE_API_KEY;
delete BASE_ENV.BROWSERCTRL_BROWSER;
delete BASE_ENV.BROWSERCTRL_PORT;
delete BASE_ENV.BROWSERCTRL_AGENT_ID;

function run(args, { env = {}, port = TEST_PORT } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/browserctrl.mjs'), ...args, ...(port ? ['--port', String(port)] : [])],
      { env: { ...BASE_ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); done({ code, stdout, stderr }); });
  });
}
const usageError = (fn, re) => assert.throws(fn, e => e.exitCode === EXIT.USAGE && re.test(e.message));
const check = argv => { const r = resolve(argv, {}); checkFlags(r.cmd, r.flags, r.positional); return r; };

// ---- parsing and resolution (no browser) ----------------------------------------------

test('grep, head, tail and cat are text with the flags they mean', () => {
  let r = check(['grep', 'ABCDEF12', 'beta', '-i', '-n']);
  assert.deepEqual([r.cmd, r.alias, r.positional], ['text', 'grep', ['text', 'ABCDEF12']]);
  assert.equal(r.flags.match, 'beta');
  assert.equal(r.flags['case-sensitive'], undefined, '-i turns case sensitivity off');
  assert.equal(r.flags['line-number'], true);
  r = check(['grep', 'Beta', '-vc']);
  assert.deepEqual(r.positional, ['text'], 'one word: the pattern, on the current tab');
  assert.equal(r.flags['case-sensitive'], true, 'grep is case-sensitive by default');
  assert.equal(r.flags['invert-match'], true);
  assert.equal(r.flags.count, true);
  r = check(['grep', 'ABCDEF12', '--', '-v']);
  assert.equal(r.flags.match, '-v', '-- ends the options');
  assert.equal(r.flags['invert-match'], undefined);
  usageError(() => check(['grep']), /Usage: browserctrl grep/);
  usageError(() => check(['grep', 'ABCDEF12', 'two', 'words']), /quote a pattern with spaces/);

  assert.equal(check(['head', 'ABCDEF12', '-n', '3']).flags.head, '3');
  assert.equal(check(['head', 'ABCDEF12', '-n3']).flags.head, '3');
  assert.equal(check(['tail', 'ABCDEF12', '-5']).flags.tail, '5');
  assert.equal(check(['tail', 'ABCDEF12']).flags.tail, '10', '10 lines by default, as tail');
  assert.equal(check(['head', 'ABCDEF12', '20']).flags.head, '20');
  usageError(() => check(['head', 'ABCDEF12', '-n', 'x']), /positive number/);
  assert.deepEqual(check(['cat', 'ABCDEF12']).positional, ['text', 'ABCDEF12']);
});

test('ls, cd, pwd, screenshot and the browser verbs are the commands they mean', () => {
  for (const [typed, cmd] of [['ls', 'tabs'], ['cd', 'use'], ['pwd', 'url'], ['screenshot', 'shot'], ['goto', 'nav'], ['navigate', 'nav'],
    ['press', 'key'], ['snapshot', 'read'], ['list', 'tabs']]) {
    const r = resolve([typed, 'x'], {});
    assert.equal(r.cmd, cmd, typed);
    assert.equal(r.alias, typed);
  }
  assert.equal(resolve(['text', 'x'], {}).alias, undefined);
});

test('--agent-id and --agent set the identity for this call', () => {
  const env = {};
  const r = resolve(['--agent-id', 'probe-1', 'tabs'], env);
  assert.equal(env.BROWSERCTRL_AGENT_ID, 'probe-1');
  assert.equal(r.cmd, 'tabs', 'the name is the flag value, not the command');
  checkFlags(r.cmd, r.flags, r.positional);
  const env2 = {};
  resolve(['read', 'x', '--agent', 'probe-2'], env2);
  assert.equal(env2.BROWSERCTRL_AGENT_ID, 'probe-2');
  usageError(() => resolve(['tabs', '--agent-id'], {}), /needs a name/);
});

test('--name=value works for every flag, and switches never swallow the next word', () => {
  assert.equal(parseArgs(['text', 'x', '--tail=5']).flags.tail, '5');
  assert.equal(parseArgs(['do', 'x', '--then=items']).flags.then, 'items');
  assert.equal(parseArgs(['launch', 'chrome', '--headless=new']).flags.headless, 'new');
  // Before, --steal took the JavaScript as its value and eval ran nothing.
  assert.deepEqual(parseArgs(['eval', 'x', '--steal', 'document.title']).positional, ['eval', 'x', 'document.title']);
  assert.deepEqual(parseArgs(['--steal', 'read', 'x']).positional, ['read', 'x']);
  // Elsewhere a dash word is an argument: a value to type, a key.
  assert.deepEqual(parseArgs(['type', 'x', '-v']).positional, ['type', 'x', '-v']);
  assert.deepEqual(parseArgs(['scroll', 'x', '--in', 'pane', '-200']).positional, ['scroll', 'x', '-200']);
});

test('--tab names the tab, --at a point, and spellings agents use map to the flag', () => {
  let r = check(['text', '--tab', 'ABCDEF12', '--tail', '3']);
  assert.deepEqual(r.positional, ['text', 'ABCDEF12']);
  r = check(['click', 'ref_9', '--tab', 'ABCDEF12']);
  assert.deepEqual(r.positional, ['click', 'ABCDEF12', 'ref_9']);
  r = check(['safari', 'call', 'tool', '--tab', 'H', '--browser', 'safari']);
  assert.equal(r.flags.tab, 'H', 'Safari keeps its own --tab');
  r = check(['click', 'ABCDEF12', '--at', '120,340']);
  assert.deepEqual([r.flags.x, r.flags.y, r.flags.at], ['120', '340', undefined]);
  usageError(() => check(['click', 'ABCDEF12', '--at', 'here']), /x,y/);
  assert.equal(check(['fill', 'ABCDEF12', '--ref', 'ref_1', '--text', 'aeron']).flags.value, 'aeron');
  assert.equal(check(['items', 'ABCDEF12', '--match', 'x']).flags.grep, 'x');
  assert.equal(check(['text', 'ABCDEF12', '--grep', 'x']).flags.match, 'x');
  assert.equal(check(['release', '--all']).flags.mine, 'true' === 'x' ? 0 : true);
  assert.deepEqual(check(['shot', 'ABCDEF12', '--out', '/tmp/a.png']).positional, ['shot', 'ABCDEF12', '/tmp/a.png']);
  assert.deepEqual(check(['screenshot', 'ABCDEF12', '-o', '/tmp/a.png']).positional, ['shot', 'ABCDEF12', '/tmp/a.png']);
  usageError(() => check(['shot', 'ABCDEF12', 'a.png', '--out', 'b.png']), /file once/);
  check(['open', 'https://example.com', '--background']);
});

test('a flag any command would ignore is a usage error that says what it takes', () => {
  usageError(() => check(['wait', 'ABCDEF12', '--ms', '2000']), /not for a time.*sleep in the shell/);
  usageError(() => check(['text', 'ABCDEF12', '--bogus-thing', '1000']), /text does not take --bogus-thing\. It takes --tail/);
  usageError(() => check(['read', 'ABCDEF12', '--grep', 'Sign in']), /read does not take --grep; text does: browserctrl text <tab> --grep 'Sign in'|read does not take --grep; items does/);
  usageError(() => check(['read', 'ABCDEF12', '--tail', '25']), /read does not take --tail; text does: browserctrl text <tab> --tail 25/);
  usageError(() => check(['find', 'ABCDEF12', 'video', '--role', 'video']), /find does not take --role\. It takes --max/);
  usageError(() => check(['tabs', '--bogus']), /tabs does not take --bogus/);
  usageError(() => check(['text', 'ABCDEF12', '-n', '40']), /text has no option -n.*--head N or --tail N/);
  // Actions keep their own wording (and --then pointers).
  usageError(() => check(['click', 'ABCDEF12', 'Save', '--tail', '40']), /click does not take --tail; text does\..*--then text --tail 40/);
  usageError(() => check(['click', 'ABCDEF12', 'Save', '--then', 'nope']), /--then takes text, read/);
  // What the commands do take passes.
  for (const argv of [['text', 'x', '--head', '5', '--tail', '2', '--json'], ['read', 'x', '--all', '--max-text', '100'],
    ['do', 'x', 'click "A"', '--then', 'items', '--grep', 'y'], ['click', 'x', 'Save', '--then', 'text', '--head', '3'],
    ['back', 'x', '--then', 'text', '--tail', '3'], ['wait', 'x', '--text', 'Saved', '--timeout', '100'], ['tabs', '--ids', '-q'],
    ['url', 'x'], ['whoami', '--json']]) check(argv);
});

test('synonyms are taken on any command; typos only on commands that just look', () => {
  const r = (argv) => { const x = resolve(argv, {}); checkFlags(x.cmd, x.flags, x.positional); return x; };
  let x = r(['text', 'ABCDEF12', '--max-chars', '1000']);
  assert.deepEqual([x.flags['max-text'], x.notes], ['1000', ['(took --max-chars as --max-text)']]);
  assert.equal(r(['items', 'ABCDEF12', '--limit', '5']).flags.max, '5');
  assert.equal(r(['console', 'ABCDEF12', '--limit', '5']).flags.limit, '5', 'a real flag stays');
  assert.equal(r(['text', 'ABCDEF12', '--first', '3']).flags.head, '3');
  assert.equal(r(['text', 'ABCDEF12', '--tali', '5']).flags.tail, '5', 'a swap of two letters is one typo');
  assert.equal(r(['find', 'ABCDEF12', 'Next', '--enabeld']).flags.enabled, true);
  assert.equal(r(['tabs', '--jsno']).flags.json, true);
  x = r(['shot', 'ABCDEF12', '--ful', 'a.png']);
  assert.deepEqual([x.flags.full, x.positional], [true, ['shot', 'ABCDEF12', 'a.png']], 'a mistyped switch gives back the word it took');
  // An action keeps the error: a guess there could act on the wrong thing.
  usageError(() => r(['click', 'ABCDEF12', 'Save', '--comit']), /click does not take --comit\. Did you mean --commit\?/);
  usageError(() => r(['do', 'ABCDEF12', 'click "A"', '--repaet', 'click "Next"']), /Did you mean --repeat\?/);
  // A real flag of another command is not "corrected": the error says which command takes it.
  usageError(() => r(['read', 'ABCDEF12', '--grep', 'x']), /read does not take --grep; text does/);
  // Two equally close flags: no guess.
  assert.deepEqual(autocorrect('table', { maxx: '3', mxa: '1' }, []).length <= 1, true);
});

test('a misspelt command that only looks runs as the one meant; an action does not', () => {
  let x = resolve(['txet', 'ABCDEF12', '--tail', '2'], {});
  assert.deepEqual([x.cmd, x.notes[0]], ['text', '(ran "txet" as text)']);
  assert.equal(resolve(['--browser', 'dia', 'tabss'], {}).cmd, 'tabs');
  assert.equal(resolve(['whoamii'], {}).cmd, 'whoami');
  assert.equal(resolve(['clik', 'ABCDEF12', 'Save'], {}).cmd, 'clik', 'click changes the page: still an unknown command');
  assert.equal(resolve(['fil', 'ABCDEF12', 'a', 'b'], {}).cmd, 'fil');
});

// Every flag the CLI reads is in some command's list, so a new flag cannot be rejected by mistake.
test('every flag the code reads is registered for some command', () => {
  const src = ['bin/browserctrl.mjs', 'lib/show.mjs', 'lib/bidi/cli.mjs', 'lib/safari-frontend.mjs']
    .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const read = new Set([...src.matchAll(/flags(?:\[['"]([a-z0-9-]+)['"]\]|\.([a-zA-Z_][a-zA-Z0-9_]*))/g)].map(m => m[1] || m[2]));
  const known = new Set([...GLOBAL, ...ACTION_COMMON, ...Object.values(ACTION_FLAGS).flat(), ...Object.values(COMMAND_FLAGS).flat(),
    ...Object.values(THEN_FLAGS).flat()]);
  // Read only to be translated or to say something about them.
  const internal = new Set(['ms', 'sleep', 'seconds', 'secs', 'delay', 'duration', 'time', 'for', 'agent', 'tab', 'at', 'lines', 'ignore-case', 'extended', 'includes', 'modifiers', 'mjs']);
  const missing = [...read].filter(f => !known.has(f) && !internal.has(f));
  assert.deepEqual(missing, [], `flags read but not registered in lib/cli-flags.mjs: ${missing.join(', ')}`);
});

test('every documented command has a flag list', () => {
  const help = fs.readFileSync(path.join(ROOT, 'bin/browserctrl.mjs'), 'utf8');
  const usageText = help.slice(help.indexOf('function usage()'), help.indexOf('// Linux and Windows, and --headless anywhere'));
  const documented = new Set([...usageText.matchAll(/browserctrl ([a-z][a-z-]+)/g)].map(m => m[1]));
  const aliases = new Set(['cat', 'ls', 'head', 'tail', 'grep', 'pwd', 'cd', 'screenshot']);
  const missing = [...documented].filter(c => !aliases.has(c) && !Object.hasOwn(COMMAND_FLAGS, c) && !Object.hasOwn(ACTION_FLAGS, c));
  assert.deepEqual(missing, [], `commands without a flag list: ${missing.join(', ')}`);
});

test('usage errors exit 2 before a browser is needed; whoami needs none', async () => {
  const r = await run(['wait', 'ABCDEF12', '--ms', '500'], { port: null });
  assert.equal(r.code, EXIT.USAGE, r.stderr);
  const t = await run(['tabs', '--bogus'], { port: null });
  assert.equal(t.code, EXIT.USAGE, t.stderr);
  const w = await run(['whoami', '--agent-id', 'probe-7'], { port: null });
  assert.equal(w.code, 0, w.stderr);
  assert.equal(w.stdout.trim(), 'probe-7');
  const j = await run(['whoami', '--json'], { port: null, env: { BROWSERCTRL_AGENT_ID: 'env-id' } });
  assert.deepEqual(JSON.parse(j.stdout), { agent: 'env-id', from: 'BROWSERCTRL_AGENT_ID' });
});

// ---- against a page ---------------------------------------------------------------------

const haveBrowser = Boolean(chromeBinary());
const t = (name, fn) => test(name, { skip: !haveBrowser && 'no Chromium-family browser' }, fn);
let fixture, browser;
before(async () => {
  if (!haveBrowser) return;
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(TEST_PORT);
});
after(async () => {
  if (haveBrowser) await run(['stop']).catch(() => {});
  await browser?.close();
  await fixture?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});
async function open() {
  const r = await run(['open', `${fixture.url}fixtures/unix-cli.html`]);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout).id;
}

t('grep prints matching lines as grep does, with exit 1 when none match', async () => {
  const tab = await open();
  let r = await run(['grep', tab, 'beta']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'beta four', 'case-sensitive by default');
  r = await run(['grep', tab, 'beta', '-i', '-n']);
  assert.deepEqual(r.stdout.trim().split('\n'), ['2:Beta two', '4:beta four']);
  r = await run(['grep', tab, '-c', 'a']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(Number(r.stdout.trim()) >= 5, r.stdout);
  r = await run(['grep', tab, '3.50 (', '-F']);
  assert.equal(r.stdout.trim(), 'price 3.50 (approx)', '-F: a fixed string, not a regex');
  r = await run(['grep', tab, 'zzz']);
  assert.equal(r.code, EXIT.NO);
  assert.equal(r.stdout, '');
  r = await run(['grep', tab, 'zzz', '-q']);
  assert.equal(r.code, EXIT.NO);
  assert.equal(r.stderr, '');
  r = await run(['grep', tab, '-v', '-i', 'a']);
  assert.ok(!/alpha|Beta|gamma|delta/i.test(r.stdout), r.stdout);
});

t('head, tail, cat and text --head give the lines asked for', async () => {
  const tab = await open();
  let r = await run(['head', tab, '-n', '2']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), ['alpha one', 'Beta two']);
  r = await run(['tail', tab, '-1']);
  assert.equal(r.stdout.trim(), 'Next page');
  r = await run(['text', tab, '--head', '3', '--tail', '1']);
  assert.equal(r.stdout.trim(), 'gamma three', 'head then tail, as head | tail');
  r = await run(['cat', tab]);
  assert.match(r.stdout, /alpha one[\s\S]*delta five/);
  r = await run(['text', '--tab', tab, '--grep', 'delta']);
  assert.equal(r.stdout.trim(), 'delta five', '--tab names the tab; --grep is --match');
});

t('url and pwd print the address; back and forward walk the history', async () => {
  const tab = await open();
  let r = await run(['url', tab]);
  assert.equal(r.stdout.trim(), `${fixture.url}fixtures/unix-cli.html`);
  r = await run(['back', tab]);
  assert.equal(r.code, EXIT.NO, 'nothing earlier in a new tab');
  r = await run(['click', tab, '#next', '--no-diff']);
  assert.equal(r.code, 0, r.stderr);
  await run(['wait', tab, '--url', 'page.html']);
  r = await run(['pwd', tab]);
  assert.match(r.stdout.trim(), /fixtures\/page\.html$/);
  r = await run(['back', tab, '--then', 'text', '--head', '1']);
  assert.equal(r.code, 0, r.stderr);
  const [json, text] = r.stdout.split('\n--- text ---\n');
  assert.match(JSON.parse(json).url, /unix-cli\.html$/);
  assert.equal(text.trim(), 'alpha one');
  r = await run(['forward', tab]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).url, /page\.html$/);
  r = await run(['forward', tab]);
  assert.equal(r.code, EXIT.NO);
});

// A shell pipeline against the test browser: the command line as an agent writes it.
function sh(script) {
  const r = spawnSync('/bin/sh', ['-c', script], {
    env: { ...BASE_ENV, BROWSERCTRL_PORT: String(TEST_PORT), BC: `${process.execPath} ${path.join(ROOT, 'bin/browserctrl.mjs')}` },
    encoding: 'utf8', timeout: 120000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

t('output works in pipes: exact lines, early close, xargs and grep -q', async () => {
  const tab = await open();
  let r = sh(`$BC head ${tab} -n 2 | wc -l`);
  assert.equal(r.stdout.trim(), '2', r.stderr);
  r = sh(`$BC grep ${tab} -i beta | wc -l`);
  assert.equal(r.stdout.trim(), '2', r.stderr);
  // A reader that stops early is not an error: the pipeline's status is head's, and ours is 0.
  r = sh(`$BC cat ${tab} | head -1; echo "status=$?"`);
  assert.match(r.stdout, /^alpha one\nstatus=0$/m, r.stderr);
  assert.doesNotMatch(r.stderr, /EPIPE|Error/);
  r = sh(`$BC ls --ids | grep -x ${tab} | xargs -n1 $BC url`);
  assert.equal(r.stdout.trim(), `${fixture.url}fixtures/unix-cli.html`, r.stderr);
  r = sh(`if $BC grep ${tab} gamma -q; then echo yes; else echo no; fi; if $BC grep ${tab} zzz -q; then echo yes; else echo no; fi`);
  assert.equal(r.stdout, 'yes\nno\n', r.stderr);
  r = sh(`$BC tail ${tab} -n 3 | LC_ALL=C sort | head -1`);
  assert.equal(r.stdout.trim(), 'Next page', r.stderr);
});

t('typos in a look are corrected with a note on stderr, stdout stays the data', async () => {
  const tab = await open();
  const r = await run(['txet', tab, '--tali', '1']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'Next page');
  assert.match(r.stderr, /\(ran "txet" as text\)/);
  assert.match(r.stderr, /\(took --tali as --tail\)/);
  const q = await run(['txet', tab, '--tali', '1', '-q']);
  assert.equal(q.stderr, '', '-q drops the notes');
  const bad = await run(['click', tab, '#next', '--comit']);
  assert.equal(bad.code, EXIT.USAGE, bad.stderr);
});

t('ls, cd, pwd and --agent-id: the current tab follows the identity', async () => {
  // The tab belongs to the identity that opens it; cd under another one would be refused.
  const o = await run(['open', `${fixture.url}fixtures/unix-cli.html`, '--agent-id', 'unix-agent-a']);
  assert.equal(o.code, 0, o.stderr);
  const tab = JSON.parse(o.stdout).id;
  let r = await run(['ls', '--ids']);
  assert.ok(r.stdout.split('\n').includes(tab), r.stdout);
  r = await run(['cd', tab, '--agent-id', 'unix-agent-a']);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /BROWSERCTRL_AGENT_ID is not set/, 'the flag set the identity');
  r = await run(['pwd', '--agent-id', 'unix-agent-a']);
  assert.equal(r.stdout.trim(), `${fixture.url}fixtures/unix-cli.html`, 'no tab given: the current tab of that agent');
  r = await run(['head', '-n', '1', '--agent-id', 'unix-agent-a']);
  assert.equal(r.stdout.trim(), 'alpha one');
  r = await run(['pwd', '--agent-id', 'unix-agent-b']);
  assert.notEqual(r.code, 0, 'another identity has no current tab');
  r = await run(['release', '--all', '--agent-id', 'unix-agent-a']);
  assert.equal(r.code, 0, r.stderr);
});

t('screenshot -o, goto, press, snapshot, fill --text and click --at do what they name', async () => {
  const tab = await open();
  const png = path.join(TMP, 'shot.png');
  let r = await run(['screenshot', tab, '-o', png]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.statSync(png).size > 1000);
  r = await run(['snapshot', tab]);
  assert.match(r.stdout, /ref_\d+/);
  r = await run(['fill', tab, '--selector', '#q', '--text', 'hello', '--no-diff']);
  assert.equal(r.code, 0, r.stderr);
  r = await run(['eval', tab, 'document.querySelector("#q").value']);
  assert.equal(r.stdout.trim(), 'hello');
  r = await run(['press', tab, 'Tab', '--no-diff']);
  assert.equal(r.code, 0, r.stderr);
  const box = JSON.parse((await run(['eval', tab, 'JSON.stringify((r => [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)])(document.querySelector("#next").getBoundingClientRect()))'])).stdout.trim().replace(/^"|"$/g, '').replace(/\\"/g, '"'));
  r = await run(['click', tab, '--at', `${box[0]},${box[1]}`, '--no-diff']);
  assert.equal(r.code, 0, r.stderr);
  await run(['wait', tab, '--url', 'page.html']);
  r = await run(['url', tab]);
  assert.match(r.stdout.trim(), /fixtures\/page\.html$/);
  r = await run(['goto', tab, `${fixture.url}fixtures/unix-cli.html`]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).url, /unix-cli\.html$/);
});

// Last: a challenge starts a cool-down for the fixture's site, cleared at the end.
t('on a challenge page, head and grep keep stdout to the lines and say so on stderr', async () => {
  const env = { BROWSERCTRL_CAPTCHA_PLUGINS: path.join(ROOT, 'test/fixtures/fake-solver.mjs'), FAKE_SOLVER_OFF: '1' };
  const url = `${fixture.url}fixtures/fake-challenge.html`;
  try {
    const o = await run(['open', url, '--force'], { env });
    assert.equal(o.code, 0, o.stderr);
    const tab = JSON.parse(o.stdout).id;
    let r = await run(['head', tab, '-n', '1', '--force'].filter(a => a !== '--force'), { env });
    assert.equal(r.stdout, 'Please wait\n', r.stdout);
    assert.match(r.stderr, /verification challenge|challenge/i);
    r = await run(['grep', tab, 'Content'], { env });
    assert.equal(r.stdout, 'Content behind the challenge.\n');
    r = await run(['cat', tab], { env });
    assert.match(r.stdout, /^⚠ /, 'the whole text still leads with the notice');
  } finally {
    await run(['cooldown', 'clear', url], { env });
  }
});


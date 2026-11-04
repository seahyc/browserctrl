// Unix spellings: grep/head/tail/cat/ls/cd/pwd/url/whoami/back/forward, --agent-id, --tab,
// --name=value, -- and short options where a command has them, and a flag a command would
// ignore is a usage error (exit 2) on every command, not only actions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';
import { EXIT } from '../lib/exit-codes.mjs';
import { resolve, checkFlags, parseArgs, GLOBAL, ACTION_FLAGS, ACTION_COMMON, COMMAND_FLAGS, THEN_FLAGS } from '../lib/cli-flags.mjs';

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
  usageError(() => check(['text', 'ABCDEF12', '--max-chars', '1000']), /text does not take --max-chars\. Did you mean --max-text\?/);
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

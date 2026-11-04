// Single actions say what they changed (the diff a do plan reports), --then shows the page in
// the same call with that command's own flags, a flag an action would ignore is a usage
// error, and every call leaves one line in the usage log.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';
import { EXIT } from '../lib/exit-codes.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-act-report-'));
const USAGE_DIR = path.join(TMP, 'usage');
const BASE_ENV = {
  ...process.env, CDP_AGENT_ID: 'test-act-report', BROWSERCTRL_NOTIFY: '0', BROWSERCTRL_NOTES: 'off',
  BROWSERCTRL_JEV_ENV: path.join(TMP, 'no-such-jev.env'), BROWSERCTRL_TRACES: path.join(TMP, 'traces'),
  BROWSERCTRL_USAGE_DIR: USAGE_DIR, BROWSERCTRL_USAGE_LOG: '1',
};
delete BASE_ENV.TYPESAFE_API_KEY;
delete BASE_ENV.BROWSERCTRL_BROWSER;
delete BASE_ENV.BROWSERCTRL_PORT;

function run(args, { env = {}, port = TEST_PORT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/browserctrl.mjs'), ...args, ...(port ? ['--port', String(port)] : [])],
      { env: { ...BASE_ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
// The action's JSON object: everything before a --then section.
const actJson = out => JSON.parse(out.split('\n--- ')[0]);

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
  const r = await run(['open', `${fixture.url}fixtures/act-report.html`]);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout).id;
}

t('a click by name reports the dialog it opened, so no read is needed', async () => {
  const tab = await open();
  const r = await run(['click', tab, 'Add card']);
  assert.equal(r.code, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.acted, true);
  assert.ok(Array.isArray(res.changed), r.stdout);
  assert.ok(res.changed.some(l => /dialog "Add card"/.test(l)), r.stdout);
  console.log(r.stdout);
});

t('a click by CSS selector reports changes too, and says when nothing changed', async () => {
  const tab = await open();
  const opened = await run(['click', tab, '#add']);
  assert.equal(opened.code, 0, opened.stderr);
  assert.ok(JSON.parse(opened.stdout).changed.some(l => /dialog "Add card"/.test(l)), opened.stdout);
  const noop = await run(['click', tab, '#noop']);
  assert.equal(noop.code, 0, noop.stderr);
  assert.equal(JSON.parse(noop.stdout).changed, 'no control, heading, count or notice changed');
  const quiet = await run(['click', tab, '#noop', '--no-diff']);
  assert.equal(JSON.parse(quiet.stdout).changed, undefined);
});

t('fill then key Enter reports the count the form changed', async () => {
  const tab = await open();
  assert.equal((await run(['fill', tab, '#q', 'visa'])).code, 0);
  const r = await run(['key', tab, 'Enter']);
  assert.equal(r.code, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.ok(Array.isArray(res.changed) && res.changed.some(l => /4 cards/.test(l)), r.stdout);
});

t('--then text shows the page after the action, shaped by text\'s own flags', async () => {
  const tab = await open();
  const r = await run(['click', tab, 'Add card', '--then', 'text', '--tail', '2']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(actJson(r.stdout).acted, true);
  const [, shown] = r.stdout.split('\n--- text ---\n');
  assert.ok(shown, r.stdout);
  assert.ok(shown.trim().split('\n').length <= 2, shown);
  assert.match(shown, /Save card/);
});

t('nav and open take --then, so reaching a page and reading it is one call', async () => {
  const tab = await open();
  const nav = await run(['nav', tab, `${fixture.url}fixtures/act-report.html`, '--then', 'text', '--from', 'Footer line one', '--to', 'Footer line two']);
  assert.equal(nav.code, 0, nav.stderr);
  assert.match(nav.stdout, /--- text ---\nFooter line one\n+Footer line two/);
  const opened = await run(['open', `${fixture.url}fixtures/act-report.html`, '--then', 'read']);
  assert.equal(opened.code, 0, opened.stderr);
  assert.match(opened.stdout, /--- read ---[\s\S]*Add card/);
});

t('a --then after a stopped action does not run', async () => {
  const tab = await open();
  const r = await run(['click', tab, 'No such button anywhere', '--then', 'text']);
  assert.equal(r.code, EXIT.STOPPED, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /--- text ---/);
});

test('a flag the action would ignore is a usage error that names the right form', async () => {
  const shaped = await run(['click', 'abcd1234', 'Add card', '--tail', '40'], { port: null });
  assert.equal(shaped.code, EXIT.USAGE, shaped.stderr);
  assert.match(shaped.stderr, /click does not take --tail; text does\..*--then text --tail 40/);
  const unknown = await run(['click', 'abcd1234', 'Add card', '--wait', '5'], { port: null });
  assert.equal(unknown.code, EXIT.USAGE, unknown.stderr);
  assert.match(unknown.stderr, /click does not take --wait\. It takes .*--commit/);
  const badThen = await run(['click', 'abcd1234', 'Add card', '--then', 'html'], { port: null });
  assert.equal(badThen.code, EXIT.USAGE);
  assert.match(badThen.stderr, /--then takes text, read, items, table, fields/);
});

t('each call leaves one compact usage line with what was asked and how it went', async () => {
  fs.rmSync(USAGE_DIR, { recursive: true, force: true });
  const tab = await open();
  await run(['click', tab, 'Add card', '--then', 'text', '--tail', '1']);
  await run(['click', tab, 'No such button anywhere']);
  const { readUsage } = await import('../lib/usage-log.mjs');
  const rows = readUsage({ dir: USAGE_DIR, days: 1 });
  const clicks = rows.filter(r => r.c === 'click');
  assert.equal(clicks.length, 2, JSON.stringify(rows));
  const [ok, stopped] = clicks;
  assert.equal(ok.k, 'name');
  assert.equal(ok.x, 0);
  assert.equal(ok.then, 'text');
  assert.ok(ok.ch > 0);
  assert.deepEqual(ok.f, ['port', 'tail', 'then']);
  assert.equal(stopped.x, EXIT.STOPPED);
  assert.ok(stopped.st, JSON.stringify(stopped));
  const raw = fs.readdirSync(USAGE_DIR).filter(f => f.endsWith('.jsonl')).map(f => fs.readFileSync(path.join(USAGE_DIR, f), 'utf8')).join('');
  // Never the names, values or addresses an agent typed.
  assert.doesNotMatch(raw, /Add card|No such button|act-report\.html|fixtures/);
});

t('text --selector reads the elements a CSS selector matches; no match is a negative answer', async () => {
  const tab = await open();
  const r = await run(['text', tab, '--selector', '#count']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), '3 cards');
  const none = await run(['text', tab, '--selector', '#nope']);
  assert.equal(none.code, EXIT.NO, none.stderr);
  assert.match(none.stderr, /No element matches the CSS selector #nope/);
  const bad = await run(['text', tab, '--selector', 'p[[']);
  assert.equal(bad.code, EXIT.USAGE, bad.stderr);
});

t('an eval that a command covers names that command on stderr, and still answers', async () => {
  const tab = await open();
  const r = await run(['eval', tab, 'document.querySelector("#count").innerText']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /3 cards/);
  assert.match(r.stderr, /hint: text \w+ --selector '#count'/);
  const click = await run(['eval', tab, 'document.querySelector("#noop").click()']);
  assert.match(click.stderr, /hint: click \w+ "<name or css>"/);
  const plain = await run(['eval', tab, 'location.href']);
  assert.doesNotMatch(plain.stderr, /hint:/);
});

// Fast human handoff: the challenge tab comes to the front, the phone-ping hook
// gets the message, and the agent resumes as soon as the challenge is gone,
// reporting how long the human took. `do` and recipes hand off instead of
// failing, unless told not to.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import * as cooldown from '../lib/cooldown.mjs';
import { solve, handoff, ping } from '../lib/captcha.mjs';
import { runSteps } from '../lib/steps.mjs';
import { runRecipe } from '../lib/recipes.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

process.env.BROWSERCTRL_NOTIFY = '0';
delete process.env.BROWSERCTRL_SOLVER_HOSTS;
delete process.env.TYPESAFE_API_KEY;
process.env.BROWSERCTRL_JEV_ENV = path.join(os.tmpdir(), 'no-such-jev.env');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-notify-'));
const script = path.join(dir, 'notify.sh');
const sent = path.join(dir, 'sent.txt');
fs.writeFileSync(script, `#!/bin/sh\nprintf '%s|' "$@" >> "${sent}"\nprintf '\\n' >> "${sent}"\n`, { mode: 0o755 });
const pings = () => (fs.existsSync(sent) ? fs.readFileSync(sent, 'utf8').trim().split('\n').filter(Boolean) : []);
const waitFor = async (fn, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 50))) if (fn()) return true; return false; };

// The handoff is built for macOS (notifications, Dia); these tests use a POSIX script.
const onWindows = process.platform === 'win32';

test('the notify command gets its own arguments and then the message, through the shell', { skip: onWindows && 'POSIX shell script' }, async () => {
  fs.rmSync(sent, { force: true });
  assert.equal(await ping('shopee.sg shows a "puzzle" $HOME `x`', `${script} --to me`), 'sent');
  assert.deepEqual(pings(), ['--to|me|shopee.sg shows a "puzzle" $HOME `x`|']);
  assert.equal(await ping('nothing set', ''), null);
  assert.match(await ping('x', path.join(dir, 'missing.sh')), /^failed/);
});

const haveBrowser = Boolean(chromeBinary());
let fixture, browser, conn;
before(async () => {
  if (!haveBrowser) return;
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => {
  delete process.env.BROWSERCTRL_NOTIFY_CMD;
  try { await conn?.stop(); } catch {}
  try { conn?.close(); } catch {}
  await browser?.close();
  await fixture?.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(cooldown.file(), { force: true });
});
const t = (name, fn) => test(name, { skip: onWindows ? 'handoff is macOS-oriented' : haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
const open = async p => { const { targetId } = await ops.newTab(conn, fixture.url + p); await ops.waitForReady(conn, targetId); return targetId; };

t('a handoff brings the tab to the front, pings, and resumes when the challenge clears', async () => {
  fs.rmSync(cooldown.file(), { force: true });
  fs.rmSync(sent, { force: true });
  process.env.BROWSERCTRL_NOTIFY_CMD = script;
  const other = await open('fixtures/page.html');
  await ops.focus(conn, other);
  const tab = await open('fixtures/jigsaw.html?seed=2&autoclear=1500');
  const started = Date.now();
  const r = await solve(conn, tab, { timeoutMs: 10000, pollMs: 250 });
  assert.equal(r.captcha, 'jigsaw-slider');
  assert.equal(r.solvedBy, 'human');
  assert.ok(r.waitedMs >= 900 && r.waitedMs <= 3500, `waited ${r.waitedMs}`);
  assert.ok(Date.now() - started < 5000, 'resumed promptly');
  assert.match(r.solver, /off for 127\.0\.0\.1/);
  const ping = pings();
  assert.equal(ping.length, 1);
  assert.match(ping[0], /^127\.0\.0\.1 shows a puzzle slider\. The tab is in front/);
  const rows = await ops.tabs(conn, { focus: true });
  assert.equal(rows.find(x => x.targetId === tab)?.focused, true, 'the challenge tab is the selected one');
  assert.equal(cooldown.active(fixture.url), null, 'cleared, so no cool-down');
  await ops.closeTab(conn, tab);
  await ops.closeTab(conn, other);
});

t('a handoff that runs out of time fails, names the site and leaves it cooling down', async () => {
  fs.rmSync(cooldown.file(), { force: true });
  fs.rmSync(sent, { force: true });
  process.env.BROWSERCTRL_NOTIFY_CMD = script;
  const tab = await open('verify/captcha?x=9');
  await assert.rejects(handoff(conn, tab, { timeoutMs: 1000, pollMs: 200 }), /verification-page on 127\.0\.0\.1 .*not cleared within 1s/);
  // handoff() alone does not record; solve() does.
  await assert.rejects(solve(conn, tab, { timeoutMs: 800, pollMs: 200 }), /cooling down until .*do not retry/);
  assert.equal(cooldown.active(fixture.url).kind, 'verification-page');
  assert.equal(pings().length, 2);
  assert.match(pings()[0], /verification page/);
  await ops.closeTab(conn, tab);
});

t('do hands a challenge that appears mid-plan to the human and carries on', async () => {
  fs.rmSync(cooldown.file(), { force: true });
  delete process.env.BROWSERCTRL_NOTIFY_CMD;
  const tab = await open('fixtures/page.html');
  const r = await runSteps(conn, tab, [`nav ${fixture.url}fixtures/jigsaw.html?seed=4&autoclear=1500`, 'wait 10'], { handoffMs: 10000 });
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(r.steps[0].challenge.solvedBy, 'human');
  assert.ok(r.steps[0].challenge.waitedMs > 500);
  assert.equal(r.steps.length, 2);
  await ops.closeTab(conn, tab);
});

t('do stops at the challenge when handoff is off, and the next plan to that site is refused', async () => {
  fs.rmSync(cooldown.file(), { force: true });
  const tab = await open('fixtures/page.html');
  const r = await runSteps(conn, tab, [`nav ${fixture.url}fixtures/jigsaw.html?seed=4`, 'wait 10'], { handoff: false });
  assert.equal(r.done, false);
  assert.equal(r.stopped.step, 1);
  assert.match(r.stopped.reason, /jigsaw-slider blocks tab .* handoff was skipped/);
  assert.equal(r.steps.length, 1);
  await assert.rejects(runSteps(conn, tab, [`nav ${fixture.url}fixtures/page.html`]), /cooling down/);
  await ops.closeTab(conn, tab);
});

t('a recipe hands its challenge to the human, then runs; with handoff off it fails at once', async () => {
  fs.rmSync(cooldown.file(), { force: true });
  const recipe = { name: 'fixture/handoff', origin: fixture.url, warm_path: '/fixtures/jigsaw.html?seed=6&autoclear=1500', settle_ms: 0, js: 'async () => ({ items: [{ ok: 1 }], next: null })' };
  const r = await runRecipe(conn, recipe, {}, { handoffMs: 10000 });
  assert.deepEqual(r.items, [{ ok: 1 }]);
  assert.equal(r.challenge.solvedBy, 'human');
  assert.ok(r.challenge.waitedMs > 500);

  const local = fixture.url.replace('127.0.0.1', 'localhost');
  const blocked = { ...recipe, name: 'fixture/blocked', origin: local, warm_path: '/fixtures/jigsaw.html?seed=6' };
  const started = Date.now();
  await assert.rejects(runRecipe(conn, blocked, {}, { handoff: false }), /handoff was skipped/);
  assert.ok(Date.now() - started < 15000);
  assert.equal(cooldown.active(local).kind, 'jigsaw-slider');
  await assert.rejects(runRecipe(conn, blocked, {}, {}), /refusing to run fixture\/blocked against it/);
});

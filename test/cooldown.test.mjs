// Per-site cool-down after a challenge: recorded, doubled on repeats within a
// day, capped, ended early when the challenge clears, and enforced by the CLI
// for commands that would load the site (open, nav, do with nav, recipe run).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import * as cooldown from '../lib/cooldown.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

// CLI calls from this test share one tab owner; otherwise each spawned call is a
// different shell and a tab claimed by the previous call is refused.
process.env.CDP_AGENT_ID = 'test-cooldown';
process.env.BROWSERCTRL_NOTIFY = '0';
delete process.env.BROWSERCTRL_NOTIFY_CMD;
delete process.env.TYPESAFE_API_KEY;
process.env.BROWSERCTRL_JEV_ENV = path.join(os.tmpdir(), 'no-such-jev.env');
const MIN = 60 * 1000;
const reset = () => fs.rmSync(cooldown.file(), { force: true });

test('a site is the registrable part of the host', () => {
  assert.equal(cooldown.siteOf('https://shopee.sg/verify/captcha'), 'shopee.sg');
  assert.equal(cooldown.siteOf('https://mall.shopee.sg/x'), 'shopee.sg');
  assert.equal(cooldown.siteOf('https://www.lazada.com.my/'), 'lazada.com.my');
  assert.equal(cooldown.siteOf('https://login.taobao.com/'), 'taobao.com');
  assert.equal(cooldown.siteOf('http://127.0.0.1:8123/a'), '127.0.0.1');
  assert.equal(cooldown.siteOf('http://localhost:8123/a'), 'localhost');
});

test('a challenge starts a 20 min cool-down that doubles within a day, capped at 2 h', () => {
  reset();
  const t0 = Date.parse('2026-10-14T10:00:00Z');
  const a = cooldown.record('https://shopee.sg/verify/captcha', { kind: 'shopee-verify', now: t0 });
  assert.equal(a.windowMs, 20 * MIN);
  assert.equal(a.strikes, 1);
  assert.equal(cooldown.active('https://mall.shopee.sg/', { now: t0 + 19 * MIN }).site, 'shopee.sg');
  assert.equal(cooldown.active('https://shopee.sg/', { now: t0 + 21 * MIN }), null);
  // Seen again inside the window: same window, not doubled.
  assert.equal(cooldown.record('https://shopee.sg/', { now: t0 + 5 * MIN }).windowMs, 20 * MIN);
  // Repeats after each window ends, within a day: 40, 80, 120 (cap), 120.
  let now = t0;
  for (const want of [40, 80, 120, 120]) {
    now += 3 * 60 * MIN;
    const e = cooldown.record('https://shopee.sg/', { kind: 'jigsaw-slider', now });
    assert.equal(e.windowMs, want * MIN, `strike ${e.strikes}`);
  }
  // More than a day after the last challenge, it starts over at 20 min.
  assert.equal(cooldown.record('https://shopee.sg/', { now: now + 25 * 60 * MIN }).windowMs, 20 * MIN);
  reset();
});

test('clearing the challenge ends the cool-down early but a repeat still doubles', () => {
  reset();
  const t0 = Date.now();
  cooldown.record('https://shopee.sg/', { now: t0 });
  assert.ok(cooldown.active('https://shopee.sg/', { now: t0 + MIN }));
  assert.ok(cooldown.clear('https://shopee.sg/', { now: t0 + MIN }));
  assert.equal(cooldown.active('https://shopee.sg/', { now: t0 + MIN + 1 }), null);
  assert.equal(cooldown.record('https://shopee.sg/', { now: t0 + 2 * MIN }).windowMs, 40 * MIN);
  reset();
});

test('the guard refuses a cooling site with when, why and how to override; other sites and --force pass', () => {
  reset();
  const now = Date.now();
  cooldown.record('https://shopee.sg/verify/captcha', { kind: 'shopee-verify', now });
  assert.throws(() => cooldown.guard('https://shopee.sg/cart', { action: 'open', now }), e =>
    e instanceof cooldown.CooldownError && /refusing to open it until/.test(e.message) && /--force/.test(e.message) &&
    /escalates/.test(e.message) && /shopee-verify/.test(e.message) && /20 min from now/.test(e.message));
  assert.equal(cooldown.guard('https://lazada.sg/', { now }), null);
  assert.equal(cooldown.guard('https://shopee.sg/', { force: true, now }).site, 'shopee.sg');
  assert.equal(cooldown.list({ now }).length, 1);
  reset();
});

// ---------------------------------------------------------------- CLI ----

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const cli = (...args) => exec(process.execPath, [path.join(ROOT, 'bin/browserctrl.mjs'), ...args, '--port', String(TEST_PORT)], { env: process.env, timeout: 60000 })
  .then(r => ({ code: 0, ...r }), e => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

const haveBrowser = Boolean(chromeBinary());
let fixture, browser, conn, local;
before(async () => {
  if (!haveBrowser) return;
  fixture = await startFixtureServer();
  local = fixture.url.replace('127.0.0.1', 'localhost'); // the same server under another site
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => {
  try { await conn?.stop(); } catch {}
  try { conn?.close(); } catch {}
  await browser?.close();
  await fixture?.close();
  fs.rmSync(path.join(process.env.BROWSERCTRL_RECIPES, '127.0.0.1'), { recursive: true, force: true });
  reset();
});
const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);

t('open on a challenge page records the cool-down and says not to retry', async () => {
  reset();
  const r = await cli('open', `${fixture.url}verify/captcha?x=1`);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /challenge: shopee-verify on tab \w{8}\. Cool-down: 127\.0\.0\.1 until/);
  assert.match(r.stderr, /Do not reload or retry/);
  assert.equal(JSON.parse(r.stdout).challenge, 'shopee-verify');
  assert.equal(cooldown.active(fixture.url).kind, 'shopee-verify');
});

t('during the cool-down, open, nav, do with nav and recipe run refuse the site; others and --force pass', async () => {
  assert.ok(cooldown.active(fixture.url), 'set by the previous test');
  const refused = /127\.0\.0\.1 is cooling down after a shopee-verify .*--force/s;

  const open = await cli('open', `${fixture.url}fixtures/page.html`);
  assert.equal(open.code, 1);
  assert.match(open.stderr, refused);

  const other = await cli('open', `${local}fixtures/page.html`);
  assert.equal(other.code, 0, other.stderr);
  const tab = JSON.parse(other.stdout).id;

  const nav = await cli('nav', tab, `${fixture.url}`);
  assert.equal(nav.code, 1);
  assert.match(nav.stderr, /refusing to navigate to it/);

  const plan = await cli('do', tab, 'wait 10', `nav ${fixture.url}`);
  assert.equal(plan.code, 1);
  assert.match(plan.stderr, refused);

  // Reading the already-open tab is still allowed.
  const text = await cli('text', tab);
  assert.equal(text.code, 0, text.stderr);

  fs.mkdirSync(path.join(process.env.BROWSERCTRL_RECIPES, '127.0.0.1'), { recursive: true });
  fs.writeFileSync(path.join(process.env.BROWSERCTRL_RECIPES, '127.0.0.1', 'cool.json'), JSON.stringify({ origin: fixture.url, js: 'async () => ({ items: [1], next: null })' }));
  const recipe = await cli('recipe', 'run', '127.0.0.1/cool');
  assert.equal(recipe.code, 1);
  assert.match(recipe.stderr, /refusing to run 127\.0\.0\.1\/cool against it/);

  const tabs = await cli('tabs');
  assert.match(tabs.stderr, /cool-down: 127\.0\.0\.1 until .*shopee-verify, 1st challenge today/);
  const doctor = await cli('doctor');
  assert.equal(JSON.parse(doctor.stdout).cooldowns[0].site, '127.0.0.1');

  const forced = await cli('open', `${fixture.url}fixtures/page.html`, '--force');
  assert.equal(forced.code, 0, forced.stderr);
  // A forced load that finds no challenge ends the cool-down.
  assert.equal(cooldown.active(fixture.url), null);
  await ops.closeTab(conn, (await ops.resolveTab(conn, tab)).targetId);
});

t('captcha on a cleared tab ends the cool-down early, and the site opens again', async () => {
  reset();
  const tab = await ops.newTab(conn, `${fixture.url}fixtures/page.html`);
  await ops.waitForReady(conn, tab.targetId);
  cooldown.record(fixture.url, { kind: 'jigsaw-slider' });
  assert.equal((await cli('open', `${fixture.url}fixtures/page.html`)).code, 1);
  const r = await cli('captcha', tab.id);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { captcha: null });
  assert.equal(cooldown.active(fixture.url), null);
  assert.equal((await cli('open', `${fixture.url}fixtures/page.html`)).code, 0);
  assert.match((await cli('cooldown')).stdout, /no site is cooling down/);
});

t('a second challenge the same day doubles the window', async () => {
  reset();
  const first = await cli('open', `${fixture.url}verify/captcha?x=3`, '--force');
  assert.equal(first.code, 0, first.stderr);
  assert.equal(cooldown.active(fixture.url).windowMs, 20 * MIN);
  const id = JSON.parse(first.stdout).id;
  // The human clears it; then the site challenges again.
  await ops.evaluate(conn, (await ops.resolveTab(conn, id)).targetId, "history.replaceState(null, '', '/done'), 1");
  assert.deepEqual(JSON.parse((await cli('captcha', id)).stdout), { captcha: null });
  const second = await cli('open', `${fixture.url}verify/captcha?x=4`);
  assert.equal(second.code, 0, second.stderr);
  const e = cooldown.active(fixture.url);
  assert.equal(e.windowMs, 40 * MIN);
  assert.equal(e.strikes, 2);
  assert.match(second.stderr, /2nd challenge today/);
});

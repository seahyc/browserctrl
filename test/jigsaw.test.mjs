// The opt-in jigsaw solver: PNG decoding, gap finding on synthetic images, and
// the real drag against a fixture puzzle that only passes a trusted, multi-move
// drag released within 4 px of the gap. Off by default: then the tab goes to
// the human instead.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import * as cooldown from '../lib/cooldown.mjs';
import * as jigsaw from '../lib/jigsaw.mjs';
import { detect, solve } from '../lib/captcha.mjs';
import { decodePng, encodePng } from '../lib/png.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

process.env.BROWSERCTRL_NOTIFY = '0';
delete process.env.BROWSERCTRL_NOTIFY_CMD;
delete process.env.BROWSERCTRL_SOLVER_HOSTS;

// A seeded noisy image with a darkened piece-sized window at gapX.
function synthetic(seed, gapX, { w = 320, h = 160, pw = 50, gy = 50, bright = false } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  const data = Buffer.alloc(w * h * 4);
  const blobs = Array.from({ length: 25 }, () => ({ x: rnd() * w, y: rnd() * h, r: 5 + rnd() * 25, c: rnd() * 255 }));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 80 + (x / w) * 90;
    for (const b of blobs) if ((x - b.x) ** 2 + (y - b.y) ** 2 < b.r ** 2) v = (v + b.c) / 2;
    v += (rnd() - 0.5) * 30;
    if (x >= gapX && x < gapX + pw && y >= gy && y < gy + pw) v = bright ? v + (255 - v) * 0.5 : v * 0.5;
    const i = (y * w + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = Math.max(0, Math.min(255, v)); data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}

test('PNG round trip: encode then decode returns the same pixels', () => {
  const img = synthetic(3, 100);
  const back = decodePng(encodePng(img));
  assert.equal(back.width, img.width);
  assert.equal(back.height, img.height);
  assert.ok(back.data.equals(img.data));
});

test('the gap is found within 2 px on noisy images, dark or light, with or without a known band', () => {
  for (const [seed, gapX] of [[1, 90], [2, 140], [3, 201], [4, 255], [5, 117]]) {
    const known = jigsaw.findGap(synthetic(seed, gapX), { x: 0, w: 50, y: 50, h: 50 });
    assert.ok(Math.abs(known.x - gapX) <= 2, `seed ${seed}: found ${known.x}, gap ${gapX}`);
    const band = jigsaw.findGap(synthetic(seed, gapX), { x: 0, w: 50, y: null, h: null });
    assert.ok(Math.abs(band.x - gapX) <= 2, `seed ${seed} (no band): found ${band.x}, gap ${gapX}`);
    const light = jigsaw.findGap(synthetic(seed, gapX, { bright: true }), { x: 0, w: 50, y: 50, h: 50 });
    assert.ok(Math.abs(light.x - gapX) <= 2, `seed ${seed} (light gap): found ${light.x}, gap ${gapX}`);
  }
});

test('matching the piece picture finds the gap even next to a darker decoy', () => {
  const crop = (img, x0, y0, cw, ch) => {
    const data = Buffer.alloc(cw * ch * 4);
    for (let y = 0; y < ch; y++) img.data.copy(data, y * cw * 4, ((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + cw) * 4);
    return { width: cw, height: ch, data };
  };
  for (const [seed, gapX, decoyX] of [[11, 120, 220], [12, 230, 100], [13, 160, 250]]) {
    const plain = synthetic(seed, -1000);
    const img = synthetic(seed, gapX);
    for (let y = 50; y < 100; y++) for (let x = decoyX; x < decoyX + 50; x++) for (let c = 0; c < 3; c++) img.data[(y * img.width + x) * 4 + c] *= 0.4;
    const r = jigsaw.findGap(img, { x: 0, w: 50, y: 50, h: 50 }, crop(plain, gapX, 50, 50, 50));
    assert.ok(Math.abs(r.x - gapX) <= 2, `seed ${seed}: found ${r.x}, gap ${gapX}, decoy ${decoyX}`);
    assert.ok(r.match > 0.8, `match ${r.match}`);
  }
});

test('the solver is enabled per site, from config or the environment, and warns', () => {
  const file = jigsaw.configFile();
  fs.rmSync(file, { force: true });
  assert.equal(jigsaw.solverEnabled('https://shopee.sg/verify/captcha'), false);
  const r = jigsaw.enable('shopee.sg');
  assert.match(r.warning, /defeats the site's bot check/);
  assert.equal(jigsaw.solverEnabled('https://shopee.sg/verify/captcha'), true);
  assert.equal(jigsaw.solverEnabled('https://www.shopee.sg/x'), true);
  assert.equal(jigsaw.solverEnabled('https://shopee.com.my/x'), false);
  jigsaw.disable('shopee.sg');
  assert.equal(jigsaw.solverEnabled('https://shopee.sg/'), false);
  process.env.BROWSERCTRL_SOLVER_HOSTS = 'example.com';
  assert.equal(jigsaw.solverEnabled('https://a.example.com/'), true);
  delete process.env.BROWSERCTRL_SOLVER_HOSTS;
  fs.rmSync(file, { force: true });
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
  try { await conn?.stop(); } catch {}
  try { conn?.close(); } catch {}
  await browser?.close();
  await fixture?.close();
  fs.rmSync(cooldown.file(), { force: true });
});
// The fixture puzzle is not detected in Windows headless Chrome; the solver targets macOS Dia.
const t = (name, fn) => test(name, { skip: process.platform === 'win32' ? 'macOS-oriented' : haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
const open = async p => { const { targetId } = await ops.newTab(conn, fixture.url + p); await ops.waitForReady(conn, targetId); return targetId; };
const state = tab => ops.evaluate(conn, tab, 'window.__jigsaw');

t('the fixture puzzle is detected as a jigsaw slider with its parts', async () => {
  const tab = await open('fixtures/jigsaw.html?seed=1');
  const found = await detect(conn, tab);
  assert.equal(found.kind, 'jigsaw-slider');
  assert.equal(Math.round(found.background.width), 340);
  assert.equal(Math.round(found.handle.width), 40);
  assert.ok(found.piece.width < 60);
  await ops.closeTab(conn, tab);
});

t('with the solver enabled it passes the puzzle at several gap positions', async () => {
  process.env.BROWSERCTRL_SOLVER_HOSTS = '127.0.0.1';
  try {
    for (const seed of [1, 7, 23, 42, 112]) {
      const tab = await open(`fixtures/jigsaw.html?seed=${seed}`);
      const r = await solve(conn, tab, { timeoutMs: 1500, pollMs: 200 });
      const s = await state(tab).catch(() => null);
      assert.equal(r.solvedBy, 'solver', `seed ${seed}: ${JSON.stringify({ r, s })}`);
      assert.equal(await ops.evaluate(conn, tab, "document.getElementById('msg').textContent"), 'Verified');
      assert.equal(s.attempts, 1, 'one drag only');
      assert.ok(s.results[0].moves >= 10);
      assert.ok(Math.abs(r.solver.gap.x - s.gapX) <= 3, `seed ${seed}: gap ${r.solver.gap.x} vs ${s.gapX}`);
      assert.equal(cooldown.active(fixture.url), null, 'clearing the challenge ends the cool-down');
      await ops.closeTab(conn, tab);
    }
  } finally { delete process.env.BROWSERCTRL_SOLVER_HOSTS; }
});

t('with the solver off the puzzle is never dragged and goes to the human', async () => {
  const tab = await open('fixtures/jigsaw.html?seed=5');
  await assert.rejects(solve(conn, tab, { timeoutMs: 1200, pollMs: 200 }), e => /was not cleared within/.test(e.message) && /off for 127\.0\.0\.1/.test(e.solver));
  assert.equal((await state(tab)).attempts, 0);
  assert.equal(cooldown.active(fixture.url).kind, 'jigsaw-slider');
  // The human solves it: the agent resumes and reports the wait.
  await ops.evaluate(conn, tab, "setTimeout(() => document.getElementById('box').remove(), 500), 1");
  const r = await solve(conn, tab, { timeoutMs: 5000, pollMs: 200 });
  assert.equal(r.solvedBy, 'human');
  assert.ok(r.waitedMs >= 300 && r.waitedMs < 3000, `waited ${r.waitedMs}`);
  assert.equal(cooldown.active(fixture.url), null);
  await ops.closeTab(conn, tab);
});

t('a failed solver attempt is made once, then the tab goes to the human', async () => {
  process.env.BROWSERCTRL_SOLVER_HOSTS = '127.0.0.1';
  try {
    const tab = await open('fixtures/jigsaw.html?seed=11&tol=-1');
    await assert.rejects(solve(conn, tab, { timeoutMs: 1500, pollMs: 200 }), e => /was not cleared within/.test(e.message) && e.solver?.failed === true);
    assert.equal((await state(tab)).attempts, 1);
    await ops.closeTab(conn, tab);
  } finally { delete process.env.BROWSERCTRL_SOLVER_HOSTS; }
});

// wake: a background tab renders (visible to itself) without being selected.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { startHeadlessBrowser, chromeBinary, scaled } from './helpers.mjs';

const PORT = 9342;
const haveBrowser = Boolean(chromeBinary());
let browser, conn;
before(async () => {
  if (!haveBrowser) return;
  browser = await startHeadlessBrowser(PORT);
  conn = await connect(PORT);
});
after(async () => {
  try { await conn?.stop(); } catch {}
  try { conn?.close(); } catch {}
  await browser?.close();
});
const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
const page = id => ops.evaluate(conn, id, `Promise.race([
  new Promise(r => requestAnimationFrame(() => r('frame'))),
  new Promise(r => setTimeout(() => r('no frame'), ${scaled(1500)})),
]).then(raf => ({ raf, visibilityState: document.visibilityState }))`, { timeoutMs: scaled(5000) });

t('wake makes a hidden background tab render without selecting it; wake --off undoes it', async () => {
  const tab = await ops.newTab(conn, 'data:text/html,<p>lazy</p>');
  await ops.newTab(conn, 'data:text/html,<p>opened later, so the first is not frontmost</p>');
  assert.deepEqual(await page(tab.targetId), { raf: 'no frame', visibilityState: 'hidden' });
  const woken = await ops.wake(conn, tab.targetId);
  assert.deepEqual([woken.rendering, woken.visibilityState], [true, 'visible']);
  assert.deepEqual(await page(tab.targetId), { raf: 'frame', visibilityState: 'visible' });
  const rows = await ops.tabs(conn, { focus: true });
  assert.deepEqual(rows.filter(r => r.targetId === tab.targetId).map(r => [r.rendering, r.focused]), [[true, false]], 'never reported as the focused tab');
  assert.equal((await ops.wake(conn, tab.targetId, { enabled: false })).visibilityState, 'hidden');
  assert.deepEqual(await page(tab.targetId), { raf: 'no frame', visibilityState: 'hidden' });
});

t('input and screenshot focus cleanup leave a rendering tab rendering', async () => {
  const tab = await ops.newTab(conn, 'data:text/html,<button onclick="this.textContent=1">b</button>');
  await ops.waitForReady(conn, tab.targetId);
  await ops.wake(conn, tab.targetId);
  await ops.click(conn, tab.targetId, { selector: 'button' });
  await ops.screenshot(conn, tab.targetId, { emulateFocus: true });
  assert.equal((await page(tab.targetId)).visibilityState, 'visible');
});

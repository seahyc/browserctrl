// Captchas on a tab: detect, try the one kind that is a plain drag, else hand
// the tab to the human and wait for it to clear.
//
// Only Alibaba's "drag to the far right" slider (the nc_ widget on Taobao and
// Tmall login and verification pages) is attempted, once, with a trusted mouse
// drag. Puzzle-gap sliders (Shopee), image challenges and sliders inside
// cross-origin frames go to the human.
import { execFile } from 'node:child_process';
import * as ops from './ops.mjs';

// Runs in the page. Looks in the main frame and same-origin frames, returning
// page coordinates for the slider handle and its track when there is one.
const DETECT = `(() => {
  const SLIDER = '#nc_1_n1z, .nc_iconfont.btn_slide, .btn_slide';
  const TRACK = '#nc_1__scale_text, .nc_scale, .nc-lang-cnt';
  const WORDS = /拖动到最右边|请按住滑块|滑动验证|slide to verify|drag the slider|verify you are human|security check/i;
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const frames = [{ doc: document, dx: 0, dy: 0 }];
  for (const f of document.querySelectorAll('iframe')) {
    try { const r = f.getBoundingClientRect(); if (f.contentDocument) frames.push({ doc: f.contentDocument, dx: r.left, dy: r.top }); } catch {}
  }
  for (const { doc, dx, dy } of frames) {
    const handle = [...doc.querySelectorAll(SLIDER)].find(visible);
    if (!handle) continue;
    const track = handle.closest(TRACK) || handle.parentElement;
    const h = handle.getBoundingClientRect(), t = track.getBoundingClientRect();
    return { kind: 'alibaba-slider', handle: { x: dx + h.left + h.width / 2, y: dy + h.top + h.height / 2 }, trackEnd: dx + t.right };
  }
  if (/\\/verify\\/(captcha|traffic)/.test(location.pathname)) return { kind: 'shopee-verify' };
  if ([...document.querySelectorAll('iframe')].some(f => /captcha|punish|verify|baxia/i.test(f.src) && visible(f))) return { kind: 'framed-challenge' };
  const text = (document.body && document.body.innerText || '').slice(0, 5000);
  if (WORDS.test(text)) return { kind: 'unknown-challenge' };
  return null;
})()`;

export const detect = (conn, targetId) => ops.evaluate(conn, targetId, DETECT, { timeoutMs: 8000 });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const easeOut = t => 1 - (1 - t) ** 3;

// One drag from the handle to just past the track end, decelerating like a hand.
async function dragSlider(conn, targetId, { handle, trackEnd }, rand = Math.random) {
  const send = (type, x, y) => conn.send(targetId, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1 });
  const endX = trackEnd + 4;
  await conn.send(targetId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x - 30, y: handle.y + 8 });
  await sleep(120 + rand() * 120);
  await conn.send(targetId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x, y: handle.y });
  await send('mousePressed', handle.x, handle.y);
  const steps = 28 + Math.floor(rand() * 10);
  for (let i = 1; i <= steps; i++) {
    const x = handle.x + (endX - handle.x) * easeOut(i / steps);
    const y = handle.y + (rand() - 0.5) * 3;
    await send('mouseMoved', Math.round(x), Math.round(y));
    await sleep(12 + rand() * 18);
  }
  await sleep(80 + rand() * 120);
  await send('mouseReleased', endX, handle.y);
}

function notify(message) {
  if (process.env.BROWSERCTRL_NOTIFY === '0' || process.platform !== 'darwin') return;
  execFile('osascript', ['-e', `display notification ${JSON.stringify(message)} with title "browserctrl"`], () => {});
}

// Detect and clear a captcha on the tab. Returns how it cleared, or throws when
// the human did not clear it in time.
export async function solve(conn, targetId, { timeoutMs = 300000, attempt = true, pollMs = 1000 } = {}) {
  const found = await detect(conn, targetId);
  if (!found) return { captcha: null };
  if (attempt && found.kind === 'alibaba-slider') {
    await dragSlider(conn, targetId, found);
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      if (!(await detect(conn, targetId))) return { captcha: found.kind, solvedBy: 'auto' };
    }
  }
  const title = await ops.evaluate(conn, targetId, 'document.title', { timeoutMs: 5000 }).catch(() => '');
  notify(`A ${found.kind === 'alibaba-slider' ? 'slider' : 'verification'} on "${title}" needs you. The agent waits until it clears.`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const still = await detect(conn, targetId).catch(() => found);
    if (!still) return { captcha: found.kind, solvedBy: 'human' };
  }
  throw new Error(`The ${found.kind} on tab ${targetId.slice(0, 8)} was not cleared within ${Math.round(timeoutMs / 1000)}s.`);
}

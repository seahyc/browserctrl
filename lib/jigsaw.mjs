// Opt-in solver for "slide to complete the puzzle" jigsaw sliders (sites like Shopee and
// similar): a background image with a gap, a piece image, and a slider handle.
// OFF by default; enabled per site with `browserctrl captcha solver enable <site>`.
// It makes one attempt; anything else goes to the human.
//
// Element discovery is generic (a small handle near a wider track, with the
// puzzle images in the same container) and can be pinned per site with CSS
// selectors in ~/.config/browserctrl/captcha.json:
//   { "solver": { "hosts": ["shopee.sg"] },
//     "selectors": { "shopee.sg": { "handle": "...", "track": "...", "background": "...", "piece": "..." } } }
// The gap is found from a screenshot of the background element, decoded here
// (lib/png.mjs), by looking for the piece-sized window whose inside differs most
// from its surroundings and whose sides are the strongest vertical edges.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ops from './ops.mjs';
import { decodePng } from './png.mjs';
import { siteOf } from './cooldown.mjs';

export const WARNING = 'The jigsaw solver defeats the site\'s bot check: it may break the site\'s terms and can escalate to stronger checks. It makes one attempt, then hands the tab to you.';

export const configFile = () => process.env.BROWSERCTRL_CAPTCHA_CONFIG || path.join(os.homedir(), '.config/browserctrl/captcha.json');

export function readConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch {}
  return { ...c, solver: { hosts: [], ...(c.solver || {}) }, selectors: c.selectors || {} };
}
function writeConfig(c) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(c, null, 2) + '\n');
}

const siteKey = host => siteOf(/^[a-z]+:\/\//i.test(host) ? host : `https://${host}`);

// Enabled hosts come from the config file and from BROWSERCTRL_SOLVER_HOSTS
// (comma-separated), which tests and one-off runs use.
export function solverHosts() {
  const env = (process.env.BROWSERCTRL_SOLVER_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
  return [...new Set([...readConfig().solver.hosts, ...env].map(siteKey).filter(Boolean))];
}
export const solverEnabled = url => { const s = siteOf(url); return Boolean(s) && solverHosts().includes(s); };

export function enable(host) {
  const site = siteKey(host);
  if (!site) throw new Error('Usage: browserctrl captcha solver enable <site, e.g. shopee.sg>');
  const c = readConfig();
  c.solver.hosts = [...new Set([...c.solver.hosts, site])];
  writeConfig(c);
  return { enabled: site, hosts: c.solver.hosts, warning: WARNING, config: configFile() };
}
export function disable(host) {
  const site = siteKey(host);
  const c = readConfig();
  c.solver.hosts = c.solver.hosts.filter(h => h !== site);
  writeConfig(c);
  return { disabled: site, hosts: c.solver.hosts, config: configFile() };
}

// In-page discovery, used by captcha.detect. `selectors` is the config map
// (site → selectors); the page picks the entry for its own host. Returns
// viewport coordinates (top document) and tags the elements with
// data-bc-jigsaw so the solver can re-read their positions mid-drag.
export function discoverSource(selectors = {}) {
  return `(() => {
  const SELECTORS = ${JSON.stringify(selectors)};
  const host = location.hostname;
  const pinned = Object.entries(SELECTORS).find(([h]) => host === h || host.endsWith('.' + h))?.[1] || null;
  const WORDS = /puzzle|拼图|slide to|drag the|verif|captcha|验证|滑块|robot|human/i;
  const HANDLE = '[role=slider], [class*=slider i], [class*=handle i], [class*=drag i], [class*=thumb i], [class*=knob i], [id*=slider i], [id*=handle i], [aria-label*=slide i], [aria-label*=drag i]';
  const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
  const box = (r, dx, dy) => ({ left: dx + r.left, top: dy + r.top, width: r.width, height: r.height, right: dx + r.right, bottom: dy + r.bottom });
  const isImage = el => el.tagName === 'IMG' || el.tagName === 'CANVAS' || /url\\(/.test(getComputedStyle(el).backgroundImage);
  const frames = [{ doc: document, dx: 0, dy: 0 }];
  for (const f of document.querySelectorAll('iframe')) {
    try { const r = f.getBoundingClientRect(); if (f.contentDocument) frames.push({ doc: f.contentDocument, dx: r.left, dy: r.top }); } catch {}
  }
  for (const { doc, dx, dy } of frames) {
    const q = s => { try { return s ? [...doc.querySelectorAll(s)].filter(vis) : []; } catch { return []; } };
    const handles = (pinned?.handle ? q(pinned.handle) : q(HANDLE).filter(el => { const r = el.getBoundingClientRect(); return r.width >= 14 && r.width <= 90 && r.height >= 14 && r.height <= 90; }));
    for (const handle of handles) {
      const hr = handle.getBoundingClientRect();
      let track = pinned?.track ? q(pinned.track)[0] : null;
      for (let n = handle.parentElement; !track && n && n !== doc.body; n = n.parentElement) if (n.getBoundingClientRect().width >= hr.width * 3) track = n;
      if (!track) continue;
      let bg = pinned?.background ? q(pinned.background)[0] : null;
      let piece = pinned?.piece ? q(pinned.piece)[0] : null;
      let container = track;
      if (!bg) {
        for (let n = track, i = 0; n && i < 7 && !bg; n = n.parentElement, i++) {
          container = n;
          const imgs = [...n.querySelectorAll('img, canvas, div, span')].slice(0, 400).filter(el => !handle.contains(el) && !el.contains(handle) && vis(el) && isImage(el))
            .map(el => ({ el, r: el.getBoundingClientRect() })).filter(x => x.r.width * x.r.height >= 400);
          if (!imgs.length) continue;
          imgs.sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
          const big = imgs[0];
          if (big.r.width < hr.width * 2.5 || big.r.height < 40) continue;
          const pieces = imgs.slice(1).filter(x => x.r.width < big.r.width * 0.5 && x.r.left >= big.r.left - 8 && x.r.right <= big.r.right + 8 && x.r.bottom > big.r.top && x.r.top < big.r.bottom)
            .sort((a, b) => a.r.left - b.r.left);
          if (!pieces.length) continue;
          bg = big.el; piece = piece || pieces[0].el;
        }
      }
      if (!bg || !piece) continue;
      let flagged = Boolean(pinned);
      for (let n = container; n && !flagged; n = n.parentElement) if (/captcha|verify|puzzle|challenge/i.test((n.id || '') + ' ' + (typeof n.className === 'string' ? n.className : ''))) flagged = true;
      if (!flagged && !WORDS.test((container.innerText || '') + ' ' + (doc.body.innerText || '').slice(0, 3000))) continue;
      handle.setAttribute('data-bc-jigsaw', 'handle'); piece.setAttribute('data-bc-jigsaw', 'piece'); bg.setAttribute('data-bc-jigsaw', 'background');
      return { kind: 'jigsaw-slider', pinned: Boolean(pinned), frame: doc !== document,
        handle: { ...box(hr, dx, dy), x: dx + hr.left + hr.width / 2, y: dy + hr.top + hr.height / 2 },
        track: box(track.getBoundingClientRect(), dx, dy), background: box(bg.getBoundingClientRect(), dx, dy), piece: box(piece.getBoundingClientRect(), dx, dy),
        scroll: { x: scrollX, y: scrollY }, dpr: devicePixelRatio };
    }
  }
  return null;
})()`;
}

// Where the piece is now, in viewport coordinates.
const PIECE_NOW = `(() => {
  const find = d => d.querySelector('[data-bc-jigsaw=piece]');
  let el = find(document), dx = 0;
  if (!el) for (const f of document.querySelectorAll('iframe')) { try { el = find(f.contentDocument); if (el) { dx = f.getBoundingClientRect().left; break; } } catch {} }
  return el ? dx + el.getBoundingClientRect().left : null;
})()`;

// ------------------------------------------------------------ gap finding ---

const grey = ({ width, height, data }) => {
  const G = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) G[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  return G;
};

// img: decoded RGBA of the background; piece: { x, w, y, h } in image pixels
// (x = where the piece sits now, whose columns are skipped). y/h may be null
// when the piece element spans the whole height; then every band of the
// piece's width is tried. pieceImg (optional, same scale): the piece itself.
// The gap holds the piece's own picture, darkened or lightened, so the centre
// of the piece correlates with the centre of the gap (normalised
// cross-correlation ignores the change in brightness and contrast).
export function findGap(img, piece, pieceImg = null) {
  const { width: w, height: h } = img;
  const G = grey(img);
  // Integral images of brightness and of horizontal gradient magnitude.
  const W1 = w + 1;
  const S = new Float64Array(W1 * (h + 1)), A = new Float64Array(W1 * (h + 1)), Q = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0, ra = 0, rq = 0;
    for (let x = 0; x < w; x++) {
      const v = G[y * w + x];
      rs += v; rq += v * v;
      ra += x > 0 ? Math.abs(v - G[y * w + x - 1]) : 0;
      S[(y + 1) * W1 + x + 1] = S[y * W1 + x + 1] + rs;
      A[(y + 1) * W1 + x + 1] = A[y * W1 + x + 1] + ra;
      Q[(y + 1) * W1 + x + 1] = Q[y * W1 + x + 1] + rq;
    }
  }
  const mean = (I, x0, y0, x1, y1) => {
    x0 = Math.max(0, Math.min(w, x0)); x1 = Math.max(0, Math.min(w, x1));
    y0 = Math.max(0, Math.min(h, y0)); y1 = Math.max(0, Math.min(h, y1));
    const n = (x1 - x0) * (y1 - y0);
    return n > 0 ? (I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0]) / n : null;
  };
  const pw = Math.max(8, Math.round(piece.w));
  const ph = piece.h && piece.h < h * 0.9 ? Math.round(piece.h) : Math.min(pw, h);
  const ys = piece.h && piece.h < h * 0.9 ? [Math.max(0, Math.min(h - ph, Math.round(piece.y)))] : Array.from({ length: Math.floor((h - ph) / 2) + 1 }, (_, i) => i * 2);
  const m = Math.max(2, Math.round(pw * 0.08)), k = Math.max(4, Math.round(pw * 0.12));
  // The piece's core, clear of knobs, outline and transparent corners.
  let core = null;
  if (pieceImg && piece.h && piece.h < h * 0.9) {
    const PG = grey(pieceImg), inset = Math.round(Math.min(pieceImg.width, pieceImg.height) * 0.24);
    const cw = pieceImg.width - 2 * inset, ch = pieceImg.height - 2 * inset;
    if (cw >= 6 && ch >= 6) {
      const vals = new Float64Array(cw * ch);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) vals[y * cw + x] = PG[(y + inset) * pieceImg.width + x + inset];
      const mu = vals.reduce((a, b) => a + b, 0) / vals.length;
      for (let i = 0; i < vals.length; i++) vals[i] -= mu;
      const norm = Math.sqrt(vals.reduce((a, b) => a + b * b, 0));
      if (norm > 1e-6) core = { vals, cw, ch, inset, norm };
    }
  }
  const ncc = (x, y) => {
    const x0 = x + core.inset, y0 = y + core.inset;
    if (x0 < 0 || y0 < 0 || x0 + core.cw > w || y0 + core.ch > h) return 0;
    const n = core.cw * core.ch;
    const sum = mean(S, x0, y0, x0 + core.cw, y0 + core.ch) * n, sq = mean(Q, x0, y0, x0 + core.cw, y0 + core.ch) * n;
    const sd = Math.sqrt(Math.max(1e-9, sq - sum * sum / n));
    let dot = 0;
    for (let yy = 0; yy < core.ch; yy++) {
      const row = (y0 + yy) * w + x0, prow = yy * core.cw;
      for (let xx = 0; xx < core.cw; xx++) dot += core.vals[prow + xx] * G[row + xx];
    }
    return dot / (core.norm * sd);
  };
  const rows = [];
  for (let x = 0; x + pw <= w; x++) {
    if (x > piece.x - pw * 0.8 && x < piece.x + pw * 0.8) continue;
    for (const y of ys) {
      const inner = mean(S, x + m, y + m, x + pw - m, y + ph - m);
      const left = mean(S, x - k, y + m, x - 1, y + ph - m), right = mean(S, x + pw + 1, y + m, x + pw + k, y + ph - m);
      if (inner == null || (left == null && right == null)) continue;
      // Both sides must differ from the inside the same way: a window that only
      // borders the gap on one side (and so sees it as its neighbour) does not.
      const dl = left == null ? right - inner : left - inner, dr = right == null ? dl : right - inner;
      const contrast = Math.sign(dl) === Math.sign(dr) ? Math.min(Math.abs(dl), Math.abs(dr)) : 0;
      const edge = (mean(A, x - 1, y, x + 2, y + ph) || 0) + (mean(A, x + pw - 1, y, x + pw + 2, y + ph) || 0) + (mean(A, x, y - 1, x + pw, y + 2) || 0);
      rows.push({ x, y, contrast, edge, ...(core ? { match: ncc(x, y) } : {}) });
    }
  }
  if (!rows.length) return null;
  const z = key => {
    const mu = rows.reduce((s, r) => s + r[key], 0) / rows.length;
    const sd = Math.sqrt(rows.reduce((s, r) => s + (r[key] - mu) ** 2, 0) / rows.length) || 1;
    for (const r of rows) r[`z_${key}`] = (r[key] - mu) / sd;
  };
  z('contrast'); z('edge');
  if (core) z('match');
  for (const r of rows) r.score = r.z_contrast + r.z_edge + (core ? 2 * r.z_match : 0);
  rows.sort((a, b) => b.score - a.score);
  const best = rows[0];
  // Margin over the best candidate that is clearly elsewhere: low means unsure.
  const rival = rows.find(r => Math.abs(r.x - best.x) > pw / 2);
  return { x: best.x, y: best.y, w: pw, h: ph, score: Math.round(best.score * 100) / 100, margin: rival ? Math.round((best.score - rival.score) * 100) / 100 : null, ...(core ? { match: Math.round(best.match * 100) / 100 } : {}) };
}

// ------------------------------------------------------------------ drag ----

const sleep = ms => new Promise(r => setTimeout(r, ms));
const easeOut = t => 1 - (1 - t) ** 3;

export async function locateGap(conn, targetId, found) {
  const bg = found.background;
  const clip = { x: bg.left + found.scroll.x, y: bg.top + found.scroll.y, width: bg.width, height: bg.height, scale: 1 };
  const shot = await conn.send(targetId, 'Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true }, 20000);
  const img = decodePng(Buffer.from(shot.data, 'base64'));
  const s = img.width / bg.width;
  const p = found.piece;
  const fullHeight = p.height >= bg.height * 0.9;
  let pieceImg = null;
  if (!fullHeight) {
    const pc = { x: p.left + found.scroll.x, y: p.top + found.scroll.y, width: p.width, height: p.height, scale: 1 };
    const ps = await conn.send(targetId, 'Page.captureScreenshot', { format: 'png', clip: pc, captureBeyondViewport: true }, 20000).catch(() => null);
    if (ps) pieceImg = decodePng(Buffer.from(ps.data, 'base64'));
  }
  const gap = findGap(img, { x: (p.left - bg.left) * s, w: p.width * s, y: fullHeight ? null : (p.top - bg.top) * s, h: fullHeight ? null : p.height * s }, pieceImg);
  if (!gap) return null;
  return { ...gap, cssX: gap.x / s, scale: s, image: img };
}

// One human-paced drag that lands the piece on the gap: approach, press, a short
// probe to learn how far the piece moves per pixel of handle travel, an
// ease-out run with small vertical jitter that overshoots a little, a settle
// back, a check of where the piece sits, and release.
// The tab is brought to the front first: a background tab delivers each mouse
// event only on its next (throttled) frame, about 100 ms apart, which turns a
// one-second drag into a slow crawl.
export async function solveJigsaw(conn, targetId, found, { rand = Math.random, focus = true } = {}) {
  if (focus) await ops.focus(conn, targetId).catch(() => {});
  if (conn.render) await conn.render(targetId, { timeoutMs: 5000 }).catch(() => {});
  const gap = await locateGap(conn, targetId, found);
  if (!gap) return { attempted: false, reason: 'no gap found' };
  const { handle, piece, background: bg, track } = found;
  const gapX = bg.left + gap.cssX; // viewport x where the piece's left edge must land
  const need = gapX - piece.left;
  let ratio = (bg.width - piece.width) / Math.max(1, track.width - handle.width);
  if (!Number.isFinite(ratio) || ratio <= 0.2 || ratio > 5) ratio = 1;

  const move = (x, y, buttons = 1) => conn.send(targetId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: buttons ? 'left' : 'none', buttons });
  const y0 = handle.y + (rand() - 0.5) * 4;
  const x0 = handle.x + (rand() - 0.5) * Math.min(8, handle.width / 3);
  await move(x0 - 40 - rand() * 30, y0 + 15 + rand() * 10, 0);
  await sleep(90 + rand() * 120);
  await move(x0 - 8, y0 + 3, 0);
  await sleep(40 + rand() * 60);
  await move(x0, y0, 0);
  await sleep(60 + rand() * 100);
  await conn.send(targetId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(80 + rand() * 120);

  let cx = x0, cy = y0;
  const run = async (to, steps, { jitter = 1.5, overshoot = 0 } = {}) => {
    const from = cx;
    for (let i = 1; i <= steps; i++) {
      cx = from + (to + overshoot - from) * easeOut(i / steps);
      cy = y0 + (rand() - 0.5) * 2 * jitter;
      await move(Math.round(cx * 10) / 10, Math.round(cy * 10) / 10);
      await sleep(10 + rand() * 20);
    }
  };

  // Probe: a short slow start, then read how far the piece followed.
  const probe = Math.max(8, Math.min(30, Math.abs(need / ratio) * 0.3)) * Math.sign(need || 1);
  await run(x0 + probe, 5 + Math.floor(rand() * 3), { jitter: 0.8 });
  await sleep(50);
  const at = await ops.evaluate(conn, targetId, PIECE_NOW, { timeoutMs: 3000 }).catch(() => null);
  if (at != null && Math.abs(at - piece.left) > 1 && Math.abs(cx - x0) > 1) ratio = (at - piece.left) / (cx - x0);
  const target = x0 + need / ratio;
  const overshoot = (3 + rand() * 4) * Math.sign(need || 1);
  await run(target, 22 + Math.floor(rand() * 10), { overshoot });
  await sleep(60 + rand() * 90);
  await run(target, 3 + Math.floor(rand() * 2), { jitter: 0.6 });
  await sleep(120 + rand() * 120);

  // Correct a residual error the way a hand would: a couple of small nudges.
  for (let i = 0; i < 2; i++) {
    const now = await ops.evaluate(conn, targetId, PIECE_NOW, { timeoutMs: 3000 }).catch(() => null);
    if (now == null) break;
    const err = gapX - now;
    if (Math.abs(err) < 1.5) break;
    await run(cx + err / ratio, 3, { jitter: 0.5 });
    await sleep(100 + rand() * 100);
  }
  await conn.send(targetId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(cx * 10) / 10, y: Math.round(cy * 10) / 10, button: 'left', buttons: 0, clickCount: 1 });
  return { attempted: true, gap: { x: Math.round(gap.cssX * 10) / 10, score: gap.score, margin: gap.margin }, ratio: Math.round(ratio * 1000) / 1000, travel: Math.round(cx - x0) };
}

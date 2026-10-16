// Real-time video of a recording (`rec`): the rrweb DOM events replayed in a private
// headless Chrome, one frame per 1/fps of recorded time, with a caption for the step in
// progress, a running clock, and the step's still where DOM replay has nothing to show
// (before the first snapshot, cross-origin iframes, canvas). Frames are taken by seeking
// the replayer to each frame's time, not by playing it against the wall clock, so the
// video keeps the recording's real timing however slow the machine is. A frame whose
// replay state, caption and clock are unchanged reuses the previous image, so the long
// stretches where an agent is thinking cost nothing to render.
//
// Side by side: each recording is rendered on its own clock from its start, padded to
// the longer one (the faster run freezes on its last frame under a "Done in m:ss" badge),
// and the two are stacked horizontally with ffmpeg. A GIF preview, sped up, can be
// written next to the MP4.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readEvents, readJsonl } from './rec.mjs';

const VENDOR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'rrweb');
const HEADER = 44;            // title and clock bar, CSS px
const TAIL_MS = 2000;         // hold on the final frame
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- captions ---

const short = (s, n = 42) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const unq = s => String(s ?? '').trim().replace(/^["'“”]|["'“”]$/g, '');
const isRef = s => /^(ref_\d+|e\d+|i\d+)$/.test(unq(s)) || /^[#.[]/.test(unq(s));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return short(u, 30); } };

// A step's action line ("do: fill \"Where\" = \"Cleveland\"", "read", "click ref_9") in
// words a person who has never seen the tool can follow.
export function plainCaption(action) {
  let a = String(action || '').trim();
  if (!a || /^(stop recording|start recording)$/.test(a)) return null;
  a = a.replace(/^do:\s*/, '').replace(/\s+=>\s+.*$/, '').replace(/^optional\s+/, '');
  let m;
  if ((m = a.match(/^date\s+(\d{4})-(\d{2})-(\d{2})/))) return `Picking ${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]} in the calendar`;
  if ((m = a.match(/^(?:fill!?|type)\s+(.*?)\s*=\s*(.*)$/))) {
    const field = unq(m[1]), value = unq(m[2]).replace(/^(ref_\d+|e\d+)\s+/, '');
    if (!field || isRef(field)) return `Typing “${short(value, 40)}”`;
    return `Typing “${short(value, 32)}” into ${short(field, 28)}`;
  }
  if ((m = a.match(/^fill!?\s+=?\s*"?(ref_\d+)\s+(.*?)"?$/))) return `Typing “${short(unq(m[2]), 40)}”`;
  if ((m = a.match(/^select!?\s+(.*?)\s*=\s*(.*)$/))) {
    const [field, value] = [unq(m[1]), unq(m[2])];
    return isRef(field) || !field ? `Choosing “${short(value, 40)}”` : `Choosing “${short(value, 30)}” for ${short(field, 26)}`;
  }
  if ((m = a.match(/^click!?\s+(.*)$/))) {
    const target = unq(m[1]);
    return isRef(target) ? 'Clicking the item it picked on the page' : `Clicking “${short(target, 44)}”`;
  }
  if ((m = a.match(/^hover\s+(.*)$/))) return `Pointing at “${short(unq(m[1]), 44)}”`;
  if ((m = a.match(/^key\s+(.*)$/))) return `Pressing ${short(unq(m[1]), 20)}`;
  if ((m = a.match(/^(?:nav|open)\s+(\S+)/))) return `Going to ${hostOf(unq(m[1]))}`;
  if (/^scroll/.test(a)) return 'Scrolling';
  if (/^(read|text|items|check|expect)\b/.test(a)) return 'Reading the page';
  if (/^reload/.test(a)) return 'Reloading the page';
  if (/^wait/.test(a)) return 'Waiting for the page';
  if (/^dialog/.test(a)) return 'Answering a pop-up';
  return short(a, 50);
}

// Captions on the recording's clock (ms from its start). A step is logged when it has
// finished (its still is taken then), so its caption starts up to 1.5 s earlier, while
// the action was happening, and stays 2.5 s; gaps between steps are the agent thinking.
export function captionTrack(steps, startedAt, endMs) {
  const acts = steps.filter(s => typeof s.at === 'number' && plainCaption(s.action))
    .map(s => ({ at: s.at - startedAt, text: plainCaption(s.action) + (s.status === 'FAILED' ? ' (didn’t work)' : '') }));
  const out = [];
  let prevAt = 0;
  for (let i = 0; i < acts.length; i++) {
    const s = acts[i];
    const from = Math.max(prevAt, s.at - 1500, 0);
    const next = acts[i + 1] ? Math.max(acts[i + 1].at - 1500, s.at) : Infinity;
    out.push({ from, to: Math.min(s.at + 2500, next), text: s.text });
    prevAt = s.at;
  }
  const first = out[0]?.from ?? 0;
  const last = acts.at(-1)?.at ?? 0;
  return { captions: out, thinkingFrom: first, thinkingTo: last, endMs };
}

// ------------------------------------------------------------- recording ---

function readRecording(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const events = readEvents(dir).sort((a, b) => a.timestamp - b.timestamp);
  const steps = readJsonl(path.join(dir, 'steps.jsonl'));
  const startedAt = meta.startedAt ?? events[0]?.timestamp ?? steps[0]?.at;
  const lastAt = Math.max(meta.endedAt || 0, events.at(-1)?.timestamp || 0, ...steps.map(s => s.at || 0));
  const stills = steps.filter(s => s.screenshot && typeof s.at === 'number').map(s => {
    try { return { at: s.at - startedAt, src: 'data:image/jpeg;base64,' + fs.readFileSync(path.join(dir, 'trajectory', s.screenshot)).toString('base64') }; }
    catch { return null; }
  }).filter(Boolean);
  return { meta, events, steps, startedAt, durationMs: Math.max(0, lastAt - startedAt), stills };
}

const clockText = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function pageHtml(recording, { width, height, label, captions, clock, totalMs }) {
  const player = fs.readFileSync(path.join(VENDOR, 'rrweb-player.umd.min.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
  const css = fs.readFileSync(path.join(VENDOR, 'rrweb-player.min.css'), 'utf8');
  const track = captionTrack(recording.steps, recording.startedAt, recording.durationMs);
  const data = {
    events: recording.events, startedAt: recording.startedAt, durationMs: recording.durationMs, totalMs,
    stills: recording.stills, track, label, captions, clock, areaW: width, areaH: height - HEADER,
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html><meta charset=utf-8>
<style>${css}
html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#111;font-family:-apple-system,"Helvetica Neue",Arial,sans-serif}
#bar{height:${HEADER}px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;box-sizing:border-box;background:#1c1c1e;color:#f2f2f2}
#label{font-size:19px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#clock{font:600 20px/1 ui-monospace,Menlo,monospace;color:#ffd60a}
#area{position:relative;width:${width}px;height:${height - HEADER}px;overflow:hidden;background:#fff}
#player{position:absolute;inset:0}
.rr-player{background:#fff!important;box-shadow:none!important;border-radius:0!important}
.rr-player__frame{margin:0 auto}
#still{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#fff;display:none}
#cap{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);max-width:88%;padding:10px 20px;border-radius:12px;background:rgba(20,20,22,.86);color:#fff;font-size:${Math.max(16, Math.round(width / 52))}px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none}
#cap.think{background:rgba(20,20,22,.55);color:#d0d0d0;font-style:italic;font-weight:400}
#done{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.35)}
#done span{padding:18px 34px;border-radius:16px;background:#30d158;color:#04210d;font-size:${Math.max(22, Math.round(width / 26))}px;font-weight:700}
</style>
<div id=bar><div id=label></div><div id=clock></div></div>
<div id=area><div id=player></div><img id=still><div id=cap></div><div id=done><span></span></div></div>
<script>${player}</script>
<script>
const D = ${json};
const $ = id => document.getElementById(id);
const times = D.events.map(e => e.timestamp);
const fulls = D.events.filter(e => e.type === 2).map(e => e.timestamp);
let replayer = null, lastIdx = -1, lastFull = -1, lastStill = null;
const fmt = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const upto = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m + 1; else hi = m; } return lo - 1; };
$('label').textContent = D.label || '';
window.__init = () => {
  if (fulls.length) {
    const Player = rrwebPlayer.default || rrwebPlayer.Player || rrwebPlayer;
    const p = new Player({ target: $('player'), props: { events: D.events, width: D.areaW, height: D.areaH, autoPlay: false, showController: false, skipInactive: false, mouseTail: false, UNSAFE_replayCanvas: true } });
    replayer = p.getReplayer();
    replayer.pause(0);
  }
  return { events: D.events.length, fulls: fulls.length, durationMs: D.durationMs };
};
function blank() {
  // Nothing rrweb can show: no document yet, an empty body, or a page that is mostly a
  // cross-origin iframe or canvas (recorded as an empty box).
  const doc = replayer && replayer.iframe && replayer.iframe.contentDocument;
  if (!doc || !doc.body) return true;
  const vw = doc.documentElement.clientWidth || 1, vh = doc.documentElement.clientHeight || 1;
  for (const el of doc.querySelectorAll('iframe,canvas')) {
    const r = el.getBoundingClientRect();
    const area = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    if (area < 0.55 * vw * vh) continue;
    if (el.tagName === 'CANVAS') return true;
    let inner = null; try { inner = el.contentDocument; } catch {}
    if (!inner || !inner.body || inner.body.childElementCount === 0) return true;
  }
  return (doc.body.innerText || '').trim().length < 15 && !doc.querySelector('img,svg,video');
}
async function imagesSettled(maxMs) {
  const doc = replayer && replayer.iframe && replayer.iframe.contentDocument;
  if (!doc) return;
  const until = performance.now() + maxMs;
  while (performance.now() < until) {
    const pending = [...doc.images].filter(i => !i.complete && i.getBoundingClientRect().top < innerHeight);
    if (!pending.length) return;
    await new Promise(r => setTimeout(r, 60));
  }
}
// Show the recording at time t (ms from its start). Returns a signature: the same
// signature means the same picture, so the caller can reuse the last frame.
window.__frame = async (t) => {
  const end = D.durationMs;
  const at = Math.min(t, end);
  const abs = D.startedAt + at;
  const idx = upto(times, abs);
  const full = upto(fulls, abs);
  let still = null;
  if (replayer && idx !== lastIdx && full >= 0) {
    replayer.pause(Math.max(0, abs - times[0]));
    await imagesSettled(full !== lastFull ? 4000 : 400);
  }
  if (full < 0 || !replayer || blank()) {
    const i = upto(D.stills.map(s => s.at), at + 1500);
    still = (D.stills[Math.max(0, i)] || {}).src || null;
  }
  lastIdx = idx; lastFull = full;
  if (still !== lastStill) { $('still').src = still || ''; $('still').style.display = still ? 'block' : 'none'; lastStill = still; }
  let cap = '', think = false;
  if (D.captions) {
    const c = D.track.captions.find(c => at >= c.from && at < c.to);
    if (c) cap = c.text;
    else if (at >= D.track.thinkingFrom && at < D.track.thinkingTo) { cap = 'Thinking…'; think = true; }
  }
  if (t > end) cap = '';
  $('cap').textContent = cap; $('cap').style.display = cap ? 'block' : 'none'; $('cap').classList.toggle('think', think);
  const clock = D.clock ? fmt(at) : '';
  $('clock').textContent = clock;
  const done = t > end && D.totalMs > end + ${TAIL_MS};
  $('done').style.display = done ? 'flex' : 'none';
  if (done) $('done').firstChild.textContent = 'Done in ' + fmt(end);
  return [idx, full, still ? still.length : 0, cap, clock, done].join('|');
};
</script>`;
}

// ------------------------------------------------------------------- CDP ---

function chromeBinary() {
  const env = process.env.BROWSERCTRL_CHROME || process.env.CHROME_BIN;
  const candidates = [env,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].filter(Boolean);
  return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

// A private headless Chrome on a free port and its own profile: never the user's browser.
async function launchRenderer({ proxy } = {}) {
  const bin = chromeBinary();
  if (!bin) throw new Error('Video export needs Chrome or Chromium (set BROWSERCTRL_CHROME to its binary).');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-video-'));
  const child = spawn(bin, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--mute-audio',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    ...(proxy ? [`--proxy-server=${proxy}`] : []),
    ...(process.platform === 'win32' ? ['--disable-gpu'] : []), 'about:blank'], { stdio: 'ignore', detached: process.platform !== 'win32' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  let port = null;
  for (let i = 0; i < 150 && !port; i++) {
    await sleep(100);
    try { port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]) || null; } catch {}
  }
  const close = () => {
    try { process.platform === 'win32' ? child.kill() : process.kill(-child.pid, 'SIGKILL'); } catch {}
    setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500).unref();
  };
  if (!port) { close(); throw new Error('The headless Chrome for video export did not start.'); }
  let pages = [];
  for (let i = 0; i < 50 && !pages.length; i++) {
    try { pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t => t.type === 'page'); } catch {}
    if (!pages.length) await sleep(100);
  }
  if (!pages.length) { close(); throw new Error('The headless Chrome for video export has no page.'); }
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('could not connect to the headless Chrome')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    d.error ? p.no(new Error(`${p.method}: ${d.error.message}`)) : p.ok(d.result);
  };
  const send = (method, params = {}) => new Promise((ok, no) => { const i = ++id; pending.set(i, { ok, no, method }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  // Replayed pages load their images from the live site; some sites refuse a headless user agent.
  try {
    const { userAgent } = await send('Browser.getVersion');
    await send('Network.setUserAgentOverride', { userAgent: userAgent.replace(/HeadlessChrome/g, 'Chrome') });
  } catch {}
  return { send, evaluate, close: () => { try { ws.close(); } catch {} close(); } };
}

// ---------------------------------------------------------------- ffmpeg ---

function needFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (r.error || r.status !== 0) throw new Error('Video export needs ffmpeg on PATH (macOS: brew install ffmpeg).');
}

function ffmpeg(args) {
  return new Promise((ok, no) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => code === 0 ? ok() : no(new Error(`ffmpeg failed: ${err.trim().slice(-600)}`)));
  });
}

function encoder(out, fps) {
  const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', d => { err += d; });
  const done = new Promise((ok, no) => p.on('close', code => code === 0 ? ok() : no(new Error(`ffmpeg failed: ${err.trim().slice(-600)}`))));
  const write = buf => new Promise((ok, no) => {
    if (p.stdin.write(buf)) return ok();
    p.stdin.once('drain', ok);
    p.stdin.once('error', no);
  });
  return { write, end: async () => { p.stdin.end(); await done; } };
}

const even = n => Math.max(2, Math.round(n / 2) * 2);

// Render one recording to an MP4 of exactly totalMs / speed seconds.
async function renderPanel(recording, out, { width, height, fps, speed, label, captions, clock, totalMs, onProgress, proxy, trace }) {
  const r = await launchRenderer({ proxy });
  const stats = { frames: 0, rendered: 0, ...(trace ? { trace: [] } : {}) };
  try {
    await r.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const file = path.join(os.tmpdir(), `browserctrl-video-${process.pid}-${Date.now()}.html`);
    fs.writeFileSync(file, pageHtml(recording, { width, height, label, captions, clock, totalMs }));
    await r.send('Page.enable');
    await r.send('Page.navigate', { url: 'file://' + file });
    for (let i = 0; i < 200; i++) { if (await r.evaluate('typeof window.__frame === "function"').catch(() => false)) break; await sleep(50); }
    await r.evaluate('window.__init()');
    const enc = encoder(out, fps);
    const frames = Math.max(1, Math.round((totalMs / speed) / 1000 * fps));
    let lastSig = null, lastBuf = null;
    for (let f = 0; f < frames; f++) {
      const t = (f / fps) * 1000 * speed;
      const sig = await r.evaluate(`window.__frame(${t})`);
      if (sig !== lastSig || !lastBuf) {
        const shot = await r.send('Page.captureScreenshot', { format: 'jpeg', quality: 82, clip: { x: 0, y: 0, width, height, scale: 1 } });
        lastBuf = Buffer.from(shot.data, 'base64');
        lastSig = sig;
        stats.rendered++;
      }
      await enc.write(lastBuf);
      stats.frames++;
      if (trace) stats.trace.push({ t: Math.round(t), caption: sig.split('|')[3], clock: sig.split('|')[4], done: sig.split('|')[5] === 'true' });
      if (onProgress && f % (fps * 10) === 0) onProgress(f, frames);
    }
    await enc.end();
    fs.rmSync(file, { force: true });
  } finally { r.close(); }
  return stats;
}

async function writeGif(mp4, gif, { speed = 4, fps = 12, width = 720, maxBytes = 8e6 } = {}) {
  let w = width, f = fps;
  for (let attempt = 0; attempt < 4; attempt++) {
    const vf = `setpts=PTS/${speed},fps=${f},scale=${w}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
    await ffmpeg(['-i', mp4, '-filter_complex', vf, '-loop', '0', gif]);
    if (fs.statSync(gif).size <= maxBytes) break;
    w = Math.round(w * 0.8); f = Math.max(6, f - 3);
  }
  return { gif, bytes: fs.statSync(gif).size, width: w, fps: f };
}

function probeSeconds(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Number(r.stdout.trim()) || null;
}

// One recording, or several side by side, to an MP4 (and optionally a GIF).
export async function renderVideo(dirs, { out, gif, gifSpeed = 4, fps = 12, width, speed = 1, captions = true, clock = true, labels = [], onProgress, proxy = process.env.BROWSERCTRL_VIDEO_PROXY, trace = false } = {}) {
  needFfmpeg();
  if (!out) throw new Error('--video needs an output file (out.mp4)');
  const recs = dirs.map(d => readRecording(d));
  const sideBySide = recs.length > 1;
  const panelW = even(sideBySide ? (width || 1920) / recs.length : (width || 1280));
  const panelH = even(panelW * 9 / 16 + HEADER);
  const longest = Math.max(...recs.map(r => r.durationMs));
  const totalMs = longest + TAIL_MS + (sideBySide ? 1000 : 0);
  const panels = [];
  for (let i = 0; i < recs.length; i++) {
    const file = sideBySide ? path.join(os.tmpdir(), `browserctrl-panel-${process.pid}-${i}.mp4`) : path.resolve(out);
    const label = labels[i] ?? (sideBySide ? recs[i].meta.label : (labels[0] ?? recs[i].meta.label));
    const stats = await renderPanel(recs[i], file, { width: panelW, height: panelH, fps, speed, label, captions, clock, proxy, trace,
      totalMs: sideBySide ? totalMs : recs[i].durationMs + TAIL_MS, onProgress: onProgress && ((f, n) => onProgress(i, f, n)) });
    panels.push({ file, stats, durationMs: recs[i].durationMs, label });
  }
  if (sideBySide) {
    const inputs = panels.flatMap(p => ['-i', p.file]);
    const stack = panels.map((_, i) => `[${i}:v]`).join('') + `hstack=inputs=${panels.length}[v]`;
    await ffmpeg([...inputs, '-filter_complex', stack, '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.resolve(out)]);
    for (const p of panels) fs.rmSync(p.file, { force: true });
  }
  const result = {
    video: path.resolve(out), bytes: fs.statSync(out).size, seconds: probeSeconds(out), fps, speed,
    size: `${panelW * recs.length}x${panelH}`,
    recordings: panels.map(p => ({ label: p.label, seconds: Math.round(p.durationMs / 100) / 10, frames: p.stats.frames, rendered: p.stats.rendered, ...(p.stats.trace ? { trace: p.stats.trace } : {}) })),
  };
  if (gif) result.gif = await writeGif(path.resolve(out), path.resolve(gif), { speed: gifSpeed, width: sideBySide ? 960 : 720 });
  return result;
}

// Watch-later run recordings for one tab, small enough to keep every run.
//
//   rrweb.ndjson.br   the page as rrweb DOM events (mutations, not pixels), one per line
//   steps.jsonl       one row per browserctrl action: time, url, action text, status, still
//   trajectory/       one small JPEG per action (NNNN.jpg), so a judge or a person sees
//                     what the page looked like even where DOM replay cannot (canvas,
//                     cross-origin iframes)
//   meta.json         tab, start and end
//
// The page script streams rrweb events through the daemon's CDP binding, so a
// recording outlives the CLI call that started it and survives navigations. The
// layout of steps.jsonl + trajectory/ maps one-to-one onto Online-Mind2Web's v2
// result format (see bench/om2w/export.mjs).
import fs from 'node:fs';
import path from 'node:path';
import * as caps from './caps.mjs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { setting, number, dataPath } from './config.mjs';
import { STATE_DIR } from './state.mjs';
import { settle, evaluateInWorld } from './ops.mjs';
import * as world from './world.mjs';
import { panelTimeline } from './recording-timeline.mjs';

const VENDOR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'rrweb');
export const STATE_FILE = () => setting('REC_STATE') || path.join(STATE_DIR, 'rec-tabs.json');
export const ROOT = () => setting('REC_DIR') || dataPath('runs');
const MAX_WIDTH = 1280; // still width in image pixels
const QUALITY = 50;

// ------------------------------------------------------------------ state ---
// targetId -> { dir, port, startedAt, scriptId, n, lastUrl, lastSig }

let cache = { mtimeMs: -1, rows: {} };
export function all() {
  const file = STATE_FILE();
  let st;
  try { st = fs.statSync(file); } catch { return {}; }
  if (st.mtimeMs !== cache.mtimeMs) {
    try { cache = { mtimeMs: st.mtimeMs, rows: JSON.parse(fs.readFileSync(file, 'utf8')) || {} }; }
    catch { return {}; }
  }
  return cache.rows;
}
export const get = targetId => all()[targetId] || null;

function save(rows) {
  const file = STATE_FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 1));
  fs.renameSync(tmp, file);
  cache = { mtimeMs: -1, rows: {} };
}
export function update(targetId, patch) {
  const rows = { ...all() };
  if (patch === null) delete rows[targetId];
  else rows[targetId] = { ...rows[targetId], ...patch };
  save(rows);
  return rows[targetId] || null;
}

// ------------------------------------------------------------ page script ---

// The rrweb options are where the size goes. Automation moves the mouse rarely,
// so mouse moves are dropped; scroll and input are sampled; stylesheets are
// inlined (an offline replay has no cookies to fetch them with), images and
// fonts are not; slimDOM drops scripts, comments and head noise.
const RR_OPTIONS = `{
  sampling: { mousemove: false, mouseInteraction: { MouseUp: false, MouseDown: false, Click: true, DblClick: true, ContextMenu: false, Focus: false, Blur: false, TouchStart: false, TouchEnd: false }, scroll: 250, media: 800, input: 'last' },
  slimDOMOptions: 'all', inlineStylesheet: true, inlineImages: false, recordCanvas: false, collectFonts: false,
  recordCrossOriginIframes: false, maskInputOptions: { password: true }
}`;

let scriptCache = null;
export function pageScript() {
  if (scriptCache) return scriptCache;
  const umd = fs.readFileSync(path.join(VENDOR, 'record.umd.min.js'), 'utf8');
  // The UMD build would register with a page's AMD loader or CommonJS shim if it
  // saw one, so it runs with those names shadowed and its global on a private object.
  scriptCache = `(function(){
  if (window.top !== window || window.__bcRec) return; // same-origin frames are recorded by the top frame
  function start(send){
    var holder = {};
    (function(define, exports, module){
${umd}
    }).call(holder, undefined, undefined, undefined);
    var rr = holder.rrwebRecord;
    if (!rr || !rr.record) return;
    var buf = [], sent = 0;
    function flush(end){
      if (buf.length || end) { var rows = buf; buf = []; sent += rows.length;
        try { send(JSON.stringify({ kind: 'rr', events: rows, end: !!end })); } catch (e) {} }
      return sent;
    }
    var stopRec = rr.record(Object.assign({ emit: function(e){ buf.push(e); if (e.type === 2 || buf.length >= 100) flush(); } }, ${RR_OPTIONS}));
    // Timers are throttled in background tabs; the CLI also flushes before every still.
    var timer = setInterval(function(){ flush(); }, 2000);
    function onChange(){ flush(); }
    addEventListener('pagehide', onChange, true);
    document.addEventListener('visibilitychange', onChange, true);
    Object.defineProperty(window, '__bcRec', { configurable: true, value: {
      flush: function(){ return flush(); },
      stop: function(){ try { stopRec && stopRec(); } catch (e) {} clearInterval(timer); removeEventListener('pagehide', onChange, true); document.removeEventListener('visibilitychange', onChange, true); delete window.__bcRec; return flush(true); }
    } });
  }
  var send = window.__cdpSend, tries = 0;
  if (typeof send === 'function') return start(send.bind(window));
  var wait = setInterval(function(){
    if (typeof window.__cdpSend === 'function') { clearInterval(wait); start(window.__cdpSend.bind(window)); }
    else if (++tries > 50) clearInterval(wait);
  }, 100);
})();`;
  return scriptCache;
}

// ----------------------------------------------------- daemon side (sink) ---

// Called by the daemon for every `rr` envelope. The page names no path: the tab
// identity comes from the CDP session, so a page can only add to its own recording.
export function appendFromPage(targetId, envelope) {
  const rec = get(targetId);
  if (!rec) return false;
  const rows = Array.isArray(envelope.events) ? envelope.events : [];
  // One recording stops growing at 300 MB of raw events (a tab left recording on a page that
  // never stops changing); its steps and stills carry on, and meta.json says it was cut.
  const raw = path.join(rec.dir, 'rrweb.ndjson');
  let size = 0; try { size = fs.statSync(raw).size; } catch {}
  if (size > 300 * 1024 * 1024) {
    if (!rec.truncated) { update(targetId, { truncated: true }); try { const m = JSON.parse(fs.readFileSync(path.join(rec.dir, 'meta.json'), 'utf8')); fs.writeFileSync(path.join(rec.dir, 'meta.json'), JSON.stringify({ ...m, truncatedAt: Date.now() }, null, 1)); } catch {} }
  } else if (rows.length) fs.appendFileSync(raw, rows.map(r => JSON.stringify(rec.rootDir ? { ...r, tab: targetId, path: rec.path, url: rec.url } : r)).join('\n') + '\n');
  if (envelope.end) fs.writeFileSync(path.join(rec.dir, 'rrweb.end'), String(Date.now()));
  return true;
}

// The daemon lost its session (restart, reconnect): put the script back so the
// recording keeps going across the next navigation.
export async function reinstrument(targetId, send, key = targetId) {
  const rec = get(targetId);
  if (!rec) return;
  const r = await world.addScript(send, pageScript()).catch(() => null);
  if (r?.identifier) update(targetId, { scriptId: r.identifier });
  await world.evaluateInWorld(send, key, pageScript()).catch(() => {});
}

// ---------------------------------------------------------- CLI side (ops) ---

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export async function start(conn, targetId, { out, label, rootDir, trackPath, url } = {}) {
  if (get(targetId)) throw new Error(`Tab ${targetId.slice(0, 8)} is already recording into ${get(targetId).dir}. Stop it first: browserctrl rec stop ${targetId.slice(0, 8)}`);
  const dir = path.resolve(out || path.join(ROOT(), `${stamp()}-${targetId.slice(0, 8)}`));
  // Recordings in the default folder are capped (1 GB): the oldest go first. A folder the
  // caller named with --out is theirs to manage.
  if (!out) caps.prune(ROOT(), caps.capBytes('rec'), { keep: [path.basename(dir)] });
  fs.mkdirSync(path.join(dir, 'trajectory'), { recursive: true });
  for (const f of ['rrweb.ndjson', 'rrweb.ndjson.br', 'rrweb.end', 'steps.jsonl']) fs.rmSync(path.join(dir, f), { force: true });
  const startedAt = Date.now();
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ targetId, tab: targetId, label: label || null, startedAt, rrweb: '2.1.7' }, null, 1));
  update(targetId, { dir, port: conn.port, startedAt, n: 0, lastUrl: null, ...(rootDir ? { rootDir, path: trackPath, url } : {}) });
  try {
    const r = await world.addScript((m, p, t) => conn.send(targetId, m, p, t), pageScript(), 10000);
    update(targetId, { scriptId: r?.identifier || null });
    await evaluateInWorld(conn, targetId, pageScript(), { timeoutMs: 10000 });
  } catch (e) {
    await evaluateInWorld(conn, targetId, 'window.__bcRec?.stop()').catch(() => {});
    const scriptId = get(targetId)?.scriptId;
    if (scriptId) await conn.send(targetId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }, 5000).catch(() => {});
    update(targetId, null);
    throw e;
  }
  await still(conn, targetId, 'start recording', { status: null });
  return { recording: dir, tab: targetId.slice(0, 8) };
}

export async function startChild(conn, sourceTab, targetId, { path: trackPath, url, label, title }) {
  const source = get(sourceTab);
  if (!source) return;
  const rootDir = source.rootDir || source.dir;
  const dir = `tracks/${targetId}`;
  const metaFile = path.join(rootDir, 'meta.json');
  const meta = readJson(metaFile);
  (meta.tracks ||= []).push({ tab: targetId, path: trackPath, url, label, dir });
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 1));
  fs.appendFileSync(path.join(rootDir, 'steps.jsonl'), JSON.stringify({ at: Date.now(), event: 'tab-open', tab: targetId, sourceTab, path: trackPath, url, label, action: `opened ${label.split(' of ')[0]} in a background tab: ${title || url}` }) + '\n');
  await start(conn, targetId, { out: path.join(rootDir, dir), rootDir, trackPath, url, label });
}

export async function stopChild(conn, targetId, sourceTab, { closed = true } = {}) {
  const state = get(targetId);
  if (!state?.rootDir) return;
  await stop(conn, targetId);
  const meta = readJson(path.join(state.rootDir, 'meta.json'));
  const track = meta.tracks.find(t => t.tab === targetId);
  fs.appendFileSync(path.join(state.rootDir, 'steps.jsonl'), JSON.stringify({ at: Date.now(), event: closed ? 'tab-close' : 'track-stop', tab: targetId, sourceTab, path: state.path, url: state.url, label: track.label, action: closed ? `closed ${track.label.split(' of ')[0]}` : `stopped recording ${track.label.split(' of ')[0]}` }) + '\n');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// What a still shows, cheaply: the address, the title and the visible text (length and a
// hash), so a read after an in-page change ("Added to your bag") shoots though the URL
// is the same, and a read of an unchanged page does not shoot twice.
const PAGE_EXPR = `(function () {
  var t = document.body ? (document.body.innerText || '') : '', h = 0;
  for (var i = 0; i < t.length && i < 40000; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
  return [location.href, document.title, document.readyState, innerWidth, devicePixelRatio,
    window.__bcRec ? window.__bcRec.flush() : -1, location.href + '|' + document.title + '|' + t.length + '|' + h];
})()`;
// The judge grades the stills, so a still waits (up to this long) for the same loading
// signals read waits for: skeletons, spinners, aria-busy, not just readyState.
const STILL_SETTLE_MS = number('STILL_SETTLE_MS', 4000);

// One still per action. `ifChanged` (reads) only shoots when the page looks different
// from the last still, so the final state of a navigation or an in-page change gets
// captured once.
export async function still(conn, targetId, action, { status = 'SUCCESS', ifChanged = false, extra = null } = {}) {
  const rec = get(targetId);
  if (!rec) return null;
  const root = rec.rootDir || rec.dir;
  extra = { ...(rec.rootDir ? { tab: targetId, path: rec.path } : {}), ...(extra || {}) };
  // BROWSERCTRL_REC_STILLS=off: log the step but leave the screenshot to whoever records the
  // tab from outside (a harness reading it on a timer), so the acting command doesn't wait on
  // a capture. The judge export reuses the latest still for such steps.
  if (setting('REC_STILLS') === 'off') {
    const row = { step: null, at: Date.now(), action: String(action).slice(0, 300), status, ...(extra || {}) };
    fs.appendFileSync(path.join(root, 'steps.jsonl'), JSON.stringify(row) + '\n');
    return row;
  }
  try {
    const page = async () => (await evaluateInWorld(conn, targetId, PAGE_EXPR)) || [];
    // Placeholders count as decoration only after holding still longer than read allows
    // for: a still is graded, and results often replace skeletons after 1-2 s.
    const wait = await settle(conn, targetId, { timeoutMs: STILL_SETTLE_MS, stableMs: 2500, busyStableMs: STILL_SETTLE_MS });
    const [url, title, , width, dpr, , sig] = await page();
    if (ifChanged && sig && sig === rec.lastSig) return null;
    const params = { format: 'jpeg', quality: QUALITY, optimizeForSpeed: true };
    const scale = width && dpr ? Math.min(1, MAX_WIDTH / (width * dpr)) : 1;
    if (scale < 1) {
      const m = await conn.send(targetId, 'Page.getLayoutMetrics', {}, 5000);
      const v = m.cssVisualViewport || m.visualViewport;
      params.clip = { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale };
    }
    // Windows CI runners left optimizeForSpeed captures hanging until the timeout after
    // the first one; one plain retry costs little when the fast path stalls.
    const shot = await conn.send(targetId, 'Page.captureScreenshot', params, 8000)
      .catch(() => conn.send(targetId, 'Page.captureScreenshot', { ...params, optimizeForSpeed: false }, 8000));
    const n = (get(targetId)?.n ?? 0);
    const name = `${rec.rootDir ? targetId + '/' : ''}${String(n).padStart(4, '0')}.jpg`;
    fs.mkdirSync(path.dirname(path.join(root, 'trajectory', name)), { recursive: true });
    fs.writeFileSync(path.join(root, 'trajectory', name), Buffer.from(shot.data, 'base64'));
    const row = { step: n, at: Date.now(), url, title, action: String(action).slice(0, 300), status, screenshot: name,
      wait: { ms: wait.waitedMs, cleared: wait.cleared, ...(wait.why ? { why: wait.why } : {}) }, ...(extra || {}) };
    fs.appendFileSync(path.join(root, 'steps.jsonl'), JSON.stringify(row) + '\n');
    update(targetId, { n: n + 1, lastUrl: url, lastSig: sig });
    return row;
  } catch (e) {
    // A recording must never break the run it records.
    fs.appendFileSync(path.join(root, 'steps.jsonl'), JSON.stringify({ step: null, at: Date.now(), action: String(action).slice(0, 300), status, error: e.message, ...(extra || {}) }) + '\n');
    return null;
  }
}

export async function stop(conn, targetId) {
  const rec = get(targetId);
  if (!rec) throw new Error(`Tab ${targetId.slice(0, 8)} is not recording.`);
  if (!rec.rootDir) for (const [child, state] of Object.entries(all())) {
    if (state.rootDir === rec.dir) await stop(conn, child);
  }
  try {
    await still(conn, targetId, 'stop recording', { status: null });
  } finally {
    await evaluateInWorld(conn, targetId, 'window.__bcRec ? window.__bcRec.stop() : -1').catch(() => {});
    if (rec.scriptId) await conn.send(targetId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: rec.scriptId }, 5000).catch(() => {});
    // The last batch travels page -> daemon -> disk asynchronously; the end marker says it landed.
    for (let t = 0; t < 50 && !fs.existsSync(path.join(rec.dir, 'rrweb.end')); t++) await sleep(100);
    update(targetId, null);
  }
  await sleep(50);
  return finish(rec.dir);
}

// Brotli with a 16 MB window: every page load is a full DOM snapshot, and
// snapshots of the same site repeat each other far beyond gzip's 32 KB window
// (a 13-step PyPI run: 603 KB gzip, 170 KB this way, in about 0.2 s).
const BROTLI = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_LGWIN]: 24 } };

// Compress the event stream and record the end. Also used on a recording whose
// tab went away before it was stopped.
export function finish(dir) {
  const raw = path.join(dir, 'rrweb.ndjson');
  const br = `${raw}.br`;
  if (fs.existsSync(raw)) {
    const prior = fs.existsSync(br) ? zlib.brotliDecompressSync(fs.readFileSync(br)) : Buffer.alloc(0);
    const all = Buffer.concat([prior, fs.readFileSync(raw)]);
    fs.writeFileSync(br, zlib.brotliCompressSync(all, { params: { ...BROTLI.params, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: all.length } }));
    fs.rmSync(raw);
  }
  fs.rmSync(path.join(dir, 'rrweb.end'), { force: true });
  const meta = readJson(path.join(dir, 'meta.json')) || {};
  meta.endedAt = Date.now();
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 1));
  return { recording: dir, ...sizes(dir) };
}

export function sizes(dir) {
  const size = f => { try { return fs.statSync(f).size; } catch { return 0; } };
  const shots = fs.existsSync(path.join(dir, 'trajectory')) ? fs.readdirSync(path.join(dir, 'trajectory'), { recursive: true }).filter(f => fs.statSync(path.join(dir, 'trajectory', f)).isFile()) : [];
  const stills = shots.reduce((n, f) => n + size(path.join(dir, 'trajectory', f)), 0);
  const tracks = readJson(path.join(dir, 'meta.json'))?.tracks || [];
  const rrweb = (size(path.join(dir, 'rrweb.ndjson.br')) || size(path.join(dir, 'rrweb.ndjson'))) + tracks.reduce((n, t) => n + (size(path.join(dir, t.dir, 'rrweb.ndjson.br')) || size(path.join(dir, t.dir, 'rrweb.ndjson'))), 0);
  const steps = readJsonl(path.join(dir, 'steps.jsonl')).filter(s => s.screenshot).length;
  return { steps, rrweb_bytes: rrweb, stills_bytes: stills, stills: shots.length, total_bytes: rrweb + stills + size(path.join(dir, 'steps.jsonl')) + size(path.join(dir, 'meta.json')) };
}

// ------------------------------------------------------------------ files ---

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
export function readJsonl(f) {
  try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
export function readEvents(dir) {
  const br = path.join(dir, 'rrweb.ndjson.br');
  const raw = path.join(dir, 'rrweb.ndjson');
  const parts = [];
  if (fs.existsSync(br)) parts.push(zlib.brotliDecompressSync(fs.readFileSync(br)).toString('utf8'));
  if (fs.existsSync(raw)) parts.push(fs.readFileSync(raw, 'utf8')); // a recording still running, or never stopped
  return parts.join('').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// --------------------------------------------------------------- replay ---

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// One self-contained HTML: player, events (gzipped, base64: browsers decompress gzip
// natively) and stills inline. Built on demand so the recording itself stays small.
export function replayHtml(dir) {
  const events = readEvents(dir);
  const allSteps = readJsonl(path.join(dir, 'steps.jsonl'));
  const meta = readJson(path.join(dir, 'meta.json')) || {};
  const sourceTab = meta.tab ?? meta.targetId;
  const tracks = (meta.tracks || []).map(t => ({ ...t, events: readEvents(path.join(dir, t.dir)) }));
  const steps = tracks.length ? allSteps : allSteps.filter(s => s.screenshot);
  const packed = zlib.gzipSync(Buffer.from(JSON.stringify(events)), { level: 9 }).toString('base64');
  const stills = Object.fromEntries(steps.filter(s => s.screenshot).map(s => {
    try { return [s.screenshot, fs.readFileSync(path.join(dir, 'trajectory', s.screenshot)).toString('base64')]; }
    catch { return [s.screenshot, null]; }
  }));
  const player = fs.readFileSync(path.join(VENDOR, 'rrweb-player.umd.min.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
  const css = fs.readFileSync(path.join(VENDOR, 'rrweb-player.min.css'), 'utf8');
  const data = JSON.stringify({ steps, stills, tracks, sourceTab, switches: panelTimeline(allSteps, sourceTab), end: meta.endedAt ?? allSteps.at(-1)?.at ?? events.at(-1)?.timestamp, start: events[0]?.timestamp ?? meta.startedAt, title: meta.label || path.basename(dir) }).replace(/</g, '\\u003c');
  return `<!doctype html><meta charset=utf-8><title>${esc(meta.label || path.basename(dir))} · replay</title>
<style>${css}
body{margin:0;font:13px/1.4 -apple-system,system-ui,sans-serif;display:flex;height:100vh;background:#f4f3ef;color:#222}
#side{width:320px;overflow:auto;border-right:1px solid #ddd;background:#fff}
#side h1{font-size:14px;margin:12px}
.step{padding:7px 12px;border-top:1px solid #eee;cursor:pointer}
.step:hover,.step.on{background:#eef4ff}
.step .t{color:#888;font-size:11px}.step .u{color:#777;font-size:11px;word-break:break-all}
.FAILED{color:#b00}.SKIPPED{color:#a70}
#main{flex:1;display:flex;flex-direction:column;align-items:center;overflow:auto;padding:12px;gap:10px}
#tabs button{padding:4px 10px}
#still{max-width:100%;border:1px solid #ccc;display:none}
#note{color:#777}
</style>
<div id=side><h1>${esc(meta.label || path.basename(dir))}</h1><div id=list></div></div>
<div id=main><div id=tabs><button id=bdom>DOM replay</button> <button id=bstill>Stills</button> <span id=note></span></div><div id=timeline hidden><button id=play>Play</button> <input id=seek type=range min=0 step=1 value=0> <span id=time></span></div><div id=player></div><img id=still></div>
<script>${player}</script>
<script>
const D = ${data};
const EV = ${JSON.stringify(packed)};
const $ = id => document.getElementById(id);
let player = null, mode = 'dom', cur = 0;
let seekPanel = null, playing = false, position = 0, lastTick = 0;
const fmt = ms => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
$('list').innerHTML = D.steps.map((s, i) => '<div class="step" data-i="' + i + '"><span class=t>' + fmt(s.at - D.start) + '</span> <span class="' + (s.status || '') + '">' + esc(s.action) + (s.status && s.status !== 'SUCCESS' ? ' · ' + s.status : '') + '</span><div class=u>' + esc(s.url || '') + '</div></div>').join('');
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function show(i) {
  cur = i; const s = D.steps[i]; if (!s) return;
  document.querySelectorAll('.step').forEach(el => el.classList.toggle('on', Number(el.dataset.i) === i));
  if (seekPanel) { playing = false; $('play').textContent = 'Play'; seekPanel(Math.max(0, s.at - D.start)); return; }
  if (!seekPanel) { const src = D.stills[s.screenshot]; $('still').src = src ? 'data:image/jpeg;base64,' + src : ''; }
  if (player && !seekPanel) { player.goto(Math.max(0, s.at - D.start)); player.pause(); }
}
function setMode(m) { mode = m; $('player').style.display = m === 'dom' ? '' : 'none'; $('still').style.display = m === 'still' ? 'block' : 'none'; }
$('list').onclick = e => { const el = e.target.closest('.step'); if (el) show(Number(el.dataset.i)); };
$('bdom').onclick = () => setMode('dom'); $('bstill').onclick = () => setMode('still');
addEventListener('keydown', e => { if (e.key === 'ArrowDown' || e.key === 'j') show(Math.min(D.steps.length - 1, cur + 1)); if (e.key === 'ArrowUp' || e.key === 'k') show(Math.max(0, cur - 1)); });
(async () => {
  const bytes = Uint8Array.from(atob(EV), c => c.charCodeAt(0));
  const events = JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
  const full = events.some(e => e.type === 2);
  if (!full) { $('note').textContent = 'no DOM snapshot was captured; showing stills'; setMode('still'); }
  else if (!D.tracks.length) {
    const Player = rrwebPlayer.default || rrwebPlayer.Player || rrwebPlayer;
    player = new Player({ target: $('player'), props: { events, width: Math.min(1100, innerWidth - 380), height: Math.min(700, innerHeight - 140), autoPlay: false, skipInactive: true, showController: true } });
    setMode('dom');
  }
  if (D.tracks.length) {
    const panels = [{ tab: D.sourceTab, events }, ...D.tracks];
    const players = new Map();
    const duration = Math.max(0, D.end - D.start);
    $('timeline').hidden = false;
    $('seek').max = duration;
    seekPanel = ms => {
      position = Math.min(duration, Math.max(0, ms));
      const absolute = D.start + position;
      const selected = D.switches.findLast(s => s.at <= absolute) || D.switches[0];
      const panel = panels.find(p => p.tab === selected.tab) || panels[0];
      for (const p of players.values()) p.element.style.display = 'none';
      let saved = players.get(panel.tab);
      if (!saved) {
        const element = document.createElement('div'); $('player').appendChild(element);
        let replay = null;
        if (panel.events.some(e => e.type === 2)) {
          const Player = rrwebPlayer.default || rrwebPlayer.Player || rrwebPlayer;
          replay = new Player({ target: element, props: { events: panel.events, width: Math.min(1100, innerWidth - 380), height: Math.min(700, innerHeight - 180), autoPlay: false, skipInactive: false, showController: false } });
        }
        saved = { element, replay }; players.set(panel.tab, saved);
      }
      saved.element.style.display = '';
      if (saved.replay) { saved.replay.goto(Math.max(0, absolute - panel.events[0].timestamp)); saved.replay.pause(); }
      let host = ''; try { host = new URL(selected.url).hostname.replace(/^www\\./, ''); } catch {}
      $('note').textContent = panel.tab === D.sourceTab ? '' : [selected.label, host].filter(Boolean).join(' · ');
      const rows = D.steps.filter(s => (s.tab ?? D.sourceTab) === panel.tab && s.screenshot);
      const still = rows.findLast(s => s.at <= absolute) || rows[0];
      const src = still && D.stills[still.screenshot];
      $('still').src = src ? 'data:image/jpeg;base64,' + src : '';
      $('player').style.display = mode === 'dom' && saved.replay ? '' : 'none';
      $('still').style.display = mode === 'still' || !saved.replay ? 'block' : 'none';
      $('seek').value = position; $('time').textContent = fmt(position);
    };
    $('seek').oninput = () => seekPanel(Number($('seek').value));
    $('play').onclick = () => { playing = !playing; if (playing && position >= duration) seekPanel(0); lastTick = performance.now(); $('play').textContent = playing ? 'Pause' : 'Play'; };
    function tick(now) {
      if (playing) { seekPanel(position + now - lastTick); if (position >= duration) { playing = false; $('play').textContent = 'Play'; } }
      lastTick = now; requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    seekPanel(0);
  }
  window.__replay = { events: events.length, steps: D.steps.length, dom: full };
  if (D.steps.length) show(0);
})();
</script>`;
}

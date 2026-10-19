// Recording a play: what happened, in three layers on one clock.
//
//   events.jsonl   browser semantics (click, input, navigate...) with element
//                  identity. This is the layer that is actually actionable.
//   windows.jsonl  frontmost app and window title, sampled once a second, so a
//                  moment spent outside the browser is still legible.
//   screen.mp4     optional ffmpeg capture of the screen.
//
// Everything timestamps in epoch milliseconds, which is what lets a mark made
// at 0:42 of the video resolve to the click that produced it.
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync, execFile } from 'child_process';
import { connect } from './daemon.mjs';
import * as ops from './ops.mjs';
import { setting, number } from './config.mjs';
import { ROOT, readActive, dir, metaPath, eventsPath, windowsPath, marksPath, videoPath, clockPath, readJsonl, readMeta, appendEvents as storeAppend, writeActive, clearActive, forgetEventKeys } from './recstore.mjs';

const active = new Map(); // id -> { ffmpeg, sampler, port, scriptIds }

export { videoPath };

// The page-side recorder. Same identity vocabulary as the annotation overlay,
// so an event and an annotation describe an element the same way.
export function recorderScript() {
  return `(function(){
  if (window.__cdpRecorder) return;
  var ID = window.__cdpRecording;
  if (!ID) return;
  var queue = [];
  function testid(el){var a=['data-testid','data-test-id','data-test','data-cy','data-qa'];for(var i=0;i<a.length;i++){var v=el.getAttribute&&el.getAttribute(a[i]);if(v)return v;}return null;}
  function roleOf(el){var r=el.getAttribute&&el.getAttribute('role');if(r)return r;var t=el.tagName.toLowerCase();
    if(t==='a')return 'link';if(t==='button'||t==='summary')return 'button';if(t==='select')return 'select';
    if(t==='textarea')return 'textbox';if(t==='input'){var ty=(el.getAttribute('type')||'text').toLowerCase();
    return ['checkbox','radio','file','submit','button'].indexOf(ty)===-1?'textbox':ty;}return t;}
  function nameOf(el){var t=(el.getAttribute&&el.getAttribute('aria-label'))||'';if(t.trim())return t.trim();
    var own=(el.innerText||el.textContent||'').trim().replace(/\\s+/g,' ');if(own)return own.slice(0,100);
    return ((el.getAttribute&&(el.getAttribute('placeholder')||el.getAttribute('title')||el.getAttribute('alt')))||'').slice(0,100);}
  function selectorFor(el){var tid=testid(el);if(tid)return '[data-testid="'+tid+'"]';
    if(el.id)return '#'+el.id;var p=[],n=el,d=0;
    while(n&&n.nodeType===1&&d++<5){var part=n.tagName.toLowerCase();
      if(n.parentElement){var sibs=Array.prototype.filter.call(n.parentElement.children,function(c){return c.tagName===n.tagName;});
        if(sibs.length>1)part+=':nth-of-type('+(sibs.indexOf(n)+1)+')';}
      p.unshift(part);n=n.parentElement;}
    return p.join(' > ');}
  function push(type, el, extra){
    var e = { t: Date.now(), type: type, url: location.href, title: document.title };
    if (el && el.tagName) e.element = { role: roleOf(el), name: nameOf(el), testid: testid(el), selector: selectorFor(el) };
    if (extra) for (var k in extra) e[k] = extra[k];
    queue.push(e);
    if (queue.length > 20) flush();
  }
  /* Events leave the page over the daemon's CDP binding, or through the
   * extension. There is deliberately no fetch to the bridge: it would need the
   * bridge token, and this script runs in the page's own world where the page's
   * scripts could read it. Without a binding the events wait in the queue. */
  function flush(){
    if (!queue.length) return;
    var batch = queue.splice(0, queue.length);
    var envelope = { kind: 'events', id: ID, rows: batch };
    if (typeof window.__cdpSend === 'function') {
      try { window.__cdpSend(JSON.stringify(envelope)); return; } catch (e) { /* fall through */ }
    }
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      try { chrome.runtime.sendMessage(envelope); return; } catch (e) { /* fall through */ }
    }
    queue = batch.concat(queue).slice(-500);
  }
  document.addEventListener('click', function(e){ push('click', e.target); }, true);
  document.addEventListener('change', function(e){
    var el = e.target, v = el.type === 'password' ? '(redacted)' : String(el.value || '').slice(0, 80);
    push('change', el, { value: v });
  }, true);
  document.addEventListener('submit', function(e){ push('submit', e.target); }, true);
  document.addEventListener('keydown', function(e){
    if (['Enter','Escape','Tab'].indexOf(e.key) !== -1 || e.metaKey || e.ctrlKey) push('key', e.target, { key: e.key });
  }, true);
  window.addEventListener('beforeunload', function(){ push('navigate-away', null); flush(); });
  push('page', null, { readyState: document.readyState });
  setInterval(flush, 1000);
  window.__cdpRecorder = { flush: flush, push: push };
})();`;
}

// What actually gets injected. Injection has to be idempotent: a tab now
// receives this from the daemon at creation AND from the start-of-recording
// pass, and an unconditional `delete window.__cdpRecorder` made the second
// injection attach a second set of listeners, so every click was recorded
// twice. A recorder from an *earlier* recording is still torn down, because it
// would otherwise keep emitting under the old id.
export function injectionScript(id) {
  return (
    `(function(){var id=${JSON.stringify(id)};` +
    'if(window.__cdpRecorder&&window.__cdpRecording===id)return;' +
    'try{delete window.__cdpRecorder;}catch(e){}' +
    'window.__cdpRecording=id;' +
    `${recorderScript()}})();`
  );
}

// ------------------------------------------------------------------ prewarm --
//
// Opening a screen capture device costs ~1.7s, and that is 1.7s of the play
// that never makes it to film. Nothing can make an on-demand ffmpeg instant, so
// this is the opt-in alternative: warm the capture while you are still setting
// up, and `record start` adopts the running one instead of spawning its own.
// Deliberately not automatic, because an armed capture writes video
// continuously whether or not you ever record.

const PREWARM = '_prewarm';
let prewarmHandles = null;

function prewarmAlive() {
  return Boolean(
    prewarmHandles?.ffmpeg &&
    !prewarmHandles.ffmpegError &&
    prewarmHandles.ffmpeg.exitCode === null &&
    !prewarmHandles.ffmpeg.killed,
  );
}

// True while a recording is running (here or started by another process) or
// capture is pre-warmed: the bridge must not shut down under it.
export const isBusy = () => active.size > 0 || prewarmAlive() || Boolean(readActive());

export function arm({ port }, { startCapture = startVideo } = {}) {
  if (prewarmAlive()) return prewarmStatus();
  fs.rmSync(dir(PREWARM), { recursive: true, force: true });
  fs.mkdirSync(dir(PREWARM), { recursive: true });
  const meta = { id: PREWARM, port, startedAt: Date.now(), video: true };
  prewarmHandles = { port, scriptIds: [], clockId: PREWARM, meta };
  try {
    startCapture(PREWARM, meta, prewarmHandles);
  } catch (error) {
    prewarmHandles = null;
    fs.rmSync(dir(PREWARM), { recursive: true, force: true });
    throw error;
  }
  return prewarmStatus();
}

export function disarm() {
  if (!prewarmAlive()) {
    prewarmHandles = null;
    return { armed: false };
  }
  try {
    prewarmHandles.ffmpeg.kill('SIGINT');
  } catch {
    /* already gone */
  }
  prewarmHandles = null;
  fs.rmSync(dir(PREWARM), { recursive: true, force: true });
  return { armed: false };
}

export function prewarmStatus() {
  if (!prewarmAlive()) return { armed: false };
  const samples = readJsonl(clockPath(PREWARM));
  return {
    armed: true,
    port: prewarmHandles.port,
    warmingFor: Math.round((Date.now() - prewarmHandles.meta.startedAt) / 1000),
    capturing: samples.length > 0,
  };
}

// Take over the armed capture for this recording: its clock samples move to the
// new id, later samples are written there, and stop() moves the file across.
function adoptPrewarm(id, meta, handles, port) {
  if (!prewarmAlive() || prewarmHandles.port !== port) return false;
  const samples = readJsonl(clockPath(PREWARM));
  if (!samples.length) return false; // still opening the device; not warm yet
  fs.copyFileSync(clockPath(PREWARM), clockPath(id));
  handles.ffmpeg = prewarmHandles.ffmpeg;
  handles.ffmpegArgs = prewarmHandles.ffmpegArgs;
  handles.adoptedVideo = videoPath(PREWARM);
  prewarmHandles.clockId = id;
  meta.videoStartedAt = samples[0].w - samples[0].v * 1000;
  meta.videoStartedAtCalibrated = true;
  meta.videoPrewarmed = true;
  meta.videoArgs = prewarmHandles.ffmpegArgs;
  prewarmHandles = null; // it belongs to this recording now
  return true;
}

// ---------------------------------------------------------------- lifecycle --

export async function start({ port, video = false, apps = true, label = null }) {
  const id = `rec_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  fs.mkdirSync(dir(id), { recursive: true });
  const startedAt = Date.now();
  const meta = { id, label, port, startedAt, video, apps, stoppedAt: null };
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));

  // Video first, before any CDP work. Instrumenting twenty tabs takes seconds,
  // and on a browser with suspended tabs it took 28 of them, so a capture
  // started afterwards simply missed the opening of the play.
  const handles = { port, scriptIds: [], clockId: id };
  try {
    if (video && !adoptPrewarm(id, meta, handles, port)) startVideo(id, meta, handles);
  } catch (error) {
    fs.rmSync(dir(id), { recursive: true, force: true });
    throw error;
  }
  if (apps) handles.sampler = startAppSampler(id);
  active.set(id, handles);

  const conn = await connect(port);
  const script = injectionScript(id);

  // Published before the first tab is touched: the daemon injects into any tab
  // created from now on, at creation, which is the only way to catch the first
  // click in a tab someone just opened.
  writeActive({ id, port, script });

  // New pages get it on document creation; pages already open get it now.
  // In parallel with short timeouts: a browser with twenty tabs, some of them
  // discarded by the memory saver, must not take a minute to start recording.
  const scriptIds = [];
  const tabs = await ops.tabs(conn);
  await Promise.all(
    tabs.map(async t => {
      try {
        const r = await conn.send(t.targetId, 'Page.addScriptToEvaluateOnNewDocument', { source: script }, 3000);
        scriptIds.push({ targetId: t.targetId, identifier: r.identifier });
        await ops.evaluate(conn, t.targetId, script, { timeoutMs: 3000 });
      } catch {
        /* a suspended tab is simply not recorded until it wakes */
      }
    }),
  );
  conn.close();

  handles.scriptIds = scriptIds;
  meta.scriptIds = scriptIds;
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));

  // Page.addScriptToEvaluateOnNewDocument is per target, so the set above is
  // frozen at the moment recording started: a tab opened during the play was
  // not recorded at all, and neither was a suspended tab that later woke. Both
  // are normal things to do while demonstrating something, so keep looking.
  handles.watcher = startTabWatcher(id, meta, handles, script);

  return meta;
}

// Ask the page, do not assume. A tab opened mid-recording accepted
// addScriptToEvaluateOnNewDocument and reported success while its live document
// still had no recorder, so the only trustworthy signal is the page itself
// naming the recording it belongs to.
async function ensureInstalled(conn, tab, id, meta, handles, script, registered) {
  const probe = `window.__cdpRecording === ${JSON.stringify(id)}`;
  try {
    const installed = await ops.evaluate(conn, tab.targetId, probe, { timeoutMs: 1200 });
    if (installed === true || installed?.value === true) return;
    if (!registered.has(tab.targetId)) {
      const r = await conn.send(tab.targetId, 'Page.addScriptToEvaluateOnNewDocument', { source: script }, 3000);
      registered.add(tab.targetId);
      handles.scriptIds.push({ targetId: tab.targetId, identifier: r.identifier });
      meta.scriptIds = handles.scriptIds;
      fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
    }
    await ops.evaluate(conn, tab.targetId, script, { timeoutMs: 3000 });
    note(id, `installed into ${String(tab.url || '').slice(0, 50)}`);
  } catch (e) {
    // Suspended by the memory saver, or gone. The next tick tries again.
    note(id, `skipped ${String(tab.url || '').slice(0, 40)}: ${e.message.slice(0, 60)}`);
  }
}

// Diagnostics for the watcher, alongside the recording it belongs to.
function note(id, line) {
  try {
    fs.appendFileSync(path.join(dir(id), 'watcher.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* never fail a recording over a log line */
  }
}

function startTabWatcher(id, meta, handles, script) {
  const registered = new Set(handles.scriptIds.map(s => s.targetId));
  let busy = false;
  return setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const conn = await connect(handles.port);
      try {
        const tabs = await ops.tabs(conn);
        // In parallel, and new tabs first. Serially, every suspended tab cost a
        // 2.5s timeout, so one pass over 25 tabs took half a minute and a tab
        // opened during the play went unrecorded for most of it.
        const fresh = tabs.filter(t => !registered.has(t.targetId));
        const seen = tabs.filter(t => registered.has(t.targetId));
        note(id, `tick: ${tabs.length} tabs, ${fresh.length} new`);
        for (const group of [fresh, seen]) {
          if (!group.length) continue;
          await Promise.all(group.map(t => ensureInstalled(conn, t, id, meta, handles, script, registered)));
        }
      } finally {
        conn.close();
      }
    } catch (e) {
      note(id, `tick failed: ${e.message}`);
    } finally {
      busy = false;
    }
  }, 2500);
}

// Which avfoundation device is the screen. The index is not stable across
// machines or across plugging in a display, and a wrong one silently records
// a webcam, so ask ffmpeg rather than hard-coding.
export function screenIndex() {
  if (setting('SCREEN_INDEX')) return setting('SCREEN_INDEX');
  // The probe costs ~2.5s, which is 2.5s of the play not on video, so it is
  // remembered. Displays change rarely; delete the file or set the env var.
  const cache = path.join(ROOT, 'screen-index');
  try {
    const cached = fs.readFileSync(cache, 'utf8').trim();
    if (/^\d+$/.test(cached)) return cached;
  } catch {
    /* not probed yet */
  }
  try {
    const out = spawnSyncText('ffmpeg', ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
    const m = out.match(/\[(\d+)\]\s+Capture screen 0/i);
    if (m) {
      try {
        fs.mkdirSync(ROOT, { recursive: true });
        fs.writeFileSync(cache, m[1]);
      } catch {
        /* a read-only home is not a reason to fail the recording */
      }
      return m[1];
    }
  } catch {
    /* fall through to the common default */
  }
  return '3';
}

function spawnSyncText(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000 });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

function ffmpegInstalled() {
  const result = spawnSync('ffmpeg', ['-version'], {
    encoding: 'utf8',
    stdio: 'ignore',
    timeout: 3000,
  });
  return !result.error && result.status === 0;
}

export function videoSupport({ platform = process.platform, probe = ffmpegInstalled } = {}) {
  if (platform !== 'darwin') {
    return { supported: false, reason: 'Screen video capture is available only on macOS.' };
  }
  try {
    if (probe()) return { supported: true, reason: null };
  } catch {
    // A missing or unlaunchable ffmpeg is the same capability failure.
  }
  return { supported: false, reason: 'ffmpeg is not installed or cannot be started.' };
}

// Three things this has to get right, learned by measuring a 48s capture that
// produced a 9s file:
//   - h264_videotoolbox, not libx264. Software-encoding a retina display at
//     15fps cannot keep up, and avfoundation drops the frames it cannot take.
//   - a bounded width. Scaling before the encoder is what makes the frame rate
//     achievable at all.
//   - -fps_mode cfr, so gaps are filled rather than silently shortening the
//     video. Video time has to equal wall-clock time, or every mark made on the
//     video resolves to the wrong event.
export function videoArgs(id, { screen = '3', fps = '15', codec = 'h264_videotoolbox', bitrate = '5M', width = 1728 } = {}) {
  return [
    '-y', '-f', 'avfoundation', '-capture_cursor', '1', '-framerate', String(fps),
    // Timestamp frames by when they arrived, so a stretch where the capture
    // fell behind becomes padded time rather than time that vanishes.
    '-use_wallclock_as_timestamps', '1', '-i', `${screen}:none`,
    '-vf', `scale=w=min(iw\\,${width}):h=-2`,
    '-r', String(fps), '-fps_mode', 'cfr',
    '-c:v', codec, '-b:v', bitrate,
    '-pix_fmt', 'yuv420p',
    // Machine-readable progress on stdout, so the first real frame can be
    // timed. Without it, the only clock available is "when spawn returned",
    // which is wrong by however long avfoundation takes to open the display.
    '-progress', 'pipe:1', '-nostats',
    videoPath(id),
  ];
}

// One (video time, wall time) pair out of an ffmpeg progress block. Anchoring
// to spawn instead pushed marks ~30s off the events they described, because
// opening a screen capture device and then competing with tab instrumentation
// both happen after spawn returns.
export function progressSample(chunk, now = Date.now()) {
  const text = String(chunk);
  const frame = /(?:^|\n)frame=\s*(\d+)/.exec(text);
  if (!frame || Number(frame[1]) < 1) return null;
  const us = /(?:^|\n)out_time_us=(-?\d+)/.exec(text);
  if (!us) return null;
  return { w: now, v: Math.max(0, Number(us[1]) / 1000000) };
}

// Where in wall-clock time the footage at `seconds` was captured. Linear
// interpolation between measured samples, so a stretch where capture fell
// behind maps correctly instead of shifting everything after it.
export function videoTimeToWall(id, seconds) {
  const meta = readMeta(id);
  const anchor = meta?.videoStartedAt || meta?.startedAt || 0;
  const samples = readJsonl(clockPath(id));
  if (!samples.length) return anchor + seconds * 1000;
  if (seconds <= samples[0].v) return samples[0].w - (samples[0].v - seconds) * 1000;
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1];
    const b = samples[i];
    if (seconds <= b.v) {
      const span = b.v - a.v;
      const ratio = span > 0 ? (seconds - a.v) / span : 0;
      return Math.round(a.w + ratio * (b.w - a.w));
    }
  }
  const last = samples[samples.length - 1];
  return Math.round(last.w + (seconds - last.v) * 1000);
}

// The inverse, for turning "this happened at 14:32:07" into a place in the video.
export function wallToVideoTime(id, wallMs) {
  const samples = readJsonl(clockPath(id));
  if (!samples.length) {
    const meta = readMeta(id);
    return (wallMs - (meta?.videoStartedAt || meta?.startedAt || 0)) / 1000;
  }
  if (wallMs <= samples[0].w) return Math.max(0, samples[0].v - (samples[0].w - wallMs) / 1000);
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1];
    const b = samples[i];
    if (wallMs <= b.w) {
      const span = b.w - a.w;
      const ratio = span > 0 ? (wallMs - a.w) / span : 0;
      return a.v + ratio * (b.v - a.v);
    }
  }
  const last = samples[samples.length - 1];
  return last.v + (wallMs - last.w) / 1000;
}

function startVideo(id, meta, handles) {
  const capability = videoSupport();
  if (!capability.supported) throw new Error(`Video capture unavailable: ${capability.reason}`);
  const args = videoArgs(id, {
    screen: screenIndex(),
    fps: setting('VIDEO_FPS') || '15',
    codec: setting('VIDEO_CODEC') || 'h264_videotoolbox',
    bitrate: setting('VIDEO_BITRATE') || '5M',
    width: number('VIDEO_WIDTH', 0) || 1728,
  });
  handles.ffmpeg = spawn('ffmpeg', args, {
    stdio: ['pipe', 'pipe', fs.openSync(path.join(dir(id), 'ffmpeg.log'), 'a')],
  });
  handles.ffmpeg.once('error', error => {
    handles.ffmpegError = error;
    meta.videoError = error.message;
    if (id === PREWARM && prewarmHandles === handles) {
      prewarmHandles = null;
      fs.rmSync(dir(PREWARM), { recursive: true, force: true });
      return;
    }
    try {
      fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
      fs.appendFileSync(path.join(dir(id), 'ffmpeg.log'), `${error.message}\n`);
    } catch {
      /* the capture may already have been removed by disarm */
    }
  });
  handles.ffmpegArgs = args;
  // A provisional anchor, replaced by the real one as soon as a frame lands.
  meta.videoStartedAt = Date.now();
  meta.videoStartedAtCalibrated = false;
  meta.videoArgs = args;
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));

  handles.ffmpeg.stdout?.on('data', chunk => {
    // Every progress block pairs "how much video exists" with "what time is it
    // now". Those pairs are the video's real clock. A single anchor is not
    // enough: instrumenting twenty tabs starves the capture for the first half
    // minute, so video time runs slower than wall time early on and no
    // constant offset describes the whole file.
    const sample = progressSample(chunk);
    if (!sample) return;
    try {
      fs.appendFileSync(clockPath(handles.clockId || id), `${JSON.stringify(sample)}\n`);
    } catch {
      /* diagnostics are not worth failing a recording over */
    }
    if (meta.videoStartedAtCalibrated) return;
    meta.videoStartedAt = sample.w - sample.v * 1000;
    meta.videoStartedAtCalibrated = true;
    // Mutating the caller's meta matters: start() writes this same object again
    // once tab instrumentation finishes, and would otherwise undo this.
    fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
  });
}

function startAppSampler(id) {
  return setInterval(() => {
    execFile(
      '/usr/bin/osascript',
      ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'],
      (err, stdout) => {
        if (err) return;
        fs.appendFileSync(windowsPath(id), `${JSON.stringify({ t: Date.now(), app: stdout.trim() })}\n`);
      },
    );
  }, 1000);
}

export async function stop(id) {
  const meta = readMeta(id);
  if (!meta) throw new Error(`No recording ${id}`);
  const handles = active.get(id) || (meta.scriptIds ? { port: meta.port, scriptIds: meta.scriptIds } : null);
  if (handles) {
    if (handles.sampler) clearInterval(handles.sampler);
    if (handles.watcher) clearInterval(handles.watcher);
    clearActive();
    forgetEventKeys(id);
    if (handles.ffmpeg) {
      // ffmpeg needs 'q' on stdin to finalise the mp4 container; a SIGKILL
      // leaves an unplayable file.
      try {
        handles.ffmpeg.stdin.write('q');
      } catch {
        handles.ffmpeg.kill('SIGINT');
      }
      // Wait for the process to actually exit rather than for a fixed 1.2s:
      // whatever it had not yet encoded when the timer expired was simply lost
      // from the end of the video. The timeout is a backstop, not the plan.
      await new Promise(resolve => {
        const done = setTimeout(() => {
          try {
            handles.ffmpeg.kill('SIGINT');
          } catch {
            /* already gone */
          }
          resolve();
        }, 8000);
        handles.ffmpeg.once('close', () => {
          clearTimeout(done);
          resolve();
        });
      });
      // stoppedAt is taken after teardown, which detaches scripts from every
      // tab and can take seconds. Recording the instant the capture itself
      // ended stops that being mistaken for lost footage, as it was twice.
      meta.videoStoppedAt = Date.now();
      if (handles.adoptedVideo && fs.existsSync(handles.adoptedVideo)) {
        // Only now is the container finalised and safe to move.
        fs.renameSync(handles.adoptedVideo, videoPath(meta.id));
        fs.rmSync(path.dirname(handles.adoptedVideo), { recursive: true, force: true });
      }
    }
    try {
      const conn = await connect(handles.port);
      await Promise.all(
        handles.scriptIds.map(s =>
          conn.send(s.targetId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: s.identifier }, 3000).catch(() => {}),
        ),
      );
      conn.close();
    } catch {
      /* browser may already be gone */
    }
    active.delete(id);
  }
  // Silence the page-side recorders too, or they keep posting under a
  // recording that has ended.
  if (handles?.port) {
    try {
      const conn = await connect(handles.port);
      const tabsNow = await ops.tabs(conn);
      await Promise.all(
        tabsNow.map(t =>
          ops
            .evaluate(conn, t.targetId, 'try{window.__cdpRecorder&&window.__cdpRecorder.flush();window.__cdpRecording=null;delete window.__cdpRecorder;}catch(e){};true', { timeoutMs: 2000 })
            .catch(() => {}),
        ),
      );
      conn.close();
    } catch {
      /* browser gone */
    }
  }
  meta.stoppedAt = Date.now();
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(dir(id), 'steps.md'), renderSteps(id));
  return summary(id);
}

export const appendEvents = storeAppend;

// -------------------------------------------------------------- reading -----

export function list() {
  if (!fs.existsSync(ROOT)) return [];
  return fs
    .readdirSync(ROOT)
    .map(id => readMeta(id))
    .filter(Boolean)
    .map(m => ({ ...m, events: readJsonl(eventsPath(m.id)).length, marks: readJsonl(marksPath(m.id)).length }))
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function summary(id) {
  const meta = readMeta(id);
  if (!meta) throw new Error(`No recording ${id}`);
  const { scriptIds, ...rest } = meta;
  return {
    ...rest,
    durationMs: (meta.stoppedAt || Date.now()) - meta.startedAt,
    events: readJsonl(eventsPath(id)).length,
    windows: readJsonl(windowsPath(id)).length,
    marks: readJsonl(marksPath(id)).length,
    hasVideo: fs.existsSync(videoPath(id)),
    dir: dir(id),
  };
}

const clock = (ms, base) => {
  const s = Math.max(0, Math.round((ms - base) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function renderSteps(id) {
  const meta = readMeta(id);
  const events = readJsonl(eventsPath(id));
  const windows = readJsonl(windowsPath(id));
  const lines = [`# ${id}${meta.label ? ` — ${meta.label}` : ''}`, '', `Started ${new Date(meta.startedAt).toISOString()}`, ''];
  let lastUrl = null;
  let lastApp = null;
  for (const e of events) {
    const w = windows.filter(x => x.t <= e.t).pop();
    if (w && w.app !== lastApp) {
      lines.push(`_${clock(e.t, meta.startedAt)} — frontmost: ${w.app}_`, '');
      lastApp = w.app;
    }
    if (e.url !== lastUrl) {
      lines.push(`### ${e.title || e.url}`, `${e.url}`, '');
      lastUrl = e.url;
    }
    const el = e.element;
    const what = el ? `${el.role} "${el.name}"${el.testid ? ` [${el.testid}]` : ''}` : '';
    const extra = e.value !== undefined ? ` = ${JSON.stringify(e.value)}` : e.key ? ` (${e.key})` : '';
    lines.push(`- ${clock(e.t, meta.startedAt)}  **${e.type}** ${what}${extra}`);
  }
  return lines.join('\n') + '\n';
}

// ----------------------------------------------------------------- marks ----

export function addMark(id, { t, note }) {
  const meta = readMeta(id);
  if (!meta) throw new Error(`No recording ${id}`);
  // t is seconds into the video; store the absolute instant too.
  // Interpolated from the measured video clock, not `anchor + t`: capture that
  // fell behind early would otherwise put every later mark in the wrong place.
  const row = { id: `mk_${Math.random().toString(36).slice(2, 6)}`, t, at: videoTimeToWall(id, t), note };
  fs.appendFileSync(marksPath(id), `${JSON.stringify(row)}\n`);
  return row;
}

// A mark is only useful if it comes back as "the click on Confirm and apply",
// not as a frame number. Attach the nearest browser events, and failing that,
// whatever app was frontmost.
export function resolvedMarks(id, windowMs = 2000) {
  const meta = readMeta(id);
  if (!meta) throw new Error(`No recording ${id}`);
  const events = readJsonl(eventsPath(id));
  const windows = readJsonl(windowsPath(id));
  return readJsonl(marksPath(id)).map(m => {
    // Nearest first, but an interaction outranks a page load at the same
    // distance: someone marking a moment means "what did I do here", and a tab
    // finishing loading a few milliseconds closer is not the answer.
    const weight = e => (['click', 'change', 'submit', 'key'].includes(e.type) ? 0 : 1);
    const near = events
      .filter(e => Math.abs(e.t - m.at) <= windowMs)
      .sort((a, b) => weight(a) - weight(b) || Math.abs(a.t - m.at) - Math.abs(b.t - m.at))
      .slice(0, 3);
    const w = windows.filter(x => x.t <= m.at).pop();
    return {
      ...m,
      clock: clock(m.at, meta.videoStartedAt || meta.startedAt),
      frontmost: w?.app ?? null,
      events: near,
      summary: near.length
        ? `${near[0].type} on ${near[0].element ? `${near[0].element.role} "${near[0].element.name}"` : near[0].url}`
        : w
          ? `nothing in the browser; ${w.app} was frontmost`
          : 'no nearby activity',
    };
  });
}

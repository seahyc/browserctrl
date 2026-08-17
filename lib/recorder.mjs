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
import { ROOT, dir, metaPath, eventsPath, windowsPath, marksPath, videoPath, readJsonl, readMeta, appendEvents as storeAppend } from './recstore.mjs';

const active = new Map(); // id -> { ffmpeg, sampler, port, scriptIds }

export { videoPath };

// The page-side recorder. Same identity vocabulary as the annotation overlay,
// so an event and an annotation describe an element the same way.
export function recorderScript() {
  return `(function(){
  if (window.__cdpRecorder) return;
  var BRIDGE = window.__cdpBridge || 'http://127.0.0.1:17222';
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
  /* Same transport ladder as the annotation overlay, and for the same reason:
   * current Chromium blocks an HTTPS page from calling loopback, so a plain
   * fetch silently loses every event on real sites. */
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
    fetch(BRIDGE + '/api/recordings/' + ID + '/events', {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(batch), keepalive: true
    }).catch(function(){ queue = batch.concat(queue); });
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
  const handles = { port, scriptIds: [] };
  if (video) startVideo(id, meta, handles);
  if (apps) handles.sampler = startAppSampler(id);
  active.set(id, handles);

  const conn = await connect(port);
  const preamble = idString =>
    `window.__cdpRecording=${JSON.stringify(idString)};window.__cdpBridge=${JSON.stringify(
      `http://127.0.0.1:${process.env.CDP_BRIDGE_PORT || 17222}`,
    )};`;
  // A recorder left over from an earlier run would refuse to be replaced, and
  // would keep emitting under the old id, so tear it down first.
  const script = 'try{delete window.__cdpRecorder;}catch(e){}' + preamble(id) + recorderScript();

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

  return meta;
}

// Which avfoundation device is the screen. The index is not stable across
// machines or across plugging in a display, and a wrong one silently records
// a webcam, so ask ffmpeg rather than hard-coding.
export function screenIndex() {
  if (process.env.CDP_SCREEN_INDEX) return process.env.CDP_SCREEN_INDEX;
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
    '-y', '-f', 'avfoundation', '-capture_cursor', '1', '-framerate', String(fps), '-i', `${screen}:none`,
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

// Opening a screen capture device took ~11s on a retina display, all of it
// after spawn returned. Anchoring video time to spawn therefore pushed every
// mark ~11s late. ffmpeg's own progress stream says when frame 1 actually
// landed, so ask it instead of guessing.
export function calibrateFromProgress(chunk, now = Date.now()) {
  const text = String(chunk);
  const frame = /(?:^|\n)frame=(\d+)/.exec(text);
  if (!frame || Number(frame[1]) < 1) return null;
  const us = /(?:^|\n)out_time_us=(-?\d+)/.exec(text);
  const elapsedMs = us ? Math.max(0, Number(us[1]) / 1000) : 0;
  return now - elapsedMs;
}

function startVideo(id, meta, handles) {
  const args = videoArgs(id, {
    screen: screenIndex(),
    fps: process.env.CDP_VIDEO_FPS || '15',
    codec: process.env.CDP_VIDEO_CODEC || 'h264_videotoolbox',
    bitrate: process.env.CDP_VIDEO_BITRATE || '5M',
  });
  handles.ffmpeg = spawn('ffmpeg', args, {
    stdio: ['pipe', 'pipe', fs.openSync(path.join(dir(id), 'ffmpeg.log'), 'a')],
  });
  handles.ffmpegArgs = args;
  // A provisional anchor, replaced by the real one as soon as a frame lands.
  meta.videoStartedAt = Date.now();
  meta.videoStartedAtCalibrated = false;
  meta.videoArgs = args;
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));

  handles.ffmpeg.stdout?.on('data', chunk => {
    if (meta.videoStartedAtCalibrated) return;
    const at = calibrateFromProgress(chunk);
    if (at === null) return;
    // Mutating the caller's meta matters: start() writes this same object again
    // once tab instrumentation finishes, and would otherwise undo this.
    meta.videoStartedAt = at;
    meta.videoStartedAtCalibrated = true;
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
  const row = { id: `mk_${Math.random().toString(36).slice(2, 6)}`, t, at: (meta.videoStartedAt || meta.startedAt) + t * 1000, note };
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
    const near = events
      .filter(e => Math.abs(e.t - m.at) <= windowMs)
      .sort((a, b) => Math.abs(a.t - m.at) - Math.abs(b.t - m.at))
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

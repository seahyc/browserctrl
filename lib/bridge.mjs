// Local bridge: the human-facing HTTP surface.
//
// The daemon talks to browsers over CDP. The bridge talks to humans and to
// things that cannot open a unix socket: the injected overlay, the extension,
// the tray page, the video annotator. It binds loopback only.
//
// Division of labour: the page posts what only it knows (which element, what
// note); the bridge adds what only it can get (which tab that was, a cropped
// screenshot).
//
// Binding to loopback does not keep web pages out: any page the user visits can
// call 127.0.0.1. So every route except /health and the two static scripts needs
// a per-install token (the file bridge-token in the runtime folder, mode 0600),
// or the browserctrl extension's own origin, which a web page cannot forge.
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { connect } from './daemon.mjs';
import { listBrowsers } from './discovery.mjs';
import { BROWSERS } from './env.mjs';
import * as ops from './ops.mjs';
import * as state from './state.mjs';
import * as annotations from './annotations.mjs';
import * as sessions from './sessions.mjs';
import * as recorder from './recorder.mjs';
import { setting, number, runtimePath, ensureRuntimeDir } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BRIDGE_PORT = number('BRIDGE_PORT', 17222);

const readAsset = rel => fs.readFileSync(path.join(HERE, rel), 'utf8');

// ------------------------------------------------------------------- token --

const TOKEN_FILE = () => runtimePath('bridge-token');
const TOKEN_RE = /^[0-9a-f]{64}$/;

// The bridge and the CLI both call this; whoever comes first creates the file.
// It is written to a private temp name and linked into place, so two racing
// creators cannot leave one of them holding a token the other overwrote.
export function bridgeToken() {
  const file = TOKEN_FILE();
  ensureRuntimeDir(path.dirname(file));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const t = fs.readFileSync(file, 'utf8').trim();
      if (TOKEN_RE.test(t)) return t;
      fs.rmSync(file, { force: true });
    } catch {}
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.writeFileSync(tmp, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
      fs.linkSync(tmp, file);
    } catch {} finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  throw new Error(`could not create the bridge token at ${file}`);
}

// fetch() with the token attached, for the CLI and daemon calling the bridge.
export const bridgeFetch = (url, init = {}) =>
  fetch(url, { ...init, headers: { ...init.headers, 'X-Browserctrl-Token': bridgeToken() } });

// The extension is trusted by its origin, which a web page cannot set. The id
// comes from the `key` in extension/manifest.json (so it is the same on every
// machine and every load path); BRIDGE_EXTENSION_ID adds more, for an
// extension loaded before the key existed.
export function extensionId(keyBase64) {
  const hex = crypto.createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map(c => 'abcdefghijklmnop'[parseInt(c, 16)]).join('');
}

function extensionOrigins() {
  const ids = (setting('BRIDGE_EXTENSION_ID') || '').split(',').map(x => x.trim()).filter(Boolean);
  try {
    const { key } = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'extension', 'manifest.json'), 'utf8'));
    if (key) ids.push(extensionId(key));
  } catch {}
  return new Set(ids.map(id => `chrome-extension://${id}`));
}

const sameToken = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Header for fetch, `t` query for what a page loads as <img>, <video> or a link.
function tokenOk(req, url) {
  const given = req.headers['x-browserctrl-token'] || url.searchParams.get('t');
  return Boolean(given) && sameToken(given, bridgeToken());
}
const fromExtension = req => Boolean(req.headers.origin) && extensionOrigins().has(req.headers.origin);

// A page served by the bridge carries the token so its own fetches work. Other
// origins cannot read it (same-origin policy) and cannot frame it.
function withToken(html) {
  const t = JSON.stringify(bridgeToken());
  const boot = `<script>const BRIDGE_TOKEN=${t};{const f=fetch;fetch=(u,o={})=>f(u,{...o,headers:{...o.headers,'X-Browserctrl-Token':BRIDGE_TOKEN}});}</script>`;
  return html.includes('<head>') ? html.replace('<head>', `<head>${boot}`) : boot + html;
}

function send(res, status, body, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...(type === 'text/html' ? { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" } : {}),
  });
  res.end(payload);
}

// Cross-origin read access is granted per response, and only to a caller that
// already proved itself. No Access-Control-Allow-Private-Network: that header
// only matters to a public HTTPS page calling loopback, and nothing does that
// any more (the overlay and recorder talk to the daemon over a CDP binding, the
// extension is exempt), so such a page should be refused.
function grant(res, req) {
  if (!req.headers.origin) return;
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  res.setHeader('Vary', 'Origin');
}

// A preflight carries no token, so it only says which methods and headers are
// allowed. It exposes nothing: the real request still has to authenticate.
function preflight(res, req) {
  const h = { 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-Browserctrl-Token', 'Access-Control-Max-Age': '600', Vary: 'Origin' };
  if (req.headers.origin) h['Access-Control-Allow-Origin'] = req.headers.origin;
  res.writeHead(204, h);
  res.end();
}

function body(req) {
  return new Promise(resolve => {
    let buf = '';
    req.on('data', c => (buf += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(buf || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

// Find the tab an annotation came from. The page knows its URL and title but
// not its target id, so we match across every debuggable browser.
async function findTab(url, title) {
  const live = (await listBrowsers()).filter(b => b.debuggable);
  for (const b of live) {
    let conn;
    try {
      conn = await connect(b.port);
      const all = await ops.tabs(conn);
      const exact = all.filter(t => t.url === url);
      const match = exact.length === 1 ? exact[0] : exact.find(t => t.title === title) || exact[0];
      if (match) return { conn, port: b.port, tab: match };
      conn.close();
    } catch {
      try {
        conn?.close();
      } catch {}
    }
  }
  return null;
}

async function handleAnnotation(payload) {
  const found = await findTab(payload.page?.url, payload.page?.title);
  let screenshot = null;
  let tab = null;
  if (found) {
    const { conn, port, tab: t } = found;
    tab = { targetId: t.targetId, alias: t.alias, port };
    try {
      const box = payload.element?.box;
      const scroll = payload.element?.scroll || { x: 0, y: 0 };
      const row = annotations.add({ ...payload, tab });
      // Box is viewport-relative; a clip is page-relative.
      const pad = 8;
      await ops.screenshot(conn, t.targetId, {
        path: annotations.shotPath(row.id),
        region: {
          x: Math.max(0, box.x + scroll.x - pad),
          y: Math.max(0, box.y + scroll.y - pad),
          width: box.w + pad * 2,
          height: box.h + pad * 2,
        },
      });
      // Annotating a tab is already a handover, so mark it.
      state.mark(port, t.targetId, { note: payload.note, url: t.url, title: t.title });
      const withShot = { ...row, screenshot: annotations.shotPath(row.id) };
      annotations.update(row.id, { screenshot: withShot.screenshot });
      conn.close();
      return withShot;
    } catch {
      try {
        conn.close();
      } catch {}
    }
  }
  return annotations.add({ ...payload, tab, screenshot });
}

// The bridge exits after `idleMs` with no authenticated request, but never while
// a recording is running or capture is pre-warmed: that work has no requests.
export async function start(port = BRIDGE_PORT, { idleMs = number('BRIDGE_IDLE_MIN', 60) * 60000, onIdle } = {}) {
  let lastUse = Date.now();
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const route = url.pathname;
    // A DNS-rebinding page reaches loopback under its own hostname; refuse it.
    if (!hosts.has(req.headers.host)) return send(res, 403, { error: 'forbidden' });
    if (req.method === 'OPTIONS') return preflight(res, req);

    try {
      if (route === '/health') { lastUse = Date.now(); return send(res, 200, { ok: true, port, pid: process.pid }); }
      // Scripts, not data: they hold no token, so any page may load them.
      if (route === '/overlay.js') return send(res, 200, readAsset('overlay/annotate.js'), 'application/javascript');
      if (route === '/recorder.js') return send(res, 200, recorder.recorderScript(), 'application/javascript');

      const extension = fromExtension(req);
      if (!extension && !tokenOk(req, url)) return send(res, 403, { error: 'forbidden' });
      lastUse = Date.now();
      grant(res, req);

      // The extension's way to a token for opening /tray in a tab. Only its
      // own origin is answered; a caller with the token already has it.
      if (route === '/api/token') return extension ? send(res, 200, { token: bridgeToken() }) : send(res, 403, { error: 'forbidden' });

      if (route === '/tray') return send(res, 200, withToken(readAsset('pages/tray.html')), 'text/html');
      if (route === '/annotator') return send(res, 200, withToken(readAsset('pages/annotator.html')), 'text/html');

      if (route === '/annotations' && req.method === 'POST') {
        return send(res, 200, await handleAnnotation(await body(req)));
      }
      if (route === '/api/annotations' && req.method === 'DELETE') {
        return send(res, 200, { cleared: annotations.clear() });
      }
      if (route.startsWith('/api/annotations/') && req.method === 'DELETE') {
        return send(res, 200, { removed: annotations.remove(route.split('/').pop()) });
      }
      if (route === '/api/annotations') {
        // Consuming changes state, so a GET never does it.
        const consume = req.method === 'POST' && url.searchParams.get('consume') === '1';
        const forUrl = url.searchParams.get('url');
        const sessionId = url.searchParams.get('session');
        if (forUrl) return send(res, 200, annotations.forPage(forUrl));
        return send(res, 200, consume ? annotations.consume({ sessionId }) : annotations.pending({ sessionId }));
      }
      if (route === '/api/sessions') return send(res, 200, sessions.live());

      if (route === '/api/browsers') return send(res, 200, await listBrowsers());

      if (route === '/api/tabs') {
        const key = url.searchParams.get('browser');
        const targetPort = key ? BROWSERS[key]?.port : null;
        const live = (await listBrowsers()).filter(b => b.debuggable && (!targetPort || b.port === targetPort));
        const out = [];
        for (const b of live) {
          const conn = await connect(b.port);
          try {
            const rows = await ops.tabs(conn, { focus: url.searchParams.get('focus') === '1' });
            out.push(...rows.map(t => ({ ...t, browser: b.key, port: b.port })));
          } finally {
            conn.close();
          }
        }
        return send(res, 200, out);
      }

      if (route === '/api/marks' && req.method === 'GET') return send(res, 200, state.marks());
      if (route === '/api/marks' && req.method === 'POST') {
        const b = await body(req);
        return send(res, 200, state.mark(b.port, b.targetId, { note: b.note ?? null, url: b.url, title: b.title }));
      }
      // The extension knows a URL, not a CDP target id, so it marks by URL and
      // we resolve which debuggable browser owns that tab.
      if (route === '/api/marks/by-url') {
        const b = await body(req);
        const found = await findTab(b.url, b.title);
        if (!found) return send(res, 404, { error: 'no debuggable tab matches that url' });
        const { conn, port: p, tab: t } = found;
        conn.close();
        if (req.method === 'DELETE') return send(res, 200, { unmarked: state.unmark(p, t.targetId) });
        return send(res, 200, state.mark(p, t.targetId, { note: b.note ?? null, url: t.url, title: t.title }));
      }
      if (route === '/api/marks' && req.method === 'DELETE') {
        const b = await body(req);
        return send(res, 200, { unmarked: state.unmark(b.port, b.targetId) });
      }

      if (route.startsWith('/shots/')) {
        const file = path.join(state.STATE_DIR, 'annotations', path.basename(route));
        if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(fs.readFileSync(file));
      }

      // Pre-warm: the capture device is opened before a recording exists, so
      // `record start` does not pay for opening it.
      if (route === '/api/prewarm' && req.method === 'POST') {
        const b2 = await body(req);
        return send(res, 200, recorder.arm({ port: b2.port }));
      }
      if (route === '/api/prewarm' && req.method === 'DELETE') return send(res, 200, recorder.disarm());
      if (route === '/api/prewarm') return send(res, 200, recorder.prewarmStatus());

      if (route === '/api/recordings' && req.method === 'POST') {
        const b = await body(req);
        return send(res, 200, await recorder.start({ port: b.port, video: b.video, apps: b.apps, label: b.label }));
      }
      if (route === '/api/recordings') return send(res, 200, recorder.list());
      if (route.startsWith('/api/recordings/')) {
        const [, , , id, what] = route.split('/');
        if (req.method === 'POST' && what === 'events') {
          const rows = await body(req);
          return send(res, 200, { appended: recorder.appendEvents(id, Array.isArray(rows) ? rows : []) });
        }
        if (req.method === 'POST' && what === 'stop') {
          return send(res, 200, await recorder.stop(id));
        }
        if (what === 'steps') return send(res, 200, recorder.renderSteps(id), 'text/plain');
        if (req.method === 'POST' && what === 'marks') {
          const b = await body(req);
          return send(res, 200, recorder.addMark(id, b));
        }
        if (what === 'marks') return send(res, 200, recorder.resolvedMarks(id));
        if (what === 'video') {
          const file = recorder.videoPath(id);
          if (!fs.existsSync(file)) return send(res, 404, { error: 'no video for this recording' });
          const stat = fs.statSync(file);
          const range = req.headers.range;
          if (range) {
            const [s, e] = range.replace('bytes=', '').split('-');
            const start = parseInt(s, 10);
            const end = e ? parseInt(e, 10) : stat.size - 1;
            res.writeHead(206, {
              'Content-Type': 'video/mp4',
              'Content-Range': `bytes ${start}-${end}/${stat.size}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': end - start + 1,
            });
            return fs.createReadStream(file, { start, end }).pipe(res);
          }
          res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
          return fs.createReadStream(file).pipe(res);
        }
        return send(res, 200, recorder.summary(id));
      }

      return send(res, 404, { error: `no route ${route}` });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  bridgeToken();
  if (idleMs > 0) {
    const timer = setInterval(() => {
      if (Date.now() - lastUse < idleMs || recorder.isBusy()) return;
      clearInterval(timer);
      server.close();
      onIdle?.();
    }, Math.max(50, Math.min(30000, idleMs / 4)));
    timer.unref();
    server.on('close', () => clearInterval(timer));
  }
  return server;
}

export function health(port = BRIDGE_PORT) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 500 }, r => {
      r.resume();
      resolve(r.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

export async function ensureRunning(port = BRIDGE_PORT) {
  if (await health(port)) return port;
  const entry = path.join(HERE, 'bridge-run.mjs');
  spawn(process.execPath, [entry, String(port)], { detached: true, stdio: 'ignore' }).unref();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await health(port)) return port;
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`Bridge did not start on ${port}`);
}

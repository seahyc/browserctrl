// Local bridge: the human-facing HTTP surface.
//
// The daemon talks to browsers over CDP. The bridge talks to humans and to
// things that cannot open a unix socket: the injected overlay, the extension,
// the tray page, the video annotator. It binds loopback only.
//
// Division of labour: the page posts what only it knows (which element, what
// note); the bridge adds what only it can get (which tab that was, a cropped
// screenshot).
import http from 'http';
import fs from 'fs';
import path from 'path';
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BRIDGE_PORT = Number(process.env.CDP_BRIDGE_PORT || 17222);

const readAsset = rel => fs.readFileSync(path.join(HERE, rel), 'utf8');

function send(res, status, body, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': type,
    // The overlay runs in arbitrary page origins and the extension in its own,
    // so both need blanket CORS. Safe because we bind loopback only.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    // Chromium's Private Network Access: a page on a public HTTPS origin
    // calling loopback must be granted explicitly, and the preflight hangs
    // rather than fails if this is missing.
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
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

export async function start(port = BRIDGE_PORT) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const route = url.pathname;
    if (req.method === 'OPTIONS') return send(res, 204, '');

    try {
      if (route === '/health') return send(res, 200, { ok: true, port, pid: process.pid });

      if (route === '/overlay.js') return send(res, 200, readAsset('overlay/annotate.js'), 'application/javascript');
      if (route === '/recorder.js') return send(res, 200, recorder.recorderScript(), 'application/javascript');

      if (route === '/tray') return send(res, 200, readAsset('pages/tray.html'), 'text/html');
      if (route === '/annotator') return send(res, 200, readAsset('pages/annotator.html'), 'text/html');

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
        const consume = url.searchParams.get('consume') === '1';
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
        const file = path.join(state.CDP_HOME, 'annotations', path.basename(route));
        if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(fs.readFileSync(file));
      }

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

  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
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

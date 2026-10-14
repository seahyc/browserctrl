// Test rig: a throwaway headless Chrome on its own port and user-data-dir, plus
// a local static server for the fixture page. Never touches a real profile.
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Test daemons inherit the environment of whichever test file started them, so
// keep their capture store and recipe tab registry out of the real home dir.
process.env.BROWSERCTRL_EXEMPLARS ||= path.join(os.tmpdir(), 'browserctrl-test-exemplars');
process.env.BROWSERCTRL_RECIPE_TABS ||= path.join(os.tmpdir(), 'browserctrl-test-recipe-tabs.json');
process.env.BROWSERCTRL_RECIPES ||= path.join(os.tmpdir(), 'browserctrl-test-recipes');
process.env.BROWSERCTRL_TAPS ||= path.join(os.tmpdir(), 'browserctrl-test-taps');
// Challenges on the fixture host would otherwise cool 127.0.0.1 down for other
// test files, and the solver config must never come from the real home dir.
process.env.BROWSERCTRL_COOLDOWN ||= path.join(os.tmpdir(), `browserctrl-test-cooldown-${process.pid}.json`);
process.env.BROWSERCTRL_CAPTCHA_CONFIG ||= path.join(os.tmpdir(), `browserctrl-test-captcha-${process.pid}.json`);
export const TEST_PORT = Number(process.env.BROWSERCTRL_TEST_PORT || 9333); // override to run suites side by side

const CHROME_CANDIDATES = [
  ...[process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).flatMap(root => [
    path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function chromeBinary() {
  const configured = process.env.CHROME_BIN;
  if (configured && path.isAbsolute(configured) && fs.existsSync(configured) && fs.statSync(configured).isFile()) {
    return configured;
  }
  return CHROME_CANDIDATES.find(p => fs.existsSync(p) && fs.statSync(p).isFile()) || null;
}

export async function startFixtureServer() {
  const html = fs.readFileSync(path.join(HERE, 'fixtures', 'page.html'), 'utf8');
  const hits = new Map();
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/slow')) {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1 id="slow">slow page</h1></body></html>');
      }, 400);
      return;
    }
    // A small first-party API: a page that embeds a csrf token and calls a
    // paginated JSON endpoint on load, as a site frontend would.
    if (req.url.startsWith('/shop')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body><h1>shop</h1><script type="application/json" id="boot">{"App":{"csrfToken":"tok-123"}}</script>
<script>fetch('/api/orders/48213?offset=0&limit=2', {headers: {'x-csrf': 'tok-123'}}).then(r => r.json()).then(j => { document.body.dataset.loaded = j.data.orders.length; });</script></body></html>`);
      return;
    }
    // An Alibaba-style "drag to the far right" slider. It passes only after a
    // gradual drag that reaches the end of the track, not a single jump.
    if (req.url.startsWith('/captcha-slider')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><head><meta charset="utf-8"></head><body style="margin:40px"><p id="msg">请按住滑块，拖动到最右边</p>
<div id="nc_1__scale_text" class="nc_scale" style="position:relative;width:300px;height:34px;background:#eee">
<span id="nc_1_n1z" class="nc_iconfont btn_slide" style="position:absolute;left:0;top:0;width:40px;height:34px;background:#888"></span></div>
<script>
const h = document.getElementById('nc_1_n1z'), track = h.parentElement; let down = false, start = 0, moves = 0;
h.addEventListener('mousedown', e => { down = true; start = e.clientX; moves = 0; });
document.addEventListener('mousemove', e => { if (!down) return; moves++; h.style.left = Math.max(0, Math.min(260, e.clientX - start)) + 'px'; });
document.addEventListener('mouseup', () => { if (!down) return; down = false;
  if (parseFloat(h.style.left) >= 258 && moves >= 10) { track.remove(); document.getElementById('msg').textContent = '验证通过'; } else h.style.left = '0px'; });
</script></body></html>`);
      return;
    }
    if (req.url.startsWith('/verify/captcha')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><canvas width="280" height="160"></canvas><p>Drag the piece into place</p></body></html>');
      return;
    }
    // A chat page whose session key arrives only in a WebSocket LOGI frame, as
    // with Sendbird; the messages API wants it back as a header.
    if (req.url.startsWith('/chat')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body><h1>chat</h1><script>const ws = new WebSocket('ws://' + location.host + '/ws'); ws.onmessage = e => { document.body.dataset.logi = '1'; };</script></body></html>`);
      return;
    }
    if (req.url.startsWith('/api/chat-messages')) {
      if (req.headers['session-key'] !== wsKey) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"session"}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages: [{ id: 1, text: 'Yup still possible' }, { id: 2, text: 'Deal' }] }));
      return;
    }
    if (req.url.startsWith('/api/orders/')) {
      if (req.headers['x-csrf'] !== 'tok-123') { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"error":"csrf"}'); return; }
      const q = new URL(req.url, 'http://x').searchParams;
      const offset = Number(q.get('offset')), limit = Number(q.get('limit'));
      const all = Array.from({ length: 5 }, (_, i) => ({ id: 100 + i, title: `Item ${i}`, price: { cents: 250 * (i + 1) } }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { orders: all.slice(offset, offset + limit) } }));
      return;
    }
    // Never answers the first request for each ?k=, then answers normally:
    // a stalled call that a read recipe may retry. /api/hits?k= counts them.
    if (req.url.startsWith('/api/hang-once')) {
      const k = new URL(req.url, 'http://x').searchParams.get('k');
      hits.set(k, (hits.get(k) || 0) + 1);
      if (hits.get(k) === 1) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: [{ id: 1 }, { id: 2 }] }));
      return;
    }
    if (req.url.startsWith('/api/hits')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(hits.get(new URL(req.url, 'http://x').searchParams.get('k')) || 0));
      return;
    }
    // Static pages for snapshot tests: /fixtures/items-market.html and the like.
    if (req.url.startsWith('/fixtures/')) {
      const file = path.join(HERE, 'fixtures', path.basename(new URL(req.url, 'http://x').pathname));
      if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(file));
      return;
    }
    if (req.url.startsWith('/404')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('nope');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  // Minimal WebSocket endpoint: handshake, then one text frame with the key.
  const wsKey = `k-${crypto.randomUUID()}`;
  const sockets = new Set();
  server.on('upgrade', (req, socket) => {
    if (!req.url.startsWith('/ws')) return socket.destroy();
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const payload = Buffer.from(`LOGI{"user_id":"1","key":"${wsKey}"}`);
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const close = () => { for (const s of sockets) s.destroy(); return new Promise(r => server.close(r)); };
  return { server, url: `http://127.0.0.1:${port}/`, wsKey, close };
}

export async function startHeadlessBrowser(port = TEST_PORT) {
  const bin = chromeBinary();
  if (!bin) return null;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-test-profile-'));
  const child = spawn(
    bin,
    [
      '--headless=new',
      ...(process.platform === 'win32' ? ['--disable-gpu'] : []),
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-extensions',
      ...(process.env.CHROME_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
      'about:blank',
    ],
    { stdio: ['ignore','ignore','pipe'], detached: process.platform !== 'win32' },
  );
  let startupErrors = '';
  child.stderr.on('data', chunk => { startupErrors = (startupErrors + chunk.toString()).slice(-8192); });
  let endpointReady = false;
  const signalBrowserGroup = signal => {
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, signal);
      else execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true});
    } catch {
      // The process group may already have exited.
    }
  };
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      signalBrowserGroup('SIGTERM');
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 800)),
      ]);
      // Chrome owns helper subprocesses; terminate the complete private group
      // even when the browser parent exits before those helpers do.
      signalBrowserGroup('SIGKILL');
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([
          new Promise(resolve => child.once('exit', resolve)),
          new Promise(resolve => setTimeout(resolve, 500)),
        ]);
      }
    }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  };
  // Wait for the debug endpoint to answer.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    const ok = await new Promise(resolve => {
      const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 500 }, r => {
        r.resume();
        resolve(r.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) { endpointReady = true; break; }
    await new Promise(r => setTimeout(r, 200));
  }
  if (!endpointReady) {
    const exit = child.exitCode === null ? '' : ` (exit ${child.exitCode})`;
    await close();
    throw new Error(`Chrome was found at ${bin} but its debugging endpoint on port ${port} did not become ready${exit}: ${startupErrors.trim()}`);
  }
  let version;
  try {
    version = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 5000 }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => {
          try { resolve(JSON.parse(body).Browser || null); } catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('Chrome version discovery timed out')));
    });
  } catch (error) {
    await close();
    throw error;
  }

  return {
    child,
    port,
    userDataDir,
    binary: bin,
    version,
    close,
  };
}

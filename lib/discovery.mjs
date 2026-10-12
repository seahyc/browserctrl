// Which browsers can we actually drive right now?
//
// Two discovery paths, because they behave differently:
//   1. Browsers launched with --remote-debugging-port expose the HTTP endpoints
//      (/json/version, /json/list), which also carry profile names.
//   2. Chrome enabled via the chrome://inspect toggle exposes ONLY the
//      browser-level WebSocket named in the DevToolsActivePort file; /json
//      returns empty 404s. Everything then has to go through Target.*.
import http from 'http';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { execFile } from 'child_process';
import { BROWSERS, PORT_TO_KEY, SOCK } from './env.mjs';

const HTTP_TIMEOUT_MS = 5000;

export function httpGetJson(port, urlPath, timeoutMs = HTTP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    // Direct connection: never routed through http_proxy env vars.
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: timeoutMs }, r => {
      let body = '';
      r.on('data', c => (body += c));
      r.on('end', () => {
        if (r.statusCode !== 200 || !body) {
          return reject(new Error(`HTTP ${r.statusCode} with ${body ? 'unparseable' : 'empty'} body for ${urlPath}`));
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Invalid JSON from ' + urlPath));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// A DevToolsActivePort file outlives the browser that wrote it: a dead Chrome
// leaves one behind, and trusting the file alone reports that browser as
// debuggable. Check that the port actually accepts a connection.
export function portOpen(port, timeoutMs = 300) {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = ok => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

function devToolsActivePort(port) {
  for (const dir of BROWSERS[PORT_TO_KEY[port]]?.dataDirs ?? []) {
    const f = path.join(dir, 'DevToolsActivePort');
    if (!fs.existsSync(f)) continue;
    const [filePort, wsPath] = fs.readFileSync(f, 'utf8').trim().split('\n');
    if (parseInt(filePort, 10) === port && wsPath) return `ws://127.0.0.1:${port}${wsPath}`;
  }
  return null;
}

// Resolve the browser-level WebSocket URL for a port, or throw with the exact
// command that would make this port debuggable.
export async function browserWsUrl(port) {
  try {
    const v = await httpGetJson(port, '/json/version');
    if (v.webSocketDebuggerUrl) {
      // A forwarded Chrome endpoint can advertise its remote loopback port.
      // Stay on the caller-selected tunnel instead of accidentally attaching to
      // another local browser on that advertised port. Keep path and query intact.
      const url = new URL(v.webSocketDebuggerUrl);
      if (url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        url.hostname = '127.0.0.1';
        url.port = String(port);
      }
      return url.href;
    }
  } catch {
    /* fall through to DevToolsActivePort */
  }
  const fromFile = devToolsActivePort(port);
  if (fromFile && (await portOpen(port))) return fromFile;

  const key = PORT_TO_KEY[port];
  const hint = key ? `\n  Enable it: ${BROWSERS[key].enable}` : '';
  throw new Error(`No browser is debuggable on port ${port}.${hint}\n  See what is: cdp browsers`);
}

function daemonAlive(port) {
  return new Promise(resolve => {
    const sock = net.connect(SOCK(port));
    const done = ok => {
      sock.destroy();
      resolve(ok);
    };
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
    setTimeout(() => done(false), 300);
  });
}

function runningApps() {
  return new Promise(resolve => {
    const windows = process.platform === 'win32';
    const command = windows ? 'powershell.exe' : '/bin/ps';
    const args = windows
      ? ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object -ExpandProperty ExecutablePath']
      : ['-Ao', 'command'];
    execFile(command, args, { maxBuffer: 8 << 20 }, (err, stdout) => {
      if (err) return resolve('');
      resolve(stdout);
    });
  });
}

// Full picture: every known browser, whether it is running, whether it is
// debuggable, how many tabs it has, and whether a daemon already holds it.
export async function listBrowsers() {
  const ps = await runningApps();
  const out = [];
  for (const [key, meta] of Object.entries(BROWSERS)) {
    const running = process.platform === 'win32'
      ? ps.toLowerCase().includes(({chrome:'chrome.exe',dia:'dia.exe',brave:'brave.exe',edge:'msedge.exe',chromium:'chrome.exe',arc:'arc.exe'})[key])
      : process.platform === 'darwin'
        ? ps.includes(`/${meta.app}.app/Contents/MacOS/`)
        : ps.toLowerCase().includes(({chrome:'google-chrome',dia:'dia',brave:'brave',edge:'msedge',chromium:'chromium',arc:'arc'})[key]);
    let ws = null;
    try {
      ws = await browserWsUrl(meta.port);
    } catch {
      ws = null;
    }
    let tabs = null;
    let profiles = [];
    if (ws) {
      try {
        const list = await httpGetJson(meta.port, '/json/list');
        const pages = list.filter(t => t.type === 'page');
        tabs = pages.length;
        profiles = [...new Set(list.map(t => t.description).filter(Boolean))];
      } catch {
        /* toggle-mode Chrome: counted later via Target.getTargets by the caller */
      }
    }
    out.push({
      key,
      label: meta.label,
      port: meta.port,
      running,
      debuggable: Boolean(ws),
      daemon: ws ? await daemonAlive(meta.port) : false,
      tabs,
      profiles,
      enable: meta.enable,
    });
  }
  return out;
}

export function resolveBrowserArg({ browser, port }) {
  if (port) return parseInt(port, 10);
  if (browser) {
    const key = String(browser).toLowerCase();
    if (!BROWSERS[key]) {
      throw new Error(`Unknown browser "${browser}". Known: ${Object.keys(BROWSERS).join(', ')}`);
    }
    return BROWSERS[key].port;
  }
  return null;
}

// No implicit default, ever. An agent that does not say which browser it means
// gets the list instead of silently driving the wrong one.
export async function requireBrowser({ browser, port }) {
  const explicit = resolveBrowserArg({ browser, port });
  if (explicit) return explicit;
  const all = await listBrowsers();
  const live = all.filter(b => b.debuggable);
  const lines = live.length
    ? live.map(b => `  --browser ${b.key}   (:${b.port}, ${b.tabs ?? '?'} tabs${b.daemon ? ', daemon up' : ''})`)
    : all.filter(b => b.running).map(b => `  ${b.label} is running but not debuggable -> ${b.enable}`);
  throw new Error(
    'No browser specified. Pass --browser <name> or --port <n>.\n' +
      (lines.length ? 'Debuggable now:\n' + lines.join('\n') : 'No Chromium-family browser is running.') +
      '\nFull picture: cdp browsers',
  );
}

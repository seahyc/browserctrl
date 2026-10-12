// Test rig: a throwaway headless Chrome on its own port and user-data-dir, plus
// a local static server for the fixture page. Never touches a real profile.
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEST_PORT = 9333;

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
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/slow')) {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1 id="slow">slow page</h1></body></html>');
      }, 400);
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
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}/`, close: () => new Promise(r => server.close(r)) };
}

export async function startHeadlessBrowser(port = TEST_PORT) {
  const bin = chromeBinary();
  if (!bin) return null;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-test-profile-'));
  const child = spawn(
    bin,
    [
      '--headless=new',
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
      else if (signal === 'SIGKILL') execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true});
      else child.kill(signal);
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

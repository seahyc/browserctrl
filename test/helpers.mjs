// Test rig: a throwaway headless Chrome on its own port and user-data-dir, plus
// a local static server for the fixture page. Never touches a real profile.
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEST_PORT = 9333;

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

export function chromeBinary() {
  return CHROME_CANDIDATES.find(p => fs.existsSync(p)) || null;
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
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );
  // Wait for the debug endpoint to answer.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
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
    if (ok) break;
    await new Promise(r => setTimeout(r, 200));
  }
  return {
    child,
    port,
    userDataDir,
    close: () => {
      try {
        child.kill('SIGKILL');
      } catch {}
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

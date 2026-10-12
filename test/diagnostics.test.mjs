import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { afterEach, test } from 'node:test';

import { codeVersion } from '../lib/daemon.mjs';
import { diagnose } from '../lib/diagnostics.mjs';
import { SOCK } from '../lib/env.mjs';

const cleanups = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function fakeBrowser({ delayMs = 0 } = {}) {
  const server = http.createServer((request, response) => {
    if (request.url !== '/json/version') {
      response.writeHead(404).end();
      return;
    }
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/fake' }));
    }, delayMs);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanups.push(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

async function fakeDaemon(port, health) {
  const socketPath = SOCK(port);
  try {
    fs.unlinkSync(socketPath);
  } catch {}
  const requests = [];
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline));
      requests.push(request);
      socket.write(JSON.stringify({ reqId: request.reqId, result: health }) + '\n');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(
    () =>
      new Promise(resolve => {
        server.close(() => {
          try {
            fs.unlinkSync(socketPath);
          } catch {}
          resolve();
        });
      }),
  );
  return requests;
}

test('requires an explicit browser or port without probing anything', async () => {
  assert.deepEqual(await diagnose(), {
    schemaVersion: 1,
    ok: false,
    browser: null,
    port: null,
    checks: [
      {
        name: 'selector',
        ok: false,
        detail: 'Specify exactly which endpoint to inspect with browser or port.',
      },
    ],
    warnings: [],
  });
});

test('reachable browser with no daemon is healthy with an actionable warning', async () => {
  const port = await fakeBrowser();
  const socketPath = SOCK(port);
  try {
    fs.unlinkSync(socketPath);
  } catch {}

  const report = await diagnose({ port });

  assert.equal(report.schemaVersion, 1);
  assert.ok(report.connections.connections.every(client => client.pid !== process.pid), 'doctor excludes its own discovery connection');
  assert.equal(report.ok, true);
  assert.equal(report.port, port);
  assert.equal(report.checks.find(check => check.name === 'browserEndpoint').ok, true);
  assert.equal(report.checks.find(check => check.name === 'daemon').ok, false);
  assert.match(report.warnings[0], /next SDK or CLI operation will start/);
  assert.equal(fs.existsSync(socketPath), false, 'diagnostics must not start a daemon');
  assert.doesNotMatch(JSON.stringify(report), /devtools\/browser|webSocketDebuggerUrl/);
});

test('reports a healthy current daemon after sending only a health request', async () => {
  const port = await fakeBrowser();
  const requests = await fakeDaemon(port, {
    ok: true,
    connected: true,
    browser: 'Fake/1',
    code: codeVersion(),
  });

  const report = await diagnose({ port });

  assert.equal(report.ok, true);
  assert.equal(report.checks.find(check => check.name === 'daemon').ok, true);
  assert.equal(report.checks.find(check => check.name === 'daemonVersion').ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].op, 'health');
  assert.deepEqual(Object.keys(requests[0]).sort(), ['op', 'reqId', 'timeoutMs']);
});

test('distinguishes a reachable browser from a stale daemon version', async () => {
  const port = await fakeBrowser();
  await fakeDaemon(port, { ok: true, connected: true, browser: 'Fake/1', code: 'old-code' });

  const report = await diagnose({ port });

  assert.equal(report.ok, true, 'browser reachability defines top-level health');
  assert.equal(report.checks.find(check => check.name === 'browserEndpoint').ok, true);
  assert.equal(report.checks.find(check => check.name === 'daemon').ok, true);
  assert.equal(report.checks.find(check => check.name === 'daemonVersion').ok, false);
  assert.match(report.warnings[0], /replace the stale daemon automatically/);
});

test('invalid ports fail as selector errors', async () => {
  for (const port of ['not-a-port', '9222junk', 0, 65536]) {
    const report = await diagnose({ port });
    assert.equal(report.ok, false);
    assert.equal(report.checks[0].name, 'selector');
    assert.match(report.checks[0].detail, /integer between 1 and 65535/);
  }
});


test('slow discovery beyond the former 700ms deadline still identifies the selected browser', async () => {
  const port = await fakeBrowser({ delayMs: 1200 });
  const report = await diagnose({ port });
  assert.equal(report.ok, true);
  assert.equal(report.checks.find(check => check.name === 'browserEndpoint').ok, true);
  assert.equal(fs.existsSync(SOCK(port)), false, 'discovery must not start a daemon');
});

// A browser that refuses the debugging WebSocket outright (Chrome on its
// profile picker, or after a dismissed Allow prompt) must fail the client in
// seconds with what to do, not after the five-minute approval timeout.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { connect, startupFailureMessage } from '../lib/daemon.mjs';

const server = http.createServer((req, res) => {
  const { port } = server.address();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ Browser: 'Chrome/155', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x` }));
});
server.on('upgrade', (req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 19\r\n\r\nConnection rejected'));
after(() => new Promise(r => server.close(r)));

test('a refused debugging connection fails fast with the way out', async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const started = Date.now();
  await assert.rejects(connect(server.address().port), /refused the debugging connection.*open a browser window.*click Allow/s);
  assert.ok(Date.now() - started < 15000, `took ${Date.now() - started}ms`);
});

test('timeouts and other startup failures get their own messages', () => {
  assert.match(startupFailureMessage({ reason: 'timeout' }), /did not accept the debugging connection in time/);
  assert.match(startupFailureMessage({ reason: 'error', message: 'boom' }), /could not start: boom/);
});

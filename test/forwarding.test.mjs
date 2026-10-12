import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {browserWsUrl} from '../lib/discovery.mjs';

test('forwarded discovery stays on explicitly selected loopback port', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/fixture?transport=1'}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    assert.equal(await browserWsUrl(port), `ws://127.0.0.1:${port}/devtools/browser/fixture?transport=1`);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

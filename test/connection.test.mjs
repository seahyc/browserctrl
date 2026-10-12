import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { afterEach, test } from 'node:test';

import { codeVersion, connect } from '../lib/daemon.mjs';
import { SOCK } from '../lib/env.mjs';

let sequence = 0;
const cleanups = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function fakeDaemon(handle) {
  const port = 30000 + (process.pid % 10000) + sequence++;
  const socketPath = SOCK(port);
  try {
    fs.unlinkSync(socketPath);
  } catch {}
  const seen = [];
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        seen.push(request);
        if (request.op === 'health' || (request.op === 'status' && request.reqId === 0)) {
          socket.write(
            JSON.stringify({
              reqId: request.reqId,
              result: { ok: true, connected: true, browser: 'Fake/1', code: codeVersion() },
            }) + '\n',
          );
        } else {
          handle({ request, socket, seen });
        }
      }
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
  return { port, seen };
}

test('disconnect rejects an in-flight request without replaying it', async () => {
  const fake = await fakeDaemon(({ socket }) => socket.destroy());
  const client = await connect(fake.port);
  cleanups.push(async () => client.close());

  await assert.rejects(
    client.browser('Browser.close'),
    error => /outcome is uncertain/.test(error.message) && /not replayed/.test(error.message),
  );
  assert.equal(fake.seen.filter(request => request.op === 'browser').length, 1);
});

test('IPC deadline rejects an unanswered request without replaying it', async () => {
  const fake = await fakeDaemon(() => {});
  const client = await connect(fake.port);
  cleanups.push(async () => client.close());

  await assert.rejects(
    client.browser('Browser.getVersion', {}, 20),
    error => /IPC request timed out after \d+ms/.test(error.message) && /not replayed/.test(error.message),
  );
  assert.equal(fake.seen.filter(request => request.op === 'browser').length, 1);
});

test('malformed daemon JSON rejects pending requests instead of throwing', async () => {
  const fake = await fakeDaemon(({ socket }) => socket.write('{broken json}\n'));
  const client = await connect(fake.port);
  cleanups.push(async () => client.close());

  await assert.rejects(client.status(), /malformed IPC data.*none were replayed/);
});

test('valid JSON with an invalid response shape rejects pending requests instead of throwing', async () => {
  const fake = await fakeDaemon(({ socket }) => socket.write('null\n'));
  const client = await connect(fake.port);
  cleanups.push(async () => client.close());

  await assert.rejects(client.status(), /malformed IPC data.*none were replayed/);
});

test('explicit reconnect serves later requests and never replays the lost request', async () => {
  let requests = 0;
  const fake = await fakeDaemon(({ request, socket }) => {
    requests += 1;
    if (requests === 1) {
      socket.destroy();
      return;
    }
    socket.write(JSON.stringify({ reqId: request.reqId, result: { port: fake.port } }) + '\n');
  });
  const client = await connect(fake.port);
  cleanups.push(async () => client.close());

  await assert.rejects(client.status(), /not replayed/);
  await client.reconnect();
  assert.deepEqual(await client.status(), { port: fake.port });
  assert.equal(requests, 2, 'the first request must not be replayed during reconnect');
});

test('explicit reconnect can replace a healthy socket for subsequent requests', async () => {
  let requests = 0;
  const fake = await fakeDaemon(({ request, socket }) => {
    requests += 1;
    socket.write(JSON.stringify({ reqId: request.reqId, result: requests }) + '\n');
  });
  const client = await connect(fake.port);
  cleanups.push(async () => client.close());

  assert.equal(await client.status(), 1);
  await client.reconnect();
  assert.equal(await client.status(), 2);
});

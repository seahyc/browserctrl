import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { codeVersion, connect } from '../lib/daemon.mjs';
import { SOCK } from '../lib/env.mjs';

let sequence = 0;
const cleanups = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function fakeDaemon(handle, health = () => ({ ok: true, connected: true, browser: 'Fake/1', code: codeVersion() })) {
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
              result: health(),
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

const compatibleOldDaemon = () => ({
  ok: true, connected: true, code: 'older', pid: 1234,
  cooperativeUpgrade: 1, vaultEntry: 1, vaultFill: 1,
});

async function withDeferredUpgrade(value, run) {
  const old = process.env.BROWSERCTRL_DEFER_UPGRADE;
  if (value === undefined) delete process.env.BROWSERCTRL_DEFER_UPGRADE;
  else process.env.BROWSERCTRL_DEFER_UPGRADE = value;
  try { await run(); }
  finally {
    if (old === undefined) delete process.env.BROWSERCTRL_DEFER_UPGRADE;
    else process.env.BROWSERCTRL_DEFER_UPGRADE = old;
  }
}

test('explicit deferred upgrade reuses only the protected compatible daemon', async () => {
  await withDeferredUpgrade('1', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-transport-'));
    const spawnLog = path.join(directory, 'spawn.jsonl');
    const oldLog = process.env.BROWSERCTRL_TEST_DAEMON_LOG;
    process.env.BROWSERCTRL_TEST_DAEMON_LOG = spawnLog;
    cleanups.push(async () => {
      if (oldLog === undefined) delete process.env.BROWSERCTRL_TEST_DAEMON_LOG;
      else process.env.BROWSERCTRL_TEST_DAEMON_LOG = oldLog;
      fs.rmSync(directory, {recursive: true, force: true});
    });
    const fake = await fakeDaemon(({request, socket}) => {
      socket.write(JSON.stringify({reqId: request.reqId, result: {from: 'existing'}}) + '\n');
    }, compatibleOldDaemon);
    const client = await connect(fake.port, {owner: 'test-owner', label: 'test', mediated: true});
    cleanups.push(async () => client.close());
    assert.deepEqual(await client.status(), {from: 'existing'});
    assert.deepEqual(fake.seen.map(r => r.op), ['status', 'status']);
    assert.equal(fake.seen[1].owner, 'test-owner');
    assert.equal(fake.seen[1].label, 'test');
    assert.equal(fake.seen.some(r => ['upgrade', 'stop', 'vault-fill', 'browser'].includes(r.op)), false);
    assert.equal(fs.existsSync(spawnLog), false, 'no replacement daemon was spawned');
    assert.equal(fake.seen.some(r => Object.keys(r).some(k => /bypass|ignore.*gate|disable.*protect/i.test(k))), false);
  });
});

test('without explicit opt-in a drifted daemon still receives a cooperative upgrade request', async () => {
  await withDeferredUpgrade(undefined, async () => {
    const fake = await fakeDaemon(({request, socket}) => {
      socket.write(JSON.stringify({reqId: request.reqId, result: 'busy'}) + '\n');
    }, compatibleOldDaemon);
    await assert.rejects(connect(fake.port), /Daemon upgrade deferred/);
    assert.deepEqual(fake.seen.map(r => r.op), ['status', 'upgrade']);
  });
});

test('opt-in does not reuse an old daemon without both protection capabilities', async () => {
  for (const missing of ['vaultEntry', 'vaultFill', 'cooperativeUpgrade']) {
    await withDeferredUpgrade('1', async () => {
      const fake = await fakeDaemon(({request, socket}) => {
        socket.write(JSON.stringify({reqId: request.reqId, result: 'busy'}) + '\n');
      }, () => ({...compatibleOldDaemon(), [missing]: 0}));
      await assert.rejects(connect(fake.port), /Daemon upgrade deferred|does not support a safe cooperative upgrade/);
      assert.equal(fake.seen[0].op, 'status');
      assert.equal(fake.seen.some(r => r.op === 'browser'), false);
      if (missing === 'cooperativeUpgrade') assert.deepEqual(fake.seen.map(r => r.op), ['status']);
      else assert.deepEqual(fake.seen.map(r => r.op), ['status', 'upgrade']);
    });
  }
});

test('opt-in never reuses an unhealthy daemon', async () => {
  await withDeferredUpgrade('1', async () => {
    let probes = 0;
    const fake = await fakeDaemon(({request, socket}) => {
      socket.write(JSON.stringify({reqId: request.reqId, result: 'healthy'}) + '\n');
    }, () => ++probes === 1 ? {...compatibleOldDaemon(), ok: false, starting: true} :
      {ok: true, code: codeVersion()});
    const client = await connect(fake.port);
    cleanups.push(async () => client.close());
    assert.equal(await client.status(), 'healthy');
    assert.equal(probes, 2);
    assert.deepEqual(fake.seen.map(r => r.op), ['status', 'status', 'status']);
  });
});

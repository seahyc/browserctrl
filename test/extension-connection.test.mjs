import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { codeVersion } from '../lib/daemon.mjs';
import { SOCK, withAgentIdentity } from '../lib/env.mjs';
import { evaluate, findWorker, info } from '../lib/ext.mjs';

async function fakeDaemon(t) {
  // Reserve an unused port identity; this server only speaks IPC, never CDP.
  const reserve = net.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  const requests = [], sockets = new Set();
  let failure;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const req = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        requests.push(req);
        let result, error;
        if (req.op === 'health' || req.op === 'status') result = { ok: true, code: codeVersion() };
        else if (req.op === 'browser' && req.method === 'Target.getTargets') {
          result = { targetInfos: [
            { targetId: 'page', type: 'page', url: 'https://example.test' },
            { targetId: 'worker', type: 'service_worker', url: 'chrome-extension://fixture/worker.js', title: 'Fixture' },
            { targetId: 'web-worker', type: 'service_worker', url: 'https://example.test/sw.js' },
          ] };
        } else if (req.op === 'cdp' && req.method === 'Runtime.evaluate') {
          if (failure) error = failure;
          else if (req.params.expression.includes('__cdpAgentBrowser')) result = { result: { value: '{"version":1}' } };
          else if (req.params.expression.includes('chrome.runtime')) result = { result: { value: '{"id":"fixture","permissions":["tabs"]}' } };
          else if (req.params.expression.includes('throwTest')) result = { exceptionDetails: { exception: { description: 'Error: fixture exception' } } };
          else result = { result: { value: '{"answer":42}' } };
        } else error = 'Unexpected IPC request';
        socket.write(JSON.stringify({ reqId: req.reqId, result, error }) + '\n');
      }
    });
  });
  await new Promise(resolve => server.listen(SOCK(port), resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => reserve.close(resolve));
  });
  return { port, requests, fail: value => { failure = value; } };
}

test('extension discovery and evaluation reuse daemon IPC and preserve concurrent agent identities', async t => {
  const { port, requests } = await fakeDaemon(t);
  const answers = await Promise.all(['agent-a', 'agent-b'].map(owner =>
    withAgentIdentity(owner, () => evaluate(port, '({answer:42})', { timeoutMs: 3210 }))));
  assert.deepEqual(answers, [{answer:42}, {answer:42}]);
  for (const owner of ['agent-a', 'agent-b']) {
    const own = requests.filter(r => r.owner === owner);
    assert.equal(own.filter(r => r.method === 'Target.getTargets').length, 1);
    const evaluations = own.filter(r => r.method === 'Runtime.evaluate');
    assert.equal(evaluations.length, 2);
    assert.ok(evaluations.every(r => r.targetId === 'worker' && r.light === true));
    assert.equal(evaluations[1].timeoutMs, 3210);
    assert.equal(evaluations[1].params.awaitPromise, true);
    assert.equal(evaluations[1].params.returnByValue, true);
  }
  const worker = await findWorker(port, { retries: 0 });
  assert.equal(worker.id, 'worker');
  assert.deepEqual(worker.marker, {version:1});
  assert.deepEqual(await info(port), {id:'fixture', permissions:['tabs']});
});

test('extension ownership refusals propagate instead of reporting not installed', async t => {
  const daemon = await fakeDaemon(t);
  for (const message of ['Tab worker is claimed by other-agent', 'Browser-wide control is blocked while a tab is claimed by other-agent']) {
    daemon.fail(message);
    await assert.rejects(findWorker(daemon.port, {retries:0}), error => error.message === message);
  }
});

test('extension evaluation preserves worker exception details', async t => {
  const { port } = await fakeDaemon(t);
  await assert.rejects(evaluate(port, 'throwTest()'), /Error: fixture exception/);
});

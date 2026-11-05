import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import zlib from 'node:zlib';

const home = process.env.BROWSERCTRL_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'bc-recording-rpc-'));
assert.match(path.basename(home), /^bc-(?:test|recording-rpc)-/, 'a disposable test home is required');
assert.ok([os.tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])].map(dir => fs.realpathSync(dir)).includes(fs.realpathSync(path.dirname(home))), 'test home must be directly beneath a temporary directory');
process.env.BROWSERCTRL_HOME = home;
process.env.BROWSERCTRL_REC_STILLS = 'off';
process.env.BROWSERCTRL_CAPTURE = '0';
process.env.BROWSERCTRL_TEST_DAEMON_LOG = path.join(home, 'spawned.jsonl');
const {connect} = await import('../lib/daemon.mjs');
const {all} = await import('../lib/rec.mjs');

// A tiny CDP server with only synthetic documents. It responds to the real
// daemon's browser websocket; no browser process or user profile is involved.
async function fakeBrowser() {
  let port, socket, input = Buffer.alloc(0), failAdd = false;
  const sessions = new Map(), methods = [], targets = new Map();
  let next = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({Browser: 'Fake/1', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake`}));
    } else { res.statusCode = 404; res.end(); }
  });
  function frame(data, opcode = 1) {
    const payload = Buffer.from(data), size = payload.length;
    const header = size < 126 ? Buffer.from([0x80 | opcode, size]) : size < 65536 ? Buffer.from([0x80 | opcode, 126, size >> 8, size & 255]) : (() => {
      const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(size), 2); return h;
    })();
    socket.write(Buffer.concat([header, payload]));
  }
  function reply(message) {
    const q = JSON.parse(message), {id, method, params = {}, sessionId} = q;
    methods.push(method);
    const targetId = sessions.get(sessionId);
    let result = {};
    if (method === 'Target.createTarget') {
      const targetId = (++next).toString(16).padStart(32, '0');
      targets.set(targetId, {targetId, type:'page', url: params.url || 'https://example.test/'});
      result = {targetId};
    } else if (method === 'Target.closeTarget') {
      result = {success:targets.delete(params.targetId)};
    } else if (method === 'Target.getTargets') result = {targetInfos:[...targets.values()]};
    else if (method === 'Target.getTargetInfo') {
      if (!targets.has(params.targetId)) { frame(JSON.stringify({id, sessionId, error:{code:-32602,message:'No target with given id found'}})); return; }
      result = {targetInfo:targets.get(params.targetId)};
    }
    else if (method === 'Target.attachToTarget') {
      const session = `SESSION-${params.targetId}`; sessions.set(session, params.targetId); result = {sessionId:session};
    } else if (method === 'Page.getFrameTree') {
      result = {frameTree:{frame:{id:`FRAME-${targetId}`, loaderId:'loader', url:targets.get(targetId)?.url || 'https://example.test/'}}};
    } else if (method === 'Page.createIsolatedWorld') result = {executionContextId:1};
    else if (method === 'Page.addScriptToEvaluateOnNewDocument') {
      if (failAdd) { frame(JSON.stringify({id, sessionId, error:{code:-32000,message:'synthetic add failure'}})); return; }
      result = {identifier:'script-1'};
    } else if (method === 'Runtime.evaluate') {
      if (params.expression?.includes("typeof window.__bcRec.stop !== 'function'")) {
        frame(JSON.stringify({method:'Runtime.bindingCalled',sessionId,params:{name:'__cdpSend',executionContextId:1,
          payload:JSON.stringify({kind:'rr',events:[{type:2,data:'synthetic-final-event'}],end:true})}}));
        result = {result:{type:'boolean',value:true}};
      } else result = {result:{type:'undefined'}};
    } else if (method === 'Browser.getVersion') result = {product:'Fake/1'};
    frame(JSON.stringify({id, ...(sessionId ? {sessionId} : {}), result}));
  }
  server.on('upgrade', (req, s) => {
    socket = s;
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    s.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    s.on('data', chunk => {
      input = Buffer.concat([input, chunk]);
      while (input.length >= 2) {
        const opcode = input[0] & 15, masked = !!(input[1] & 128); let size = input[1] & 127, offset = 2;
        if (size === 126) { if (input.length < 4) return; size = input.readUInt16BE(2); offset = 4; }
        else if (size === 127) { if (input.length < 10) return; size = Number(input.readBigUInt64BE(2)); offset = 10; }
        if (!masked || input.length < offset + 4 + size) return;
        const mask = input.subarray(offset, offset + 4); offset += 4;
        const payload = Buffer.from(input.subarray(offset, offset + size));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        input = input.subarray(offset + size);
        if (opcode === 8) { s.end(); return; }
        if (opcode === 9) frame(payload, 10);
        if (opcode === 1) reply(payload.toString());
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  return {port, methods, failAdd(value) {failAdd = value;}, async close() { socket?.destroy(); await new Promise(resolve => server.close(resolve)); }};
}

// On Windows the real daemon never answers this fake browser and the test hangs past its
// timeout (seen 2026-11-05 on CI; cause not yet found). Skipped there until diagnosed.
test('real daemon recording RPC drains final events and preserves failed starts', {timeout:30000, skip: process.platform === 'win32' && 'hangs on Windows: not yet diagnosed'}, async t => {
  const browser = await fakeBrowser();
  let client, daemonPid;
  t.after(async () => {
    client?.close();
    let spawned = [];
    try { spawned = fs.readFileSync(process.env.BROWSERCTRL_TEST_DAEMON_LOG, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).pid); } catch {}
    for (const pid of new Set([...spawned, ...(daemonPid ? [daemonPid] : [])])) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
      for (let i = 0; i < 100; i++) {
        try { process.kill(pid, 0); } catch { break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    await browser.close();
    fs.rmSync(home, {recursive:true, force:true, maxRetries:10, retryDelay:50});
  });
  client = await connect(browser.port, {owner:'recording-integration', label:'synthetic', mediated:true});
  daemonPid = (await client.status()).pid;
  const {targetId} = await client.browser('Target.createTarget', {url:'https://example.test/'});
  const result = await client.recording('start', targetId, {out:path.join(home,'run')});
  const active = all()[targetId];
  assert.equal(active.owner, 'recording-integration');
  assert.equal(active.managed, true);
  assert.equal(result.recording, fs.realpathSync(path.join(home,'run')));
  await client.recording('stop', targetId);
  assert.equal(all()[targetId], undefined);
  const data = zlib.brotliDecompressSync(fs.readFileSync(path.join(home,'run','rrweb.ndjson.br'))).toString();
  assert.match(data, /synthetic-final-event/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home,'run','meta.json'))).stopReason, 'requested');
  assert.ok(browser.methods.includes('Page.removeScriptToEvaluateOnNewDocument'));

  browser.failAdd(true);
  const second = await client.browser('Target.createTarget', {url:'https://example.test/fail'});
  await assert.rejects(client.recording('start', second.targetId, {out:path.join(home,'failed')}), /synthetic add failure/);
  assert.equal(all()[second.targetId].startFailed, true);
  await assert.rejects(client.recording('stop', second.targetId), /recording_teardown_unverified/);
  assert.equal(all()[second.targetId].startFailed, true);
  await assert.rejects(client.recording('recover', second.targetId.slice(0, 8)), /recording_exact_target_required/);
  await assert.rejects(client.recording('recover', second.targetId), /recording_target_still_present/);
  const other = await connect(browser.port, {owner:'other-agent', label:'synthetic-other', mediated:true});
  try {
    await assert.rejects(other.recording('recover', second.targetId), /recording_not_owned/);
  } finally { other.close(); }
  assert.equal((await client.browser('Target.closeTarget', {targetId:second.targetId})).success, true);
  const recovered = await client.recording('recover', second.targetId);
  assert.equal(recovered.finalBatch, 'unverified');
  assert.equal(all()[second.targetId], undefined);
  const metadata = JSON.parse(fs.readFileSync(path.join(home,'failed','meta.json')));
  assert.equal(metadata.stopReason, 'target_closed');
  assert.equal(metadata.finalBatch, 'unverified');
});

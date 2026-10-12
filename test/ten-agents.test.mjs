import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test, before, after } from 'node:test';
import { startHeadlessBrowser, chromeBinary } from './helpers.mjs';
const exec = promisify(execFile);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-ten-agents-'));
process.env.CDP_CLAIMS_FILE = path.join(dir, 'claims.json');
const { connect } = await import('../lib/daemon.mjs');
const moduleUrl = new URL('../lib/daemon.mjs', import.meta.url).href;
let browser, port;
before(async () => {
  if (!chromeBinary()) return;
  const reserve = net.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  browser = await startHeadlessBrowser(port);
});
after(async () => {
  if (browser) {
    const client = await connect(port);
    await client.stop(); client.close(); browser.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
const options = { skip: !chromeBinary(), timeout: 120000 };

test('ten independent agents operate distinct tabs through one shared daemon', options, async () => {
  const results = await Promise.all(Array.from({ length: 10 }, (_, n) => exec(process.execPath, ['--input-type=module', '-e', `
    import {connect} from ${JSON.stringify(moduleUrl)};
    const ops = await import(${JSON.stringify(new URL('../lib/ops.mjs', import.meta.url).href)});
    const c = await connect(${port});
    try {
      const {targetId} = await c.browser('Target.createTarget', {url:'about:blank', background:true});
      await c.send(targetId,'Runtime.evaluate',{expression:'document.body.innerHTML = \`<input id="value"><button id="go" onclick="globalThis.clicked = true">Go</button>\`; document.body.style.height="5000px"'});
      await ops.fill(c,targetId,{selector:'#value',value:'agent-${n}'});
      await ops.click(c,targetId,{selector:'#go'});
      await ops.scroll(c,targetId,{deltaY:400});
      const ui = await c.send(targetId,'Runtime.evaluate',{expression:'JSON.stringify({value:document.querySelector("#value").value,clicked:globalThis.clicked,scrolled:scrollY>0})',returnByValue:true});
      const checked = JSON.parse(ui.result.value);
      if(checked.value !== 'agent-${n}' || !checked.clicked || !checked.scrolled) throw Error(JSON.stringify(checked));
      for(let i=0;i<5;i++) await c.send(targetId,'Runtime.evaluate',{expression:'globalThis.agent = ${n}; globalThis.count = (globalThis.count || 0) + 1'});
      const result = await c.send(targetId,'Runtime.evaluate',{expression:'JSON.stringify({agent:globalThis.agent,count:globalThis.count})',returnByValue:true});
      console.log(JSON.stringify({targetId,pid:(await c.health()).pid,...JSON.parse(result.result.value)}));
      await c.browser('Target.closeTarget',{targetId});
    } finally {c.close();}
  `], { env: { ...process.env, CDP_AGENT_ID: `worker-${n}` } })));
  const rows = results.map(result => JSON.parse(result.stdout));
  assert.equal(new Set(rows.map(row => row.pid)).size, 1);
  assert.equal(new Set(rows.map(row => row.targetId)).size, 10);
  rows.forEach((row, n) => assert.deepEqual({ agent: row.agent, count: row.count }, { agent: n, count: 5 }));
});

test('another agent cannot evaluate, navigate, close, or detach an owned tab', options, async () => {
  const a = await connect(port, { owner: 'owner-a' });
  const b = await connect(port, { owner: 'owner-b' });
  try {
    const { targetId } = await a.browser('Target.createTarget', { url: 'about:blank' });
    await assert.rejects(b.send(targetId, 'Runtime.evaluate', { expression: 'globalThis.intruder = true' }), /claimed by/);
    await assert.rejects(b.send(targetId, 'Page.navigate', { url: 'about:blank#intruder' }), /claimed by/);
    await assert.rejects(b.browser('Target.closeTarget', { targetId }), /claimed by/);
    await assert.rejects(b.detach(targetId), /claimed by/);
    const result = await a.send(targetId, 'Runtime.evaluate', { expression: 'globalThis.intruder', returnByValue: true });
    assert.equal(result.result.type, 'undefined');
    await a.browser('Target.closeTarget', { targetId });
  } finally { a.close(); b.close(); }
});

test('agents sharing one MCP server keep distinct identities across concurrent requests', options, async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL('../mcp/server.mjs', import.meta.url).pathname],
    env: { ...process.env },
  });
  const client = new Client({ name: 'ten-agent-test', version: '1' });
  await client.connect(transport);
  const callTool = args => client.callTool(args, undefined, { timeout: 120000 });
  try {
    const rows = await Promise.all(Array.from({ length: 10 }, async (_, n) => {
      const result = await callTool({ name: 'browser_open', arguments: { port, agentId: `mcp-${n}`, url: 'about:blank', until: 'none' } });
      assert.ok(!result.isError, JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    }));
    const writes = await Promise.all(rows.map((row, n) => callTool({ name: 'browser_eval', arguments: {
      port, agentId: `mcp-${n}`, tab: row.targetId, js: `globalThis.worker = ${n}`,
    } })));
    assert.ok(writes.every(result => !result.isError), JSON.stringify(writes));
    const refused = await callTool({ name: 'browser_eval', arguments: {
      port, agentId: 'mcp-1', tab: rows[0].targetId, js: 'globalThis.worker = 99',
    } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /claimed by/);
    await Promise.all(rows.map((row, n) => callTool({ name: 'browser_close', arguments: { port, agentId: `mcp-${n}`, tab: row.targetId } })));
  } finally { await client.close(); }
});


test('browser-wide worker actions reserve the browser until they finish', options, async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/sw.js' ? 'application/javascript' : 'text/html');
    res.end(req.url === '/sw.js' ? 'self.addEventListener("install", () => self.skipWaiting());' : '<html>worker fixture</html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const a = await connect(port, { owner: 'global-a' });
  const b = await connect(port, { owner: 'global-b' });
  try {
    const { targetId } = await a.browser('Target.createTarget', { url });
    await a.send(targetId, 'Runtime.evaluate', {
      expression: 'navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready)', awaitPromise: true,
    });
    const { targetInfos } = await a.browser('Target.getTargets');
    const worker = targetInfos.find(target => target.type === 'service_worker' && target.url === `${url}/sw.js`);
    assert.ok(worker);
    const pending = a.send(worker.targetId, 'Runtime.evaluate', {
      expression: 'globalThis.held = true; new Promise(resolve => globalThis.release = resolve)', awaitPromise: true,
    });
    const deadline = Date.now() + 3000;
    let ready = false;
    while (Date.now() < deadline) {
      const r = await a.send(worker.targetId, 'Runtime.evaluate', { expression: 'globalThis.held', returnByValue: true });
      if (r.result.value) { ready = true; break; }
    }
    assert.ok(ready);
    await assert.rejects(b.browser('Target.createTarget', { url: 'about:blank' }), /Browser-wide control is blocked/);
    await a.send(worker.targetId, 'Runtime.evaluate', { expression: 'globalThis.release()' });
    await pending;
    const second = await b.browser('Target.createTarget', { url: 'about:blank' });
    await b.browser('Target.closeTarget', { targetId: second.targetId });
    await a.browser('Target.closeTarget', { targetId });
  } finally {
    a.close(); b.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

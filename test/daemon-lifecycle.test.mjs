import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { connect } from '../lib/daemon.mjs';
import { SOCK } from '../lib/env.mjs';
import { startHeadlessBrowser, chromeBinary } from './helpers.mjs';

const exec = promisify(execFile);
const daemonModule = new URL('../lib/daemon.mjs', import.meta.url).href;

async function fixture(t) {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const browser = await startHeadlessBrowser(port);
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-lifecycle-'));
  const trace = path.join(traceDir, 'trace.jsonl');
  const previousTrace = process.env.CDP_DIAGNOSTIC_LOG;
  process.env.CDP_DIAGNOSTIC_LOG = trace;
  t.after(async () => {
    if (process.platform !== 'win32') browser.child.kill('SIGCONT');
    const { stdout } = await daemonProcesses(port);
    for (const line of stdout.split('\n')) {
      if (line.trim().endsWith(`/lib/daemon-run.mjs ${port}`)) {
        try {
          const pid = Number(line.trim().split(/\s+/)[0]);
          if (process.platform !== 'win32') process.kill(pid, 'SIGCONT');
          process.kill(pid, 'SIGTERM');
          const deadline = Date.now() + 1000;
          while (Date.now() < deadline) {
            try { process.kill(pid, 0); } catch { break; }
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          try { process.kill(pid, 'SIGKILL'); } catch {}
        } catch {}
      }
    }
    await browser.close();
    fs.rmSync(traceDir, { recursive: true, force: true });
    if (previousTrace === undefined) delete process.env.CDP_DIAGNOSTIC_LOG;
    else process.env.CDP_DIAGNOSTIC_LOG = previousTrace;
  });
  return { port, browser, trace };
}

async function daemonProcesses(port) {
  if (process.platform !== 'win32') return exec('ps', ['-axo', 'pid=,command=']);
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*daemon-run.mjs ${port}' } | ForEach-Object { "$($_.ProcessId) $($_.CommandLine.Replace('\\','/'))" }`;
  return exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}
async function assertSoleDaemon(port, ownerPid) {
  const deadline = Date.now() + 5000;
  let pids;
  do {
    const { stdout } = await daemonProcesses(port);
    pids = stdout.split('\n').filter(line => line.trim().endsWith(`/lib/daemon-run.mjs ${port}`))
      .map(line => Number(line.trim().split(/\s+/)[0]));
    if (pids.length === 1 && pids[0] === ownerPid) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.deepEqual(pids, [ownerPid], 'losing startup processes must exit, leaving the shared owner');
}

const options = { skip: !chromeBinary(), timeout: process.platform === 'win32' ? 180000 : 60000 };
const posixOptions = { ...options, skip: options.skip || process.platform === 'win32' };
test('independent agents concurrently start and reuse one daemon', options, async t => {
  const { port } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => exec(process.execPath, [
    '--input-type=module', '-e',
    `import {connect} from ${JSON.stringify(daemonModule)}; const c=await connect(${port}); console.log(JSON.stringify(await c.health())); c.close();`,
  ])));
  const health = results.map(result => JSON.parse(result.stdout));
  assert.ok(health.every(result => Number.isInteger(result.pid)));
  assert.equal(new Set(health.map(result => result.pid)).size, 1);
  await assertSoleDaemon(port, health[0].pid);
});

test('a hung tab preserves the browser connection and never replays the command', options, async t => {
  const { port } = await fixture(t);
  const client = await connect(port);
  t.after(() => client.close());
  const before = await client.health();
  const { targetId } = await client.browser('Target.createTarget', { url: 'about:blank' });
  await assert.rejects(client.send(targetId, 'Runtime.evaluate', {
    expression: 'globalThis.calls = (globalThis.calls || 0) + 1; new Promise(() => {})', awaitPromise: true,
  }, 200), /timed out.*uncertain.*not replayed/);
  assert.equal((await client.health()).pid, before.pid);
  const result = await client.send(targetId, 'Runtime.evaluate', { expression: 'globalThis.calls', returnByValue: true });
  assert.equal(result.result.value, 1);
});

test('a hung browser retires its daemon and permits a fresh observation after recovery', posixOptions, async t => {
  const { port, browser } = await fixture(t);
  const client = await connect(port);
  t.after(() => client.close());
  const before = await client.health();
  browser.child.kill('SIGSTOP');
  await assert.rejects(client.browser('Browser.getVersion', {}, 100), /timed out/);
  const deadline = Date.now() + 37000;
  let exited = false;
  while (Date.now() < deadline) {
    try { process.kill(before.pid, 0); } catch { exited = true; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(exited, 'unresponsive browser transport must not leave an idle daemon alive');
  browser.child.kill('SIGCONT');
  await client.reconnect();
  assert.notEqual((await client.health()).pid, before.pid);
});


test('concurrent clients share one tab attachment and domain initialization', options, async t => {
  const { port, trace } = await fixture(t);
  const clients = await Promise.all(Array.from({ length: 6 }, () => connect(port)));
  t.after(() => clients.forEach(client => client.close()));
  const { targetId } = await clients[0].browser('Target.createTarget', { url: 'about:blank' });
  const values = await Promise.all(clients.map(client => client.send(targetId, 'Runtime.evaluate', {
    expression: '1 + 1', returnByValue: true,
  })));
  assert.ok(values.every(value => value.result.value === 2));
  const events = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.event === 'send' && event.method === 'Target.attachToTarget' && event.params.targetId === targetId).length, 1);
  for (const domain of ['Runtime', 'Log', 'Page', 'Network']) {
    assert.equal(events.filter(event => event.event === 'send' && event.method === `${domain}.enable`).length, 1);
  }
});

test('a frozen daemon is replaced on demand using verified process ownership', posixOptions, async t => {
  const { port } = await fixture(t);
  const client = await connect(port);
  t.after(() => client.close());
  const { pid } = await client.health();
  process.kill(pid, 'SIGSTOP');
  const replacements = await Promise.all(Array.from({ length: 6 }, () => connect(port)));
  t.after(() => replacements.forEach(c => c.close()));
  const health = await Promise.all(replacements.map(c => c.health()));
  assert.equal(new Set(health.map(h => h.pid)).size, 1);
  assert.notEqual(health[0].pid, pid);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});


test('browser restart shares the existing daemon recovery instead of retiring it', options, async t => {
  const { port, browser } = await fixture(t);
  const client = await connect(port);
  t.after(() => client.close());
  const { pid } = await client.health();
  browser.child.kill('SIGKILL');
  const health = await client.health();
  assert.equal(health.recovering, true);
  const replacement = await startHeadlessBrowser(port);
  t.after(() => replacement.close());
  await client.reconnect();
  assert.equal((await client.health()).pid, pid);
});


test('independent agents reclaim a stale socket without creating duplicate daemons', posixOptions, async t => {
  const { port } = await fixture(t);
  const stale = spawn(process.execPath, ['--input-type=module', '-e',
    `import net from 'node:net'; net.createServer().listen(${JSON.stringify(SOCK(port))}, () => console.log('ready'));`,
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(resolve => stale.stdout.once('data', resolve));
  const exited = new Promise(resolve => stale.once('exit', resolve));
  stale.kill('SIGKILL');
  await exited;
  assert.ok(fs.existsSync(SOCK(port)));
  const results = await Promise.all(Array.from({ length: 8 }, () => exec(process.execPath, [
    '--input-type=module', '-e',
    `import {connect} from ${JSON.stringify(daemonModule)}; const c=await connect(${port}); console.log(JSON.stringify(await c.health())); c.close();`,
  ])));
  assert.equal(new Set(results.map(result => JSON.parse(result.stdout).pid)).size, 1);
  await assertSoleDaemon(port, JSON.parse(results[0].stdout).pid);
});


test('a browser paused longer than the former health deadline keeps its pooled connection', posixOptions, async t => {
  const { port, browser } = await fixture(t);
  const client = await connect(port);
  t.after(() => client.close());
  const before = await client.health();
  browser.child.kill('SIGSTOP');
  const resume = setTimeout(() => browser.child.kill('SIGCONT'), 4500);
  t.after(() => clearTimeout(resume));
  const legacy = await new Promise((resolve, reject) => {
    const socket = net.connect(SOCK(port));
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('legacy IPC liveness timed out')); }, 3500);
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify({reqId: 0, op: 'health'}) + '\n'));
    socket.on('data', data => { clearTimeout(timer); socket.destroy(); resolve(JSON.parse(data.toString()).result); });
  });
  assert.equal(legacy.pid, before.pid);
  assert.equal(legacy.unchecked, true, 'older clients get IPC liveness without destructive browser probes');
  const health = client.health();
  const other = await connect(port);
  t.after(() => other.close());
  assert.equal((await other.status()).pid, before.pid, 'new clients reuse IPC without another browser probe');
  assert.equal((await health).pid, before.pid);
  const events = fs.readFileSync((await import('../lib/env.mjs')).SOCK(port) + '.owner.json', 'utf8');
  assert.equal(JSON.parse(events).pid, before.pid);
});


test('a live legacy daemon is upgraded using its IPC status without a browser probe', posixOptions, async t => {
  const { port } = await fixture(t);
  const socketPath = SOCK(port);
  const legacy = spawn(process.execPath, ['--input-type=module', '-e', `
    import net from 'node:net'; import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
    const socketPath=${JSON.stringify(socketPath)};
    const server=net.createServer(sock=>sock.on('data',data=>{
      for(const line of data.toString().trim().split('\\n')) {
        const req=JSON.parse(line);
        if(req.op==='status') sock.write(JSON.stringify({reqId:req.reqId,result:{pid:process.pid,port:${port},attached:[]}})+'\\n');
        else if(req.op==='stop') {console.log('stopped');fs.unlinkSync(socketPath);fs.unlinkSync(socketPath+'.owner.json');process.exit(0);}
        else {console.log('unexpected browser health');process.exit(2);}
      }
    }));
    server.listen(socketPath,()=>{
      fs.writeFileSync(socketPath+'.owner.json',JSON.stringify({pid:process.pid,ino:fs.statSync(socketPath).ino,processStart:execFileSync('/bin/ps',['-p',String(process.pid),'-o','lstart='],{encoding:'utf8'})}));
      console.log('ready');
    });
  `], {stdio:['ignore','pipe','inherit']});
  t.after(()=>legacy.kill('SIGTERM'));
  let output=''; legacy.stdout.on('data',data=>output+=data);
  await new Promise(resolve=>legacy.stdout.once('data',resolve));
  const client=await connect(port); t.after(()=>client.close());
  assert.notEqual((await client.status()).pid,legacy.pid);
  assert.match(output,/stopped/);
  assert.doesNotMatch(output,/unexpected browser health/);
});

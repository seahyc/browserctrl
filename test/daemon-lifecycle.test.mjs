import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { connect, lockHolders } from '../lib/daemon.mjs';
import { SOCK } from '../lib/env.mjs';
import { startHeadlessBrowser, chromeBinary, stopLoggedDaemons } from './helpers.mjs';

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
    stopLoggedDaemons({ port });
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


test('a frozen daemon whose socket and owner file are gone is retired so a new one can start', posixOptions, async t => {
  const previous = process.env.BROWSERCTRL_TEST_ORPHAN_MIN_AGE_MS;
  process.env.BROWSERCTRL_TEST_ORPHAN_MIN_AGE_MS = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.BROWSERCTRL_TEST_ORPHAN_MIN_AGE_MS;
    else process.env.BROWSERCTRL_TEST_ORPHAN_MIN_AGE_MS = previous;
  });
  const { port } = await fixture(t);
  const client = await connect(port);
  t.after(() => client.close());
  const { pid } = await client.health();
  await new Promise(resolve => setTimeout(resolve, 1100)); // ps reports age in whole seconds
  // The observed state: a daemon that can no longer run JavaScript (SIGTERM and its own
  // socket watchdog never fire) still holds the port lock after its socket went away.
  process.kill(pid, 'SIGSTOP');
  fs.unlinkSync(SOCK(port));
  fs.unlinkSync(`${SOCK(port)}.owner.json`);
  const started = Date.now();
  const replacement = await connect(port);
  t.after(() => replacement.close());
  const health = await replacement.health();
  assert.notEqual(health.pid, pid);
  assert.ok(Date.now() - started < 30000, `took ${Date.now() - started} ms`);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await assertSoleDaemon(port, health.pid);
  if (['darwin', 'linux'].includes(process.platform)) {
    const { dirs } = await import('../lib/config.mjs');
    const diagnostics = path.join(dirs.data, 'diagnostics');
    const samples = fs.existsSync(diagnostics) ? fs.readdirSync(diagnostics).filter(f => f.startsWith(`stuck-daemon-${port}-${pid}-`)) : [];
    assert.equal(samples.length, 1, 'a stack sample of the stuck daemon was saved before it was retired');
    assert.ok(fs.statSync(path.join(diagnostics, samples[0])).size > 0);
  }
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


test('a live legacy daemon is left running until an owner coordinates safe upgrade', posixOptions, async t => {
  const { port } = await fixture(t);
  const socketPath = SOCK(port);
  const legacy = spawn(process.execPath, ['--input-type=module', '-e', `
    import net from 'node:net'; import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
    const socketPath=${JSON.stringify(socketPath)};
    const server=net.createServer(sock=>sock.on('data',data=>{
      for(const line of data.toString().trim().split('\\n')) {
        const req=JSON.parse(line);
        if(req.op==='status') sock.write(JSON.stringify({reqId:req.reqId,result:{pid:process.pid,port:${port},attached:[]}})+'\\n');
        else if(req.op==='stop') {
          if(req.owner!=='handover-test' || req.label!=='Handover test') {
            sock.write(JSON.stringify({reqId:req.reqId,error:'This client has no agent identity.'})+'\\n');
            continue;
          }
          console.log('stopped');fs.unlinkSync(socketPath);fs.unlinkSync(socketPath+'.owner.json');process.exit(0);
        }
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
  await assert.rejects(connect(port,{owner:'handover-test',label:'Handover test'}),/does not support a safe cooperative upgrade/);
  assert.equal(legacy.exitCode,null);
  assert.doesNotMatch(output,/stopped/);
  assert.doesNotMatch(output,/unexpected browser health/);
});

// A stand-in daemon that is healthy but running a different code version, so a normal
// connect would ask it to cooperatively upgrade. It defers that upgrade (as a stuck vault
// taint would) and logs every op it receives, so a test can prove which ops reached it.
function startFakeUpgradeableDaemon(port, { blocker, retiresWhenFree = false }) {
  const socketPath = SOCK(port);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import net from 'node:net'; import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
    const socketPath=${JSON.stringify(socketPath)};
    const status={ok:true,pid:process.pid,port:${port},code:'legacy-fake',starting:false,recovering:false,retiring:false,attached:[],cooperativeUpgrade:1,vaultEntry:1,vaultFill:1,taintedTabs:1};
    const server=net.createServer(sock=>sock.on('data',data=>{
      for(const line of data.toString().trim().split('\\n')){
        if(!line)continue; const req=JSON.parse(line); console.log('OP '+req.op);
        if(req.op==='status'||req.op==='health') sock.write(JSON.stringify({reqId:req.reqId,result:status})+'\\n');
        else if(req.op==='upgrade') sock.write(JSON.stringify({reqId:req.reqId,result:{deferred:true,blocker:${JSON.stringify(blocker)},retiresWhenFree:${retiresWhenFree}}})+'\\n');
        else if(req.op==='heal') sock.write(JSON.stringify({reqId:req.reqId,result:{prunedOrphans:['GONE'],prunedTaints:[],taintedTabs:0,blockedBy:null}})+'\\n');
        else if(req.op==='stop'){console.log('STOPPED');sock.write(JSON.stringify({reqId:req.reqId,result:'stopping'})+'\\n');try{fs.unlinkSync(socketPath);fs.unlinkSync(socketPath+'.owner.json');}catch{}process.exit(0);}
        else sock.write(JSON.stringify({reqId:req.reqId,error:'unexpected'})+'\\n');
      }
    }));
    server.listen(socketPath,()=>{
      fs.writeFileSync(socketPath+'.owner.json',JSON.stringify({pid:process.pid,ino:fs.statSync(socketPath).ino,processStart:execFileSync('/bin/ps',['-p',String(process.pid),'-o','lstart='],{encoding:'utf8'})}));
      console.log('ready');
    });
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  return child;
}

test('lifecycle commands reuse a version-mismatched daemon instead of deferring on an upgrade', posixOptions, async t => {
  const { port } = await fixture(t);
  const fake = startFakeUpgradeableDaemon(port, { blocker: 'a vault taint is held on tab 6C4D0950' });
  t.after(() => fake.kill('SIGKILL'));
  let out = ''; fake.stdout.on('data', d => out += d);
  await new Promise(resolve => fake.stdout.once('data', resolve));
  // A lifecycle connection reaches the running daemon whatever its code version, and never
  // triggers the cooperative upgrade that would otherwise be deferred.
  const client = await connect(port, { lifecycle: true });
  t.after(() => client.close());
  assert.equal((await client.status()).pid, fake.pid);
  assert.ok(!out.split('\n').includes('OP upgrade'), `lifecycle connect must not request an upgrade; saw ops:\n${out}`);
  // heal reaches it too and reports what it pruned.
  assert.deepEqual((await client.heal()).prunedOrphans, ['GONE']);
});

test('a deferred upgrade names the blocker and points at the no-kill recovery', posixOptions, async t => {
  const { port } = await fixture(t);
  const fake = startFakeUpgradeableDaemon(port, { blocker: 'a vault taint is held on tab 6C4D0950' });
  t.after(() => fake.kill('SIGKILL'));
  await new Promise(resolve => fake.stdout.once('data', resolve));
  // A normal (non-lifecycle) connect still attempts the upgrade; when deferred it surfaces the
  // specific blocker and the recovery path, rather than the old generic sentence.
  await assert.rejects(connect(port), e =>
    /vault taint is held on tab 6C4D0950/.test(e.message) && /doctor --fix|browserctrl stop/.test(e.message));
});

test('a deferred upgrade from a daemon that retires when free serves the command instead of failing', posixOptions, async t => {
  const { port } = await fixture(t);
  const fake = startFakeUpgradeableDaemon(port, { blocker: 'a command is running', retiresWhenFree: true });
  t.after(() => fake.kill('SIGKILL'));
  let out = ''; fake.stdout.on('data', d => out += d);
  await new Promise(resolve => fake.stdout.once('data', resolve));
  const client = await connect(port);
  t.after(() => client.close());
  assert.equal((await client.status()).pid, fake.pid, 'the running daemon serves this command');
  assert.ok(out.split('\n').includes('OP upgrade'), 'the upgrade was still asked for');
});

// A real daemon on code that then changes: it retires by itself once idle, and not while a
// client is mid-command.
async function withCodeStamp(t, value) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-stamp-'));
  const file = path.join(dir, 'stamp');
  fs.writeFileSync(file, value);
  const saved = { stamp: process.env.BROWSERCTRL_TEST_CODE_STAMP, check: process.env.BROWSERCTRL_UPGRADE_CHECK_MS, idle: process.env.BROWSERCTRL_IDLE_FOR_UPGRADE_MS };
  Object.assign(process.env, { BROWSERCTRL_TEST_CODE_STAMP: file, BROWSERCTRL_UPGRADE_CHECK_MS: '100', BROWSERCTRL_IDLE_FOR_UPGRADE_MS: '700' });
  t.after(() => {
    for (const [k, v] of [['BROWSERCTRL_TEST_CODE_STAMP', saved.stamp], ['BROWSERCTRL_UPGRADE_CHECK_MS', saved.check], ['BROWSERCTRL_IDLE_FOR_UPGRADE_MS', saved.idle]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return file;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(cond, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return true; await new Promise(r => setTimeout(r, 50)); }
  return false;
}

test('a daemon retires by itself once the code changes and it is idle; the next command gets new code', posixOptions, async t => {
  const { port } = await fixture(t);
  const stamp = await withCodeStamp(t, 'one');
  const first = await connect(port);
  const old = await first.status();
  assert.match(old.code, /\+one$/);
  first.close();
  fs.writeFileSync(stamp, 'two');
  assert.ok(await until(() => !alive(old.pid), 15000), 'the old daemon must not keep running');
  const next = await connect(port);
  t.after(() => next.close());
  const now = await next.status();
  assert.notEqual(now.pid, old.pid);
  assert.match(now.code, /\+two$/);
});

test('a daemon on old code does not retire while a connected client is mid-command', posixOptions, async t => {
  const { port } = await fixture(t);
  const stamp = await withCodeStamp(t, 'one');
  const client = await connect(port);
  t.after(() => client.close());
  const { pid } = await client.status();
  fs.writeFileSync(stamp, 'two');
  // Requests in a row, with gaps shorter than the idle window: the daemon stays.
  const end = Date.now() + 2500;
  while (Date.now() < end) { await client.tabs?.().catch(() => {}); await client.status(); await new Promise(r => setTimeout(r, 150)); }
  assert.ok(alive(pid), 'retired between two requests of a running command');
  // Quiet past the idle window: it goes.
  assert.ok(await until(() => !alive(pid), 15000), 'an idle old daemon must retire even with a client connected');
});

test('heal prunes a taint left for a tab that is no longer live', options, async t => {
  const { port } = await fixture(t);
  const { runtimePath } = await import('../lib/env.mjs');
  const gone = 'A1B2C3D4E5F600112233445566778899';
  // Seed the marker as the reported deadlock had it, before the daemon starts, so its fill gate
  // loads this closed tab as an orphan taint. runtimePath resolves under the test's isolated home.
  const marker = runtimePath(`vault-taint-${port}.json`);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ version: 2, tabs: { [gone]: { browser: 'dia', owner: 'agent-vault-fill', origins: ['https://dash.cloudflare.com'] } } }));
  const client = await connect(port);
  t.after(() => client.close());
  assert.equal((await client.status()).taintedTabs, 1, 'the daemon loaded the stale taint');
  const healed = await client.heal();
  assert.deepEqual(healed.prunedOrphans, [gone]);
  assert.equal((await client.status()).taintedTabs, 0, 'the stale taint no longer blocks');
  assert.equal(fs.existsSync(marker), false, 'the pruned marker is removed from disk');
});

test('without lsof, Linux finds a lock holder through /proc', { skip: process.platform !== 'linux' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-holders-'));
  const file = path.join(dir, 'held.lock');
  const fd = fs.openSync(file, 'a');
  try {
    const found = await lockHolders(file, { lsofPaths: [] });
    assert.equal(found.unverifiable, undefined);
    assert.ok(found.pids.includes(process.pid), JSON.stringify(found));
    fs.closeSync(fd);
    assert.equal((await lockHolders(file, { lsofPaths: [] })).pids.includes(process.pid), false);
  } finally {
    try { fs.closeSync(fd); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

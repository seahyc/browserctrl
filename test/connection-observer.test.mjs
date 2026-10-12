import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { observeConnections } from '../lib/connection-observer.mjs';

test('real OS observer sees only the outgoing socket and adds no connections', async t => {
  let accepted = 0;
  const peers = [];
  const server = net.createServer(socket => { accepted++; peers.push(socket); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const client = net.createConnection({ host: '127.0.0.1', port });
  await new Promise(resolve => client.once('connect', resolve));
  t.after(async () => {
    client.destroy();
    peers.forEach(socket => socket.destroy());
    await new Promise(resolve => server.close(resolve));
  });
  const snapshot = await observeConnections(port, { daemonPid: process.pid });
  assert.equal(snapshot.available, true, JSON.stringify(snapshot));
  assert.equal(snapshot.connections.length, 1);
  assert.equal(snapshot.connections[0].pid, process.pid);
  assert.equal(snapshot.connections[0].ppid, process.ppid);
  assert.equal(snapshot.connections[0].sharedDaemon, true);
  assert.ok(snapshot.connections[0].executable);
  assert.ok(snapshot.connections[0].ancestors.length <= 4);
  assert.equal(accepted, 1, 'observer must not probe the listening socket');
});

test('POSIX parses remote endpoint direction, bounds ancestry, and never requests arguments', async () => {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({command, args, options});
    if (command === 'lsof') return {stdout: 'p900\ncBrowser\nn127.0.0.1:9223->127.0.0.1:5555\np800\ncClient\nn[::1]:5555->[::1]:9223\np801\ncOther\nn127.0.0.1:5556->127.0.0.1:19223\n'};
    const pid = Number(args[1]);
    return {stdout: `${pid} ${pid - 1} /Applications/Example App/bin/process\n`};
  };
  const result = await observeConnections(9223, {run, daemonPid:800, platform:'darwin'});
  assert.deepEqual(result.connections.map(c => c.pid), [800]);
  assert.equal(result.connections[0].ancestors.length, 4);
  assert.equal(result.connections[0].executable, '/Applications/Example App/bin/process');
  assert.ok(calls.every(c => c.options.timeout === 2000 && c.options.maxBuffer === 1024 * 1024));
  assert.ok(calls.filter(c => c.command === 'ps').every(c => c.args.join(' ').endsWith('pid=,ppid=,comm=')));
});

test('vanished clients retain PID without falling back to full process arguments', async () => {
  const run = async command => {
    if (command === 'lsof') return {stdout: 'p800\nn127.0.0.1:5555->127.0.0.1:9223\n'};
    throw Object.assign(new Error('gone'), {code:1, stdout:'', stderr:''});
  };
  const result = await observeConnections(9223, {run, platform:'darwin'});
  assert.equal(result.available, true);
  assert.equal(result.connections[0].pid, 800);
  assert.equal(result.connections[0].processExited, true);
});

test('empty lsof is available; missing tools and unsupported platforms have safe warnings', async () => {
  const empty = await observeConnections(9223, {platform:'darwin', run: async () => {throw {code:1, stdout:'', stderr:''};}});
  assert.deepEqual(empty, {available:true, connections:[], warnings:[]});
  const missing = await observeConnections(9223, {platform:'darwin', run: async () => {throw new Error('secret argv should never appear');}});
  assert.equal(missing.available, false);
  assert.ok(!JSON.stringify(missing).includes('secret'));
  const unsupported = await observeConnections(9223, {platform:'freebsd', run: () => {throw new Error('must not execute');}});
  assert.equal(unsupported.available, false);
});

test('Windows uses a bounded passive TCP/CIM query and omits command-line data', async () => {
  const calls = [];
  const snapshot = {
    pids: [800],
    processes: [
      {ProcessId:800, ParentProcessId:700, ExecutablePath:'C:\\Program Files\\Browser\\browser.exe'},
      {ProcessId:700, ParentProcessId:600, ExecutablePath:'C:\\Windows\\System32\\services.exe'},
      {ProcessId:600, ParentProcessId:500, ExecutablePath:'C:\\Windows\\System32\\wininit.exe'},
      {ProcessId:500, ParentProcessId:400, ExecutablePath:'C:\\Windows\\System32\\smss.exe'},
      {ProcessId:400, ParentProcessId:1, ExecutablePath:'C:\\Windows\\System32\\System'},
    ],
  };
  const result = await observeConnections(9223, {
    platform:'win32',
    daemonPid:800,
    ignorePids:[901],
    run:async (command, args, options) => {
      calls.push({command,args,options});
      return {stdout:JSON.stringify(snapshot)};
    },
  });
  assert.equal(result.available, true);
  assert.equal(result.connections[0].pid, 800);
  assert.equal(result.connections[0].ppid, 700);
  assert.equal(result.connections[0].executable, 'C:\\Program Files\\Browser\\browser.exe');
  assert.equal(result.connections[0].ancestors.length, 4);
  assert.equal(result.connections[0].sharedDaemon, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'powershell.exe');
  assert.deepEqual(calls[0].args.slice(0, 3), ['-NoProfile','-NonInteractive','-Command']);
  assert.equal(calls[0].options.timeout, 5000);
  assert.equal(calls[0].options.maxBuffer, 1024 * 1024);
  const command = calls[0].args[3];
  assert.match(command, /Get-NetTCPConnection -RemotePort 9223 -State Established/);
  assert.match(command, /Get-CimInstance Win32_Process/);
  assert.match(command, /Select-Object ProcessId, ParentProcessId, ExecutablePath/);
  assert.doesNotMatch(command, /CommandLine|Win32_Process\.CommandLine/);
});

test('Windows observation caps clients and reports an unavailable PowerShell executable clearly', async () => {
  const manyPids = Array.from({length:33}, (_, index) => index + 100);
  const rows = manyPids.slice(0, 32).map(pid => ({ProcessId:pid, ParentProcessId:0, ExecutablePath:'C:\\node.exe'}));
  const bounded = await observeConnections(9223, {
    platform:'win32',
    run:async () => ({stdout:JSON.stringify({pids:manyPids, processes:rows})}),
  });
  assert.equal(bounded.connections.length, 32);
  assert.deepEqual(bounded.warnings, ['Connection observation is limited to 32 client processes.']);

  const unavailable = await observeConnections(9223, {
    platform:'win32',
    run:async () => { throw Object.assign(new Error('missing'), {code:'ENOENT'}); },
  });
  assert.equal(unavailable.available, false);
  assert.match(unavailable.warnings[0], /powershell\.exe could not be started/);
});

test('bounds client process observation to 32', async () => {
  const result = await observeConnections(9223, {platform:'darwin', run: async (command, args) => {
    if (command === 'lsof') return {stdout: Array.from({length:40}, (_, i) => `p${i+100}\nn127.0.0.1:${i+4000}->127.0.0.1:9223`).join('\n')};
    return {stdout:`${args[1]} 0 /usr/bin/node`};
  }});
  assert.equal(result.connections.length, 32);
  assert.equal(result.warnings.length, 1);
});

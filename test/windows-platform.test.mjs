import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { browserDataDirs, daemonAddress, runtimePath } from '../lib/platform.mjs';
import { acquireFileLock, releaseFileLock, withFileLock } from '../lib/file-lock.mjs';

test('Windows daemon uses a per-user named pipe without filesystem socket operations', () => {
  const first = daemonAddress(9222, 'win32', 'Alice');
  assert.ok(first.startsWith('\\\\.\\pipe\\'), JSON.stringify(first));
  assert.match(first, /^\\\\\.\\pipe\\browserctrl-[a-f0-9]{12}-9222$/);
  assert.equal(daemonAddress(9222, 'win32', 'alice'), first);
  assert.notEqual(daemonAddress(9222, 'win32', 'Bob'), first);
  assert.equal(daemonAddress(9222, 'linux', 'Alice'), runtimePath('master-9222.sock'));
  assert.ok(Buffer.byteLength(daemonAddress(9222, 'linux', 'Alice')) < 100, 'a unix socket path must stay short');
});

test('Windows mutex can be acquired and released repeatedly by one synchronous process', { skip: process.platform !== 'win32' }, () => {
  const lockPath = path.join(process.env.TEMP, `browserctrl-repeat-${process.pid}.lock`);
  for (let i = 0; i < 25; i++) withFileLock(lockPath, () => {});
});

test('browser profile data paths match supported Windows, macOS, and Linux locations', () => {
  assert.equal(browserDataDirs('chrome', 'win32', 'C:\\Users\\u', 'C:\\Users\\u\\AppData\\Local')[0], path.win32.join('C:\\Users\\u\\AppData\\Local', 'Google', 'Chrome', 'User Data'));
  assert.equal(browserDataDirs('edge', 'win32', 'C:\\Users\\u', 'C:\\Local')[0], path.win32.join('C:\\Local', 'Microsoft', 'Edge', 'User Data'));
  assert.equal(browserDataDirs('chrome', 'darwin', '/Users/u')[0], path.posix.join('/Users/u', 'Library', 'Application Support', 'Google', 'Chrome'));
  assert.equal(browserDataDirs('dia', 'darwin', '/Users/u')[0], path.posix.join('/Users/u', 'Library', 'Application Support', 'Dia', 'User Data'));
  assert.deepEqual(browserDataDirs('chrome', 'linux', '/home/u'), [
    '/home/u/.config/google-chrome',
    '/home/u/.var/app/com.google.Chrome/config/google-chrome',
  ]);
});

test('Windows named-pipe IPC carries a request and response', { skip: process.platform !== 'win32' }, async () => {
  const address = daemonAddress(45000 + (process.pid % 15000), 'win32');
  const server = net.createServer(socket => socket.pipe(socket));
  await new Promise((resolve, reject) => server.listen(address, error => error ? reject(error) : resolve()));
  try {
    const response = await new Promise((resolve, reject) => {
      const socket = net.connect(address);
      socket.once('error', reject);
      socket.once('connect', () => socket.write('{"op":"health"}\n'));
      socket.once('data', chunk => { resolve(chunk.toString()); socket.destroy(); });
    });
    assert.equal(response, '{"op":"health"}\n');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Windows mutex is released when its owning process crashes', { skip: process.platform !== 'win32' }, async () => {
  const lockPath = path.join(process.env.TEMP, `browserctrl-crash-${process.pid}.lock`);
  const moduleUrl = new URL('../lib/file-lock.mjs', import.meta.url).href;
  const source = `import { acquireFileLock } from ${JSON.stringify(moduleUrl)}; const lock=acquireFileLock(${JSON.stringify(lockPath)}, {timeoutSeconds:5}); if(!lock) process.exit(2); console.log('held'); setInterval(()=>{},1000);`;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Lock holder did not acquire mutex')), 15000);
      holder.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('held')) { clearTimeout(timer); resolve(); }
      });
      holder.once('error', reject);
      holder.once('exit', code => reject(new Error(`Lock holder exited before acquisition (${code})`)));
    });
    holder.kill();
    await new Promise(resolve => holder.once('exit', resolve));
    let lock = null;
    const deadline = Date.now() + 15000;
    while (!lock && Date.now() < deadline) {
      lock = acquireFileLock(lockPath, { timeoutSeconds: 1 });
    }
    assert.ok(lock, 'crashed owner should release its kernel mutex');
    releaseFileLock(lock);
  } finally {
    if (holder.exitCode === null) holder.kill();
  }
});

import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { setting, flag, dataPath } from './config.mjs';

const MAX_BYTES = 1024 * 1024;
const MAX_FILES = 32;
const FILE = /^lifecycle-\d+-\d+\.jsonl(?:\.1)?$/;
const EVENTS = new Set(['daemon_start', 'lock_skipped', 'listening', 'browser_connect_attempt',
  'browser_connected', 'browser_connect_failed', 'browser_disconnected', 'reconnect_attempt',
  'reconnected', 'reconnect_failed', 'reconnect_exhausted', 'shutdown', 'ipc_connected',
  'ipc_disconnected', 'request_started', 'request_complete', 'request_failed', 'protocol_timeout', 'health']);
const REASONS = new Set(['requested', 'sigterm', 'sigint', 'idle', 'startup_failed', 'reconnect_exhausted',
  'unhealthy_transport', 'healthy', 'busy', 'recovering', 'retiring', 'starting', 'failed', 'socket_owned']);
const OPS = new Set(['ping', 'health', 'status', 'stop', 'browser', 'cdp', 'events', 'detach']);
const ownerSalt = randomBytes(32);

export function telemetryDirectory() {
  return setting('TELEMETRY_DIR') || dataPath('telemetry');
}

// Only enumerated lifecycle data reaches disk. Diagnostic failures never affect browser work.
export function createTelemetry(port) {
  if (!flag('TELEMETRY', true) || !Number.isInteger(port) || port < 1 || port > 65535) return () => {};
  const directory = telemetryDirectory();
  const filename = path.join(directory, `lifecycle-${port}-${process.pid}.jsonl`);
  let prepared = false;
  const prune = () => {
    const files = fs.readdirSync(directory).filter(name => FILE.test(name)).map(name => {
      const file = path.join(directory, name);
      return { file, stat: fs.lstatSync(file) };
    }).filter(entry => entry.stat.isFile()).sort((a, b) =>
      a.file === filename ? -1 : b.file === filename ? 1 : b.stat.mtimeMs - a.stat.mtimeMs);
    for (const entry of files.slice(MAX_FILES)) fs.unlinkSync(entry.file);
  };
  return (event, data = {}) => {
    try {
      if (!EVENTS.has(event)) return;
      const row = { time: new Date().toISOString(), event, pid: process.pid, parent: process.ppid, port };
      for (const field of ['clientId', 'requestId', 'durationMs', 'pendingCount', 'attempt']) {
        if (Number.isSafeInteger(data[field]) && data[field] >= 0) row[field] = data[field];
      }
      if (REASONS.has(data.reason)) row.reason = data.reason;
      if (OPS.has(data.op)) row.op = data.op;
      if (typeof data.codeVersion === 'string' && /^\d{1,20}$/.test(data.codeVersion)) row.codeVersion = data.codeVersion;
      if (typeof data.method === 'string' && /^[A-Z][A-Za-z0-9]{0,63}\.[a-z][A-Za-z0-9]{0,63}$/.test(data.method)) row.method = data.method;
      if (typeof data.owner === 'string' && data.owner.length > 0 && data.owner.length <= 256) {
        row.ownerHash = createHmac('sha256', ownerSalt).update(data.owner).digest('hex').slice(0, 24);
      }
      const line = JSON.stringify(row) + '\n';
      if (!prepared) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (!fs.lstatSync(directory).isDirectory()) return;
        fs.chmodSync(directory, 0o700);
      }
      let fd;
      let rotated = false;
      try {
        let prior;
        try { prior = fs.lstatSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (prior && !prior.isFile()) return;
        fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
        const opened = fs.fstatSync(fd);
        const current = fs.lstatSync(filename);
        if (!opened.isFile() || !current.isFile() || current.ino !== opened.ino ||
            (prior && prior.ino !== opened.ino)) return;
        fs.fchmodSync(fd, 0o600);
        if (fs.fstatSync(fd).size + Buffer.byteLength(line) > MAX_BYTES) {
          fs.closeSync(fd); fd = undefined;
          fs.renameSync(filename, `${filename}.1`);
          fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
          rotated = true;
        }
        fs.writeSync(fd, line);
      } finally { if (fd !== undefined) fs.closeSync(fd); }
      if (!prepared || rotated) prune();
      prepared = true;
    } catch { /* Telemetry is best effort and never contains error messages. */ }
  };
}

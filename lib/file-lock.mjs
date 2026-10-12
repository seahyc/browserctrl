// Keep the inode stable; process exit releases the kernel-held lock.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export function acquireFileLock(path, { timeoutSeconds = 5 } = {}) {
  const mac = process.platform === 'darwin';
  if (!mac && process.platform !== 'linux') throw new Error(`File locking is unsupported on ${process.platform}`);
  const fd = fs.openSync(path, 'a', 0o600);
  // The inherited fd shares the parent's open file description and lock.
  const result = spawnSync(mac ? '/usr/bin/lockf' : '/usr/bin/flock',
    mac ? ['-s', '-t', String(timeoutSeconds), '3'] : ['-w', String(timeoutSeconds), '3'],
    { stdio: ['ignore', 'ignore', 'pipe', fd], encoding: 'utf8', timeout: (timeoutSeconds + 1) * 1000 });
  if (!result.error && result.status === 0) return fd;
  fs.closeSync(fd);
  if (!result.error && result.status === (mac ? 75 : 1)) return null;
  throw new Error(`Cannot acquire file lock ${path}: ${result.error?.message || result.stderr?.trim() || result.status}`);
}

export function withFileLock(path, fn) {
  const fd = acquireFileLock(path);
  if (fd === null) {
    const error = new Error(`Cannot acquire file lock ${path}: timed out`);
    error.code = 'LOCK_UNAVAILABLE';
    throw error;
  }
  try { return fn(); } finally { fs.closeSync(fd); }
}

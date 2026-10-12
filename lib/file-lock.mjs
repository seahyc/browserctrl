import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isWindows } from './platform.mjs';
import { acquireWindowsMutex } from './adapters/windows-lock.mjs';

export function acquireFileLock(lockPath, { timeoutSeconds = 5 } = {}) {
  if (isWindows) return acquireWindowsMutex(lockPath, timeoutSeconds);

  const mac = process.platform === 'darwin';
  if (!mac && process.platform !== 'linux') throw new Error(`File locking is unsupported on ${process.platform}`);
  const fd = fs.openSync(lockPath, 'a', 0o600);
  const result = spawnSync(
    mac ? '/usr/bin/lockf' : '/usr/bin/flock',
    mac ? ['-s', '-t', String(timeoutSeconds), '3'] : ['-w', String(timeoutSeconds), '3'],
    {
      stdio: ['ignore', 'ignore', 'pipe', fd],
      encoding: 'utf8',
      timeout: (timeoutSeconds + 1) * 1000,
    },
  );
  if (!result.error && result.status === 0) return fd;

  fs.closeSync(fd);
  if (!result.error && result.status === (mac ? 75 : 1)) return null;
  const reason = result.error?.message || result.stderr?.trim() || result.status;
  throw new Error(`Cannot acquire file lock ${lockPath}: ${reason}`);
}

export function releaseFileLock(lock) {
  if (lock && typeof lock === 'object' && lock.kind === 'windows-mutex') return lock.release();
  fs.closeSync(lock);
}

export function withFileLock(lockPath, fn) {
  const lock = acquireFileLock(lockPath);
  if (lock === null) {
    const error = new Error(`Cannot acquire file lock ${lockPath}: timed out`);
    error.code = 'LOCK_UNAVAILABLE';
    throw error;
  }
  try { return fn(); } finally { releaseFileLock(lock); }
}

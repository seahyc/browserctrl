import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { isWindows, runtimeDirectory } from './platform.mjs';

function acquireWindowsMutex(lockPath, timeoutSeconds) {
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  const mutexName = 'Local\\browserctrl-' + crypto.createHash('sha256').update(path.resolve(lockPath).toLowerCase()).digest('hex');
  const marker = path.join(os.tmpdir(), `browserctrl-lock-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
  const timeoutMarker = `${marker}.timeout`;
  const releaseMarker = `${marker}.release`;
  const releasedMarker = `${marker}.released`;
  const errorMarker = `${marker}.error`;
  const q = value => `'${value.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop'; $m=$null; $owned=$false; try { $self=Get-CimInstance Win32_Process -Filter "ProcessId = $PID"; $parent=Get-CimInstance Win32_Process -Filter "ProcessId = $($self.ParentProcessId)"; if(!$parent){throw 'Could not identify lock owner process'}; $parentStart=$parent.CreationDate.ToUniversalTime().Ticks; $m=[Threading.Mutex]::new($false,${q(mutexName)}); try {$owned=$m.WaitOne(${Math.max(0, timeoutSeconds) * 1000})} catch [Threading.AbandonedMutexException] {$owned=$true}; if(!$owned){[IO.File]::WriteAllText(${q(timeoutMarker)},'timeout')} else { [IO.File]::WriteAllText(${q(marker)},'held'); $nextCheck=[DateTime]::UtcNow; while(!(Test-Path -LiteralPath ${q(releaseMarker)})){ Start-Sleep -Milliseconds 20; if([DateTime]::UtcNow -ge $nextCheck){$nextCheck=[DateTime]::UtcNow.AddMilliseconds(250); $current=Get-CimInstance Win32_Process -Filter "ProcessId = $($self.ParentProcessId)"; if(!$current -or $current.CreationDate.ToUniversalTime().Ticks -ne $parentStart){break}} }; if(Test-Path -LiteralPath ${q(releaseMarker)}){Remove-Item -LiteralPath ${q(releaseMarker)} -Force -ErrorAction SilentlyContinue}; $m.ReleaseMutex(); $owned=$false; [IO.File]::WriteAllText(${q(releasedMarker)},'released') } } catch { [IO.File]::WriteAllText(${q(errorMarker)},$_.ToString()) } finally { if($owned -and $m){try{$m.ReleaseMutex()}catch{}}; if($m){$m.Dispose()} }`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const where = spawnSync('where.exe', ['powershell.exe'], { encoding: 'utf8', windowsHide: true });
  if (where.error || where.status !== 0 || !where.stdout.trim()) {
    throw new Error(`Windows file locking requires powershell.exe: ${where.error?.message || where.stderr?.trim() || 'executable not found'}`);
  }
  const diagnosticFile = `${marker}.stderr`;
  const diagnosticFd = fs.openSync(diagnosticFile, 'w');
  let child;
  try {
    child = spawn(where.stdout.trim().split(/\r?\n/)[0], ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'ignore', diagnosticFd] });
  } finally { fs.closeSync(diagnosticFd); }
  if (!child.pid) {
    const stderr = fs.readFileSync(diagnosticFile, 'utf8').trim();
    try { fs.unlinkSync(diagnosticFile); } catch {}
    throw new Error(`Cannot start powershell.exe for Windows mutex ${lockPath}: ${stderr || child.spawnfile}`);
  }
  const deadline = Date.now() + Math.max(15000, timeoutSeconds * 1000 + 10000);
  let nextLivenessCheck = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (fs.existsSync(marker)) {
      try { fs.unlinkSync(marker); } catch {}
      try { fs.unlinkSync(timeoutMarker); } catch {}
      try { fs.unlinkSync(diagnosticFile); } catch {}
      return {
        kind: 'windows-mutex',
        release() {
          fs.writeFileSync(releaseMarker, 'release');
          const releaseDeadline = Date.now() + 10000;
          while (Date.now() < releaseDeadline && !fs.existsSync(releasedMarker)) {
            if (child.pid && !isProcessAlive(child.pid)) break;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
          const released = fs.existsSync(releasedMarker);
          const detail = fs.existsSync(errorMarker) ? fs.readFileSync(errorMarker, 'utf8') : '';
          const stderr = fs.existsSync(diagnosticFile) ? fs.readFileSync(diagnosticFile, 'utf8').trim() : '';
          for (const file of [releaseMarker, releasedMarker, errorMarker, diagnosticFile]) { try { fs.unlinkSync(file); } catch {} }
          if (!released) throw new Error(`Windows mutex helper did not confirm release for ${lockPath}${detail || stderr ? `: ${detail || stderr}` : ''}`);
        },
      };
    }
    if (fs.existsSync(timeoutMarker)) {
      try { fs.unlinkSync(timeoutMarker); } catch {}
      try { fs.unlinkSync(diagnosticFile); } catch {}
      return null;
    }
    if (fs.existsSync(errorMarker)) {
      const detail = fs.readFileSync(errorMarker, 'utf8');
      try { fs.unlinkSync(errorMarker); } catch {}
      try { child.kill(); } catch {}
      const stderr = fs.existsSync(diagnosticFile) ? fs.readFileSync(diagnosticFile, 'utf8').trim() : '';
      try { fs.unlinkSync(diagnosticFile); } catch {}
      throw new Error(`Cannot acquire Windows mutex for ${lockPath}: ${detail || stderr}`);
    }
    if (Date.now() >= nextLivenessCheck) {
      nextLivenessCheck = Date.now() + 500;
      if (!isProcessAlive(child.pid)) {
        const stderr = fs.existsSync(diagnosticFile) ? fs.readFileSync(diagnosticFile, 'utf8').trim() : '';
        try { fs.unlinkSync(diagnosticFile); } catch {}
        throw new Error(`Windows mutex helper exited before acquiring ${lockPath}${stderr ? `: ${stderr}` : ''}`);
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  try { child.kill(); } catch {}
  try { fs.unlinkSync(marker); } catch {}
  try { fs.unlinkSync(timeoutMarker); } catch {}
  const stderr = fs.existsSync(diagnosticFile) ? fs.readFileSync(diagnosticFile, 'utf8').trim() : '';
  try { fs.unlinkSync(diagnosticFile); } catch {}
  throw new Error(`Cannot acquire Windows mutex for ${lockPath}${stderr ? `: ${stderr}` : ''}`);
}

function isProcessAlive(pid) {
  const result = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return !result.error && result.status === 0 && result.stdout.includes(`"${pid}"`);
}

export function acquireFileLock(lockPath, { timeoutSeconds = 5 } = {}) {
  if (isWindows) return acquireWindowsMutex(lockPath, timeoutSeconds);
  const mac = process.platform === 'darwin';
  if (!mac && process.platform !== 'linux') throw new Error(`File locking is unsupported on ${process.platform}`);
  const fd = fs.openSync(lockPath, 'a', 0o600);
  const result = spawnSync(mac ? '/usr/bin/lockf' : '/usr/bin/flock',
    mac ? ['-s', '-t', String(timeoutSeconds), '3'] : ['-w', String(timeoutSeconds), '3'],
    { stdio: ['ignore', 'ignore', 'pipe', fd], encoding: 'utf8', timeout: (timeoutSeconds + 1) * 1000 });
  if (!result.error && result.status === 0) return fd;
  fs.closeSync(fd);
  if (!result.error && result.status === (mac ? 75 : 1)) return null;
  throw new Error(`Cannot acquire file lock ${lockPath}: ${result.error?.message || result.stderr?.trim() || result.status}`);
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

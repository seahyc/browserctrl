import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { runtimeDirectory } from '../platform.mjs';

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function acquireWindowsMutex(lockPath, timeoutSeconds) {
  fs.mkdirSync(runtimeDirectory, { recursive: true });

  const lockHash = crypto
    .createHash('sha256')
    .update(path.resolve(lockPath).toLowerCase())
    .digest('hex');
  const mutexName = `Local\\browserctrl-${lockHash}`;
  const marker = path.join(os.tmpdir(), `browserctrl-lock-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
  const timeoutMarker = `${marker}.timeout`;
  const releaseMarker = `${marker}.release`;
  const releasedMarker = `${marker}.released`;
  const errorMarker = `${marker}.error`;
  const diagnosticFile = `${marker}.stderr`;
  const quote = value => `'${value.replaceAll("'", "''")}'`;

  // The helper owns the kernel mutex. It exits after an explicit release
  // marker or when this exact parent process disappears or its PID is reused.
  const script = `
$ErrorActionPreference = 'Stop'
$mutex = $null
$ownsMutex = $false
try {
  $self = Get-CimInstance Win32_Process -Filter "ProcessId = $PID"
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($self.ParentProcessId)"
  if (!$parent) { throw 'Could not identify lock owner process' }
  $parentStart = $parent.CreationDate.ToUniversalTime().Ticks
  $mutex = [Threading.Mutex]::new($false, ${quote(mutexName)})

  try {
    $ownsMutex = $mutex.WaitOne(${Math.max(0, timeoutSeconds) * 1000})
  } catch [Threading.AbandonedMutexException] {
    $ownsMutex = $true
  }

  if (!$ownsMutex) {
    [IO.File]::WriteAllText(${quote(timeoutMarker)}, 'timeout')
  } else {
    [IO.File]::WriteAllText(${quote(marker)}, 'held')
    $nextCheck = [DateTime]::UtcNow

    while (!(Test-Path -LiteralPath ${quote(releaseMarker)})) {
      Start-Sleep -Milliseconds 20
      if ([DateTime]::UtcNow -ge $nextCheck) {
        $nextCheck = [DateTime]::UtcNow.AddMilliseconds(250)
        $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($self.ParentProcessId)"
        if (!$current -or $current.CreationDate.ToUniversalTime().Ticks -ne $parentStart) { break }
      }
    }

    if (Test-Path -LiteralPath ${quote(releaseMarker)}) {
      Remove-Item -LiteralPath ${quote(releaseMarker)} -Force -ErrorAction SilentlyContinue
    }
    $mutex.ReleaseMutex()
    $ownsMutex = $false
    [IO.File]::WriteAllText(${quote(releasedMarker)}, 'released')
  }
} catch {
  [IO.File]::WriteAllText(${quote(errorMarker)}, $_.ToString())
} finally {
  if ($ownsMutex -and $mutex) {
    try { $mutex.ReleaseMutex() } catch {}
  }
  if ($mutex) { $mutex.Dispose() }
}
`;

  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const where = spawnSync('where.exe', ['powershell.exe'], { encoding: 'utf8', windowsHide: true });
  if (where.error || where.status !== 0 || !where.stdout.trim()) {
    const reason = where.error?.message || where.stderr?.trim() || 'executable not found';
    throw new Error(`Windows file locking requires powershell.exe: ${reason}`);
  }

  const diagnosticFd = fs.openSync(diagnosticFile, 'w');
  let child;
  try {
    const powershell = where.stdout.trim().split(/\r?\n/)[0];
    child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', diagnosticFd],
    });
  } finally {
    fs.closeSync(diagnosticFd);
  }

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
          for (const file of [releaseMarker, releasedMarker, errorMarker, diagnosticFile]) {
            try { fs.unlinkSync(file); } catch {}
          }
          if (!released) {
            const reason = detail || stderr;
            throw new Error(`Windows mutex helper did not confirm release for ${lockPath}${reason ? `: ${reason}` : ''}`);
          }
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

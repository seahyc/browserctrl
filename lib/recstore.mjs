// Where recordings live on disk. Shared by the recorder (which owns the
// lifecycle) and the daemon (which receives events over the CDP binding),
// so neither has to import the other.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'node:child_process';
import { dataPath, statePath, dirs } from './config.mjs';

// Large, so in the data folder; an earlier version's ~/.cdp/recordings stays in use until
// `browserctrl migrate` moves it.
export const ROOT = dirs.legacy?.includes('state') && fs.existsSync(statePath('recordings')) ? statePath('recordings') : dataPath('recordings');
export const dir = id => path.join(ROOT, id);
export const metaPath = id => path.join(dir(id), 'meta.json');
export const eventsPath = id => path.join(dir(id), 'events.jsonl');
export const windowsPath = id => path.join(dir(id), 'windows.jsonl');
export const marksPath = id => path.join(dir(id), 'marks.jsonl');
export const videoPath = id => path.join(dir(id), 'screen.mp4');
// (video time, wall time) samples straight from ffmpeg: the video's real clock.
export const clockPath = id => path.join(dir(id), 'video-clock.jsonl');

export function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function readMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
  } catch {
    return null;
  }
}

// A page's flush can reach us twice: a tab the daemon has attached to more than
// once delivers the same __cdpSend payload per binding, and the whole batch
// lands again. Two identical events in the same millisecond are that, not two
// real clicks a human made, so they are dropped here rather than being left for
// every reader of a recording to puzzle over.
const recentKeys = new Map(); // recording id -> Set of event keys
const KEEP_KEYS = 4000;

export function eventKey(row) {
  return [row.t, row.type, row.url, row.element?.selector ?? '', row.key ?? '', row.value ?? ''].join('|');
}

export function appendEvents(id, rows) {
  if (!rows?.length || !fs.existsSync(dir(id))) return 0;
  if (!recentKeys.has(id)) recentKeys.set(id, new Set());
  const seen = recentKeys.get(id);
  const fresh = rows.filter(r => {
    const k = eventKey(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (seen.size > KEEP_KEYS) {
    // Bounded: a long recording should not grow this without limit, and a
    // duplicate arriving thousands of events later is not a duplicate delivery.
    recentKeys.set(id, new Set(Array.from(seen).slice(-KEEP_KEYS / 2)));
  }
  if (!fresh.length) return 0;
  fs.appendFileSync(eventsPath(id), fresh.map(r => JSON.stringify(r)).join('\n') + '\n');
  return fresh.length;
}

export function forgetEventKeys(id) {
  recentKeys.delete(id);
}

// The recording currently in progress, if any: which port it is watching and
// what to inject. The daemon reads this so a tab created mid-recording can be
// instrumented at the moment it appears, rather than whenever a poll catches it.
export const activePath = path.join(ROOT, 'active.json');

function processStart(pid) {
  const windows = process.platform === 'win32';
  const command = windows ? 'powershell.exe' : 'ps';
  const args = windows ? ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}").CreationDate.ToUniversalTime().ToString('o')`] : ['-p', String(pid), '-o', 'lstart='];
  return execFileSync(command, args, {
    encoding: 'utf8', timeout: windows ? 10000 : 2000, maxBuffer: 16384,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

export function readActive() {
  try {
    const row = JSON.parse(fs.readFileSync(activePath, 'utf8'));
    // Legacy files cannot prove a live owner. Preserve them on disk, but never
    // re-inject their recording script into newly attached pages.
    if (!Number.isSafeInteger(row?.ownerPid) || row.ownerPid <= 0 ||
        typeof row.ownerStart !== 'string' || !row.ownerStart.trim()) return null;
    return processStart(row.ownerPid) === row.ownerStart ? row : null;
  } catch {
    return null;
  }
}

export function writeActive(row) {
  const ownerStart = processStart(process.pid);
  if (!ownerStart) throw new Error('Cannot identify the recording owner process');
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(activePath, JSON.stringify({ ...row, ownerPid: process.pid, ownerStart }));
}

export function clearActive() {
  try {
    fs.unlinkSync(activePath);
  } catch {
    /* nothing was recording */
  }
}

// A compact, local, always-on log of CLI invocations: one short JSON line per call.
//
// It records shapes, never content: command name, flag NAMES, durations, byte counts, a
// hostname, and a short stop code. It never records flag values, positional arguments, typed
// text, URLs beyond the hostname, page text, element names or stop-reason text.
// Logging must never change the CLI's output or exit code, so everything here is try/catch.
// Turn it off with BROWSERCTRL_USAGE_LOG=0. See references/usage-log.md.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { setting, flag, number, dataPath } from './config.mjs';

const DAY_MS = 86400000;
const FILE = /^usage-(\d{8})\.jsonl(\.gz)?$/;
const MARKER = /^\.compacted-\d{8}$/;
const CMD = /^[a-z][a-z0-9-]{0,23}$/;
const FLAG = /^[a-z][a-z0-9-]{0,24}$/;
const KINDS = new Set(['name', 'ref', 'sel', 'xy', 'item', 'intent', 'none']);
const THEN = new Set(['items', 'text', 'read', 'table', 'fields']);
const SESSION_ENV = ['BROWSERCTRL_AGENT_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID'];

export function usageDirectory() {
  return setting('USAGE_DIR') || dataPath('usage');
}

/** Short code for a stop or failure message. Order matters: the first match wins. */
export function classifyStop(reason) {
  if (typeof reason !== 'string' || !reason) return 'other';
  const s = reason.slice(0, 2000);
  if (/unsure|p=0\.\d+.*require/i.test(s)) return 'jev_unsure';
  if (/found no element|no element matching|nothing matches/i.test(s)) return 'jev_none';
  if (/covers|covered/i.test(s)) return 'covered';
  if (/dialog or popup|overlay|blocking/i.test(s)) return 'overlay';
  if (/commit/i.test(s)) return 'commit';
  if (/timed out|deadline/i.test(s)) return 'timeout';
  if (/TypeSafe|API key/i.test(s)) return 'no_key';
  if (/expect|did not show|not what it expected/i.test(s)) return 'expect';
  if (/claimed|owned by|another agent/i.test(s)) return 'claim';
  return 'other';
}

// ---- current record ----
let cur = null;
let startMs = 0;
let finished = true;
let counts = { o: 0, e: 0 };
let installed = false;
let version;
const maintained = new Set();

const uint = v => Number.isSafeInteger(v) && v >= 0;

function hostnameOf(v) {
  if (typeof v !== 'string' || v.length > 4096) return undefined;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    const h = u.hostname.toLowerCase();
    return h && h.length <= 80 && /^[a-z0-9.:\[\]_-]+$/.test(h) ? h : undefined;
  } catch { return undefined; }
}

function firstCommand(argv) {
  for (const a of argv) {
    if (typeof a !== 'string' || a.startsWith('-')) continue;
    return CMD.test(a) ? a : '?';
  }
  return '?';
}

function flagNames(argv) {
  const out = new Set();
  for (const a of argv) {
    if (typeof a !== 'string') continue;
    if (a === '--') break;
    let name;
    if (/^-[a-zA-Z]{1,4}$/.test(a)) { for (const ch of a.slice(1)) out.add(ch); continue; }
    else if (a.startsWith('--')) name = a.slice(2).split('=')[0];
    else continue;
    if (FLAG.test(name)) out.add(name);
  }
  return [...out].sort().slice(0, 16);
}

function sessionId(env) {
  for (const key of SESSION_ENV) {
    const v = env[key];
    if (typeof v === 'string' && v) return createHash('sha256').update(v).digest('hex').slice(0, 10);
  }
  return undefined;
}

function harness(env) {
  if (env.CLAUDECODE) return 'cc';
  const keys = Object.keys(env);
  if (keys.some(k => k.startsWith('CODEX_'))) return 'cx';
  if (keys.some(k => k.startsWith('OPENCODE'))) return 'oc';
  return undefined;
}

function packageVersion() {
  if (version !== undefined) return version || undefined;
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    version = typeof pkg.version === 'string' && /^[0-9A-Za-z.+-]{1,20}$/.test(pkg.version) ? pkg.version : '';
  } catch { version = ''; }
  return version || undefined;
}

function installCounters() {
  if (installed) return;
  installed = true;
  for (const [name, key] of [['stdout', 'o'], ['stderr', 'e']]) {
    try {
      const stream = process[name];
      const original = stream.write;
      stream.write = function (chunk, ...rest) {
        try {
          if (cur) {
            counts[key] += typeof chunk === 'string'
              ? Buffer.byteLength(chunk, typeof rest[0] === 'string' && Buffer.isEncoding(rest[0]) ? rest[0] : 'utf8')
              : (chunk?.byteLength ?? 0);
          }
        } catch { /* counting is best effort */ }
        return original.call(this, chunk, ...rest);
      };
    } catch { /* a stream we cannot wrap is simply not counted */ }
  }
}

/** Begin the record for this invocation. argv is the arguments after the script name. */
export function startUsage({ argv = [], env = process.env, now = Date.now() } = {}) {
  try {
    if (!flag('USAGE_LOG', true)) { cur = null; finished = true; return null; }
    startMs = now;
    counts = { o: 0, e: 0 };
    const list = Array.isArray(argv) ? argv : [];
    cur = { t: Math.floor(now / 1000), c: firstCommand(list), f: flagNames(list) };
    const s = sessionId(env); if (s) cur.s = s;
    const h = harness(env); if (h) cur.h = h;
    if (uint(process.ppid)) cur.pp = process.ppid;
    finished = false;
    installCounters();
    return cur;
  } catch { cur = null; finished = true; return null; }
}

const SETTERS = {
  c: v => (typeof v === 'string' && CMD.test(v) ? { c: v } : null),
  a: v => (typeof v === 'string' && CMD.test(v) ? { a: v } : null),
  k: v => (KINDS.has(v) ? { k: v } : null),
  tab: v => {
    const id = typeof v === 'string' ? v.slice(0, 8) : '';
    return /^[0-9A-Fa-f]{4,8}$/.test(id) ? { tab: id } : null;
  },
  url: v => { const host = hostnameOf(v); return host ? { host } : null; },
  host: v => { const host = hostnameOf(v); return host ? { host } : null; },
  br: v => (typeof v === 'string' && /^[a-z0-9-]{1,16}$/.test(v) ? { br: v } : null),
  n: v => (uint(v) ? { n: v } : null),
  nd: v => (uint(v) ? { nd: v } : null),
  j: v => (uint(v) ? { j: v } : null),
  ch: v => (uint(v) ? { ch: v } : null),
  ms_settle: v => (uint(v) ? { ms_settle: v } : null),
  ms_jev: v => (uint(v) ? { ms_jev: v } : null),
  // The raw reason is classified here and dropped; only the code is kept.
  stop: v => (typeof v === 'string' && v ? { st: classifyStop(v) } : null),
  sp: v => (typeof v === 'string' && /^[A-Za-z0-9_.-]{1,8}$/.test(v) ? { sp: v } : null),
  then: v => (THEN.has(v) ? { then: v } : null),
  un: v => (typeof v === 'boolean' ? { un: v } : null),
};

/** Merge allowed fields into the current record; unknown keys and wrong types are ignored. */
export function noteUsage(fields) {
  try {
    if (!cur || finished || !fields || typeof fields !== 'object') return;
    for (const key of Object.keys(fields)) {
      if (!Object.hasOwn(SETTERS, key)) continue;
      const set = SETTERS[key](fields[key]);
      if (set) Object.assign(cur, set);
    }
  } catch { /* never affects the CLI */ }
}

const ORDER = ['t', 'd', 'c', 'a', 'x', 'f', 'k', 'tab', 's', 'h', 'pp', 'o', 'e', 'host', 'br', 'v',
  'n', 'nd', 'j', 'st', 'sp', 'ms_settle', 'ms_jev', 'then', 'ch', 'un'];

function buildLine(exitCode, now, withVersion) {
  const rec = { ...cur, d: Math.max(0, Math.round(now - startMs)), x: Number.isInteger(exitCode) ? exitCode : (Number.isInteger(process.exitCode) ? process.exitCode : 0),
    o: counts.o, e: counts.e, v: withVersion ? packageVersion() : undefined };
  const out = {};
  for (const key of ORDER) {
    let v = rec[key];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && !v.length) continue;
    if (key === 'e' && v === 0) continue;
    if ((key === 'j' || key === 'ch' || key === 'ms_settle' || key === 'ms_jev') && v === 0) continue;
    if (key === 'un' && v !== true) continue;
    out[key] = v;
  }
  return JSON.stringify(out) + '\n';
}

const dayString = ms => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
const dayFile = (dir, day) => path.join(dir, `usage-${day}.jsonl`);

function prepareDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) return false;
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change */ }
  return true;
}

// The version rides on the first line of each day's file only: it saves bytes on every other line.
function appendLine(file, makeLine) {
  let fd;
  try {
    let prior;
    try { prior = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (prior && !prior.isFile()) return null;
    fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    if (!fs.fstatSync(fd).isFile()) return null;
    const line = makeLine(!prior);
    fs.writeSync(fd, line);
    return line;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function usageFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const m = FILE.exec(name);
    if (!m) continue;
    const file = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(file); } catch { continue; }
    if (st.isFile()) out.push({ name, file, day: m[1], gz: !!m[2], size: st.size });
  }
  return out;
}

// Gzip whole days that nobody can still be appending to (older than yesterday), once a day.
function compact(dir, now) {
  const today = dayString(now);
  try { fs.closeSync(fs.openSync(path.join(dir, `.compacted-${today}`), 'wx', 0o600)); } catch { return; }
  for (const name of fs.readdirSync(dir)) {
    if (MARKER.test(name) && name !== `.compacted-${today}`) {
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* another process got it */ }
    }
  }
  const cutoff = dayString(now - 2 * DAY_MS);
  const files = usageFiles(dir);
  const zipped = new Set(files.filter(f => f.gz).map(f => f.day));
  for (const f of files) {
    if (f.gz || f.day > cutoff || zipped.has(f.day)) continue;
    const gz = path.join(dir, `usage-${f.day}.jsonl.gz`);
    const tmp = `${gz}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, zlib.gzipSync(fs.readFileSync(f.file), { level: 9 }), { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, gz);
      fs.unlinkSync(f.file);
    } catch { try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ } }
  }
}

function retain(dir, now) {
  const today = dayString(now);
  const days = number('USAGE_DAYS', 180);
  const maxBytes = number('USAGE_MAX_MB', 20) * 1024 * 1024;
  const oldest = dayString(now - days * DAY_MS);
  let files = usageFiles(dir);
  for (const f of files) {
    if (f.day < oldest && f.day !== today) { try { fs.unlinkSync(f.file); f.gone = true; } catch { /* keep */ } }
  }
  files = files.filter(f => !f.gone).sort((a, b) => a.day.localeCompare(b.day) || a.gz - b.gz);
  let total = files.reduce((sum, f) => sum + f.size, 0);
  for (const f of files) {
    if (total <= maxBytes) break;
    if (f.day === today) continue;
    try { fs.unlinkSync(f.file); total -= f.size; } catch { /* keep */ }
  }
}

/** Append the record as one line. Synchronous, idempotent, safe in a process 'exit' handler. */
export function finishUsage(exitCode, { now = Date.now() } = {}) {
  try {
    if (!cur || finished) return null;
    finished = true;
    const dir = usageDirectory();
    if (!prepareDirectory(dir)) return null;
    const line = appendLine(dayFile(dir, dayString(now)), fresh => buildLine(exitCode, now, fresh));
    if (!line) return null;
    if (!maintained.has(dir)) {
      maintained.add(dir);
      try { compact(dir, now); } catch { /* best effort */ }
      try { retain(dir, now); } catch { /* best effort */ }
    }
    return line;
  } catch { return null; }
}

/** Records from the last `days` calendar days (today included), oldest first. */
export function readUsage({ days = 7, dir = usageDirectory(), now = Date.now() } = {}) {
  const records = [];
  try {
    const first = dayString(now - (Math.max(1, days) - 1) * DAY_MS);
    const all = usageFiles(dir);
    const zipped = new Set(all.filter(f => f.gz).map(f => f.day));
    // A day with both forms is a compaction that stopped before unlinking: read the gzip only.
    const files = all.filter(f => f.day >= first && (f.gz || !zipped.has(f.day))).sort((a, b) => a.day.localeCompare(b.day));
    for (const f of files) {
      let text;
      try {
        const raw = fs.readFileSync(f.file);
        text = f.gz ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
      } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const rec = JSON.parse(line);
          if (rec && typeof rec === 'object' && !Array.isArray(rec)) records.push(rec);
        } catch { /* a torn or corrupt line is skipped */ }
      }
    }
    records.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  } catch { /* an unreadable directory has no records */ }
  return records;
}

/** For tests: forget the current record and which directories were maintained. */
export function resetUsage() {
  cur = null; finished = true; maintained.clear();
}

// Which agent sessions are alive, so an annotation can be aimed at one.
//
// Without this, every session on the machine sees every annotation and the
// first to consume takes them from the rest. With it, an annotation can carry
// a target, and untargeted ones still go to everybody.
//
// A session is only aimable if the human can tell it apart in a list. Naming
// them `<client> · <basename(cwd)>` failed at exactly that: five Claude
// sessions in ~/Code/glints all rendered "claude-code · glints". So a row
// carries what the session is working on (its first prompt, or an explicit
// label) and where (repo@branch), and identical names get disambiguated
// rather than shown twice.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { CDP_HOME } from './state.mjs';

const DIR = path.join(CDP_HOME, 'sessions');
const STALE_MS = 45 * 60 * 1000;
const TITLE_WORDS = 8;

function ensure() {
  fs.mkdirSync(DIR, { recursive: true });
}

const file = id => path.join(DIR, `${String(id).replace(/[^\w.-]/g, '_')}.json`);

function sh(cmd, args, timeoutMs = 800) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// Where the session is. A detached HEAD reports "HEAD", which says nothing, so
// it is treated as no branch.
export function placeOf(cwd) {
  const top = sh('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
  const branch = sh('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
  return {
    repo: path.basename(top || cwd),
    branch: branch && branch !== 'HEAD' ? branch : '',
  };
}

// Who is on the other end. Codex sends no client name in the MCP handshake, so
// it arrives as 'unknown' and becomes indistinguishable from anything else that
// omits one. Its parent process does say: ChatGPT.app runs `codex … app-server`.
export function inferClient(reported) {
  if (reported && reported !== 'unknown') return reported;
  return clientOfPid(process.ppid) || reported || 'unknown';
}

// Who owns this process, by looking at it and then at its parent. Given a
// session's stored pid this also relabels a row that was registered as
// 'unknown' before the client could be identified, so a long-lived session does
// not have to be restarted to become aimable.
export function clientOfPid(pid) {
  if (!pid) return null;
  for (const target of [pid, parentOf(pid)]) {
    if (!target) continue;
    const args = sh('ps', ['-o', 'args=', '-p', String(target)]);
    if (/codex/i.test(args)) return 'codex';
    if (/claude/i.test(args)) return 'claude-code';
  }
  return null;
}

function parentOf(pid) {
  const out = sh('ps', ['-o', 'ppid=', '-p', String(pid)]);
  const n = Number(out);
  return Number.isFinite(n) && n > 1 ? n : null;
}

// Not everything arriving on the prompt hook was typed by a human. Background
// task notifications, system reminders and slash-command output all come
// through, and one of them named a session "<task-notification> <task-id>ade7b8…".
const NOT_A_PROMPT = [
  /^<task-notification/i,
  /^<system-reminder/i,
  /^<local-command/i,
  /^<command-(name|message|args)/i,
  /^\[SYSTEM NOTIFICATION/i,
  /^Caveat: The messages below/i,
];

// A prompt is a paragraph; a list row is a few words. Take the opening words of
// the first thing the human asked, which is what the session is about.
export function titleFromPrompt(prompt) {
  if (!prompt || typeof prompt !== 'string') return null;
  const flat = prompt.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  if (NOT_A_PROMPT.some(rx => rx.test(flat))) return null;
  const words = flat.split(' ').slice(0, TITLE_WORDS).join(' ');
  return words.length > 60 ? `${words.slice(0, 57)}...` : words;
}

// Null means "not known this time", never "clear what you knew before": the
// hook learns the title on the first prompt and must not wipe it on the next.
function keep(next, prev) {
  return next === null || next === undefined || next === '' ? prev ?? null : next;
}

export function register({ id, client = 'unknown', cwd = process.cwd(), pid = process.pid, label = null, title = null }) {
  if (!id) return null;
  ensure();
  const existing = read(id);
  const place = placeOf(cwd);
  const row = {
    id,
    client,
    cwd,
    pid,
    label: keep(label, existing?.label),
    title: keep(title, existing?.title),
    repo: place.repo,
    branch: place.branch,
    startedAt: existing?.startedAt || Date.now(),
    lastSeen: Date.now(),
  };
  fs.writeFileSync(file(id), JSON.stringify(row, null, 2));
  return row;
}

export function touch(id) {
  const row = read(id);
  if (!row) return null;
  row.lastSeen = Date.now();
  fs.writeFileSync(file(id), JSON.stringify(row, null, 2));
  return row;
}

function read(id) {
  try {
    return JSON.parse(fs.readFileSync(file(id), 'utf8'));
  } catch {
    return null;
  }
}

function where(s) {
  const repo = s.repo || path.basename(s.cwd || '');
  return [repo, s.branch].filter(Boolean).join('@');
}

export function nameOf(s) {
  const what = s.label || s.title || '';
  const place = where(s);
  if (what) return place ? `${what} · ${place}` : what;
  return `${s.client || 'unknown'} · ${place || 'unknown'}`;
}

export function live() {
  ensure();
  const now = Date.now();
  const rows = fs
    .readdirSync(DIR)
    .map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter(s => now - s.lastSeen < STALE_MS)
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map(s => {
      if (s.client === 'unknown') {
        const better = clientOfPid(s.pid);
        if (better) {
          s.client = better;
          try {
            fs.writeFileSync(file(s.id), JSON.stringify(s, null, 2));
          } catch {
            /* a read-only home should not break the listing */
          }
        }
      }
      return { ...s, name: nameOf(s), idleMs: now - s.lastSeen };
    });

  // Two rows reading the same thing are worse than a cryptic row: the human
  // picks one and cannot know which they picked.
  // Disambiguate by pid, not by a slice of the id: two sessions can share an
  // id prefix, and then the two rows still read the same.
  const seen = new Map();
  rows.forEach(r => seen.set(r.name, (seen.get(r.name) || 0) + 1));
  return rows.map(r => (seen.get(r.name) > 1 ? { ...r, name: `${r.name} (pid ${r.pid})` } : r));
}

// An annotation is for this session if it names it, or names nobody.
export function isFor(annotation, sessionId) {
  if (!annotation.for) return true;
  return annotation.for === sessionId;
}

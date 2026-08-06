// Which agent sessions are alive, so an annotation can be aimed at one.
//
// Without this, every session on the machine sees every annotation and the
// first to consume takes them from the rest. With it, an annotation can carry
// a target, and untargeted ones still go to everybody.
import fs from 'fs';
import path from 'path';
import { CDP_HOME } from './state.mjs';

const DIR = path.join(CDP_HOME, 'sessions');
const STALE_MS = 45 * 60 * 1000;

function ensure() {
  fs.mkdirSync(DIR, { recursive: true });
}

const file = id => path.join(DIR, `${String(id).replace(/[^\w.-]/g, '_')}.json`);

export function register({ id, client = 'unknown', cwd = process.cwd(), pid = process.pid, label = null }) {
  if (!id) return null;
  ensure();
  const row = { id, client, cwd, pid, label, startedAt: Date.now(), lastSeen: Date.now() };
  const existing = read(id);
  if (existing) row.startedAt = existing.startedAt;
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

export function live() {
  ensure();
  const now = Date.now();
  return fs
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
    .map(s => ({ ...s, name: s.label || `${s.client} · ${path.basename(s.cwd)}`, idleMs: now - s.lastSeen }));
}

// An annotation is for this session if it names it, or names nobody.
export function isFor(annotation, sessionId) {
  if (!annotation.for) return true;
  return annotation.for === sessionId;
}

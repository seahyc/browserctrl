// Human-set state that outlives a single command: tab aliases and marks.
//
// Marks are deliberately not claims. A claim is the agents' mutual exclusion
// between themselves; a mark is the human saying "this tab is for you". They
// live in different stores because they expire differently and answer
// different questions.
import fs from 'fs';
import path from 'path';
import os from 'os';

export const CDP_HOME = process.env.CDP_HOME || path.join(os.homedir(), '.cdp');
const STATE_FILE = path.join(CDP_HOME, 'state.json');
export const MARK_TTL_MS = 8 * 60 * 60 * 1000;

function ensureHome() {
  fs.mkdirSync(CDP_HOME, { recursive: true });
}

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { aliases: raw.aliases ?? {}, marks: raw.marks ?? {} };
  } catch {
    return { aliases: {}, marks: {} };
  }
}

function write(state) {
  ensureHome();
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

const key = (port, targetId) => `${port}:${targetId}`;

// A forgotten mark must not steer a session tomorrow.
function liveMarks(marks, now = Date.now()) {
  return Object.fromEntries(Object.entries(marks).filter(([, v]) => now - v.ts < MARK_TTL_MS));
}

// ---------------------------------------------------------------- aliases ---

export function setAlias(port, targetId, alias) {
  const state = read();
  // An alias is a name, so it can only point at one tab: drop any previous holder.
  for (const [k, v] of Object.entries(state.aliases)) {
    if (v === alias) delete state.aliases[k];
  }
  state.aliases[key(port, targetId)] = alias;
  write(state);
  return { alias, targetId };
}

export function getAlias(port, targetId) {
  return read().aliases[key(port, targetId)] ?? null;
}

export function findByAlias(port, alias) {
  const wanted = String(alias).toLowerCase();
  for (const [k, v] of Object.entries(read().aliases)) {
    if (v.toLowerCase() === wanted && k.startsWith(`${port}:`)) return k.slice(String(port).length + 1);
  }
  return null;
}

export function clearAlias(port, targetId) {
  const state = read();
  delete state.aliases[key(port, targetId)];
  write(state);
}

// ------------------------------------------------------------------ marks ---

export function mark(port, targetId, { note = null, url = null, title = null } = {}) {
  const state = read();
  state.marks = liveMarks(state.marks);
  state.marks[key(port, targetId)] = { note, url, title, ts: Date.now() };
  write(state);
  return state.marks[key(port, targetId)];
}

export function unmark(port, targetId) {
  const state = read();
  state.marks = liveMarks(state.marks);
  const existed = Boolean(state.marks[key(port, targetId)]);
  delete state.marks[key(port, targetId)];
  write(state);
  return existed;
}

export function marks(port = null) {
  const live = liveMarks(read().marks);
  return Object.entries(live)
    .map(([k, v]) => ({
      port: parseInt(k.split(':')[0], 10),
      targetId: k.slice(k.indexOf(':') + 1),
      ...v,
      ageMs: Date.now() - v.ts,
    }))
    .filter(m => port === null || m.port === port);
}

export function isMarked(port, targetId) {
  return Boolean(liveMarks(read().marks)[key(port, targetId)]);
}

export function clearMarks(port = null) {
  const state = read();
  const live = liveMarks(state.marks);
  let n = 0;
  for (const k of Object.keys(live)) {
    if (port === null || k.startsWith(`${port}:`)) {
      delete live[k];
      n += 1;
    }
  }
  state.marks = live;
  write(state);
  return n;
}

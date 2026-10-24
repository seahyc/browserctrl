// Human-set state that outlives a single command: tab aliases and marks.
//
// Marks are deliberately not claims. A claim is the agents' mutual exclusion
// between themselves; a mark is the human saying "this tab is for you". They
// live in different stores because they expire differently and answer
// different questions.
import fs from 'fs';
import path from 'path';
import { statePath, dirs } from './config.mjs';

export const STATE_DIR = dirs.state;
const STATE_FILE = statePath('state.json');
export const MARK_TTL_MS = 8 * 60 * 60 * 1000;

function ensureHome() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
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

// Every alias set on this browser's tabs.
export function aliasNames(port) {
  return Object.entries(read().aliases).filter(([k]) => k.startsWith(`${port}:`)).map(([, v]) => v);
}

export function getAlias(port, targetId) {
  return read().aliases[key(port, targetId)] ?? null;
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


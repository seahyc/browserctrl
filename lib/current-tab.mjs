// Each agent's current tab, per browser: `browserctrl use <tab>` records it and `open` sets it,
// so later commands may leave the tab out or write `.`. Kept next to the claims file, keyed by
// agent id and port; it holds tab ids and times only, never page content.
// A current tab grants nothing: claims still decide who may act on it.
import fs from 'node:fs';
import path from 'node:path';
import { withFileLock } from './file-lock.mjs';
import { CLAIMS_FILE, agentId } from './env.mjs';
import { ownerGone } from './claims.mjs';

const FILE = path.join(path.dirname(CLAIMS_FILE), 'current-tabs.json');
const keyFor = (owner, port) => `${owner}@${port}`;

function readAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

// An agent known only by its shell's pid ("pid:123") keeps a current tab while that shell lives.
function live(all) {
  return Object.fromEntries(Object.entries(all).filter(([k, v]) => v && typeof v.targetId === 'string' && !ownerGone(k.slice(0, k.lastIndexOf('@')))));
}

function update(fn) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
  return withFileLock(`${FILE}.lock`, () => {
    const all = live(readAll());
    const r = fn(all);
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
    fs.renameSync(tmp, FILE);
    return r;
  });
}

export function get(port, { owner = agentId() } = {}) {
  return live(readAll())[keyFor(owner, port)] ?? null;
}

export function set(port, targetId, { owner = agentId() } = {}) {
  return update(all => (all[keyFor(owner, port)] = { targetId, ts: Date.now() }));
}

// Forget it: always, or only while it is still `targetId` (a tab this agent just closed).
export function clear(port, { owner = agentId(), targetId = null } = {}) {
  return update(all => {
    const k = keyFor(owner, port);
    if (!all[k] || (targetId && all[k].targetId !== targetId)) return false;
    delete all[k];
    return true;
  });
}

// --- Which positional word is the tab --------------------------------------------------
//
// Without a current tab nothing changes: the word after the command is the tab. With one, the
// tab may be left out, and a word counts as the tab only when it is "."; when the command has
// more words than it takes; or when it reads as a tab and nothing else: a tab id (hex, 6 to 32
// characters with a digit), active, focused, marked, or one of the browser's tab aliases. A
// URL, a visible name or a plan step is never a tab id.

// How many words each command takes after its tab: [fewest, most] (Infinity: any number).
const ARITY = {
  read: [0, 0], text: [0, 0], items: [0, 0], fields: [0, 0], table: [0, 0], wait: [0, 0], ready: [0, 0],
  console: [0, 0], network: [0, 0], cookies: [0, 0], close: [0, 0], focus: [0, 0], wake: [0, 0],
  reload: [0, 0], refresh: [0, 0], captcha: [0, 0], dialog: [0, 0], release: [0, 0], overlay: [0, 0],
  mark: [0, 0], unmark: [0, 0], drag: [0, 0], 'scroll-to': [0, 0],
  nav: [1, 1], key: [1, 1],
  click: [0, 2], hover: [0, 2], fill: [0, 2], select: [0, 2],
  check: [0, 1], shot: [0, 1], html: [0, 1], scroll: [0, 1], name: [0, 1],
  do: [0, Infinity], find: [0, Infinity], type: [0, Infinity], eval: [0, Infinity], upload: [0, Infinity], act: [0, Infinity],
};
export const TAB_COMMANDS = new Set(Object.keys(ARITY));

const NAMED_TABS = new Set(['active', 'focused', '@focus', '@me', 'marked']);
export function looksLikeTab(word, aliases = []) {
  const w = String(word);
  if (w === '.' || NAMED_TABS.has(w)) return true;
  if (/^[0-9a-f]{6,32}$/i.test(w) && /\d/.test(w)) return true;
  return aliases.some(a => String(a).toLowerCase() === w.toLowerCase());
}

// The command's words with the tab in place: [cmd, tab, ...rest], where tab is '.' when it
// was left out and a current tab stands in. `hasCurrent` says whether this agent has one.
export function placeTab(positional, { hasCurrent, aliases = [] } = {}) {
  const [cmd, ...args] = positional;
  if (!hasCurrent || !TAB_COMMANDS.has(cmd)) return positional;
  const [fewest, most] = ARITY[cmd];
  if (!args.length) return [cmd, '.'];
  const first = String(args[0]);
  let explicit;
  if (first === '.') explicit = true;
  else if (args.length > most) explicit = true;      // nav <tab> <url>, click <tab> 150 407
  else if (args.length <= fewest) explicit = false;  // nav <url>, key Enter
  else if (cmd === 'click' || cmd === 'hover') {
    // click 150 407 is a point on the current tab; click <tab> "Save" names its tab.
    const num = v => /^-?\d+(\.\d+)?$/.test(String(v));
    explicit = args.length === 2 ? !(num(args[0]) && num(args[1])) : looksLikeTab(first, aliases);
  } else explicit = looksLikeTab(first, aliases);
  return explicit ? positional : [cmd, '.', ...args];
}

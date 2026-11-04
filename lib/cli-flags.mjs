import { TAB_COMMANDS } from './current-tab.mjs';

// What each command accepts, and the Unix spellings agents reach for. A flag a command would
// ignore is a usage error (exit 2) that names the flags it takes, as getopt does: an agent that
// typed `text --head 40` or `wait --ms 2000` learns on the first call instead of repeating a
// no-op for a whole session. Pure functions: bin/browserctrl.mjs applies them before any browser
// is reached.

// Read by every command (or by the code that runs before the command).
export const GLOBAL = ['browser', 'port', 'json', 'jsonl', 'quiet', 'help', 'steal', 'show', 'timeout', 'no-notes', 'agent-id'];

// --then <kind>: after an action that worked, the page as that command shows it, taking that
// command's own flags (click … --then text --tail 40).
export const THEN_FLAGS = {
  text: ['tail', 'head', 'max-text', 'region', 'from', 'to', 'match', 'case-sensitive', 'invert-match', 'line-number', 'fixed-strings'], // not --selector: that is the action's target
  read: ['all', 'max', 'max-text', 'include-hidden', 'text'],
  items: ['all', 'max', 'groups', 'group', 'grep', 'no-prefetch'],
  table: ['max', 'csv', 'jsonl'],
  fields: ['all', 'jsonl'],
};

// The flags each action reads. A target is a name, ref, CSS selector or point; a by-name action
// runs as a one-step do plan, which reads the BY_NAME flags. Every action reads ACTION_COMMON.
export const ACTION_COMMON = ['browser', 'port', 'json', 'quiet', 'help', 'show', 'steal', 'then', 'no-diff', 'timeout', 'agent-id'];
const BY_NAME = ['dismiss', 'min-p', 'no-handoff', 'handoff-timeout', 'no-notes'];
const TARGET = ['ref', 'selector', 'x', 'y', 'token', 'intent', 'expect', 'no-check'];
export const ACTION_FLAGS = {
  click: [...TARGET, ...BY_NAME, 'commit', 'button', 'count', 'mod', 'modifiers'],
  hover: [...TARGET, ...BY_NAME],
  fill: [...TARGET, ...BY_NAME, 'value', 'commit'],
  select: [...TARGET, ...BY_NAME, 'value', 'label'],
  check: [...BY_NAME, 'expect', 'commit'],
  upload: [...TARGET, ...BY_NAME, 'files', 'commit'],
  key: [], type: [],
  nav: ['until', 'force'],
  back: ['until'], forward: ['until'],
  // --background: open never selects the tab, so asking for that is already true.
  open: ['id', 'profile', 'anonymous', 'until', 'force', 'background'],
};

const READING = ['no-wait', 'wait', 'recover'];
// Every other command. Subcommands share their command's list.
export const COMMAND_FLAGS = {
  text: [...THEN_FLAGS.text, 'selector', 'count', 'grep', ...READING],
  read: [...THEN_FLAGS.read, ...READING],
  items: [...THEN_FLAGS.items, ...READING],
  table: [...THEN_FLAGS.table, 'selector', ...READING],
  fields: [...THEN_FLAGS.fields, ...READING],
  find: ['max', 'count', 'enabled', ...READING],
  html: [], eval: [], cookies: [], close: [], focus: [], url: [], whoami: [],
  act: ['steps'],
  do: ['then', 'min-p', 'force', 'no-handoff', 'handoff-timeout', 'dismiss', 'repeat', 'until', 'max', 'collect', 'page-cap',
    'no-dedupe', 'open', 'grep', 'no-prefetch', 'context', 'no-diff', 'file', 'resume', 'replace', 'out', 'each-tab', 'parallel', 'intent'],
  wait: ['selector', 'text', 'url', 'gone', 'present', 'fn', 'network-idle', 'download', 'dir', 'since'],
  ready: ['until', 'selector', 'text', 'url'],
  shot: ['full', 'emulate-focus', 'emulateFocus', 'ref', 'selector', 'viewport', 'scale', 'mask', 'mask-blur', 'require-mask', 'pad', 'out'],
  console: ['limit', 'clear'],
  network: ['limit', 'failed'],
  wake: ['off'],
  reload: ['hard', 'until'], refresh: ['hard', 'until'],
  dialog: ['accept', 'dismiss', 'text'],
  release: ['mine'],
  overlay: ['force', 'on'],
  name: [], mark: ['note'], unmark: [], marks: [],
  scroll: ['dx', 'dy', 'in'],
  'scroll-to': ['ref', 'selector', 'x', 'y', 'token'],
  drag: ['from', 'to'],
  captcha: ['no-attempt', 'no-focus'],
  tabs: ['ids', 'no-focus', 'profile', 'mine'],
  profiles: [], use: ['clear'], status: [], stop: [], restart: [], claims: [],
  activity: ['owner', 'intent', 'completed', 'total'],
  doctor: ['fix', 'watch-seconds'],
  migrate: ['apply'], where: [], browsers: [], usage: ['days'],
  launch: ['headless', 'user-data-dir', 'foreground', 'no-sandbox', 'vnc', 'vnc-info', 'stop', 'no-extension'],
  capture: [], trace: ['last'], site: [], cooldown: [],
  notes: ['path', 'api', 'recipe', 'force', 'reveal', 'on', 'why', 'clear'],
  replay: ['out', 'no-open', 'video', 'gif', 'webp', 'gif-speed', 'trim-start', 'speed', 'width', 'label', 'labels', 'proxy',
    'no-captions', 'no-clock', 'side-by-side', 'fps'],
  rec: ['out', 'label'],
  recipe: ['raw', 'force', 'no-handoff', 'handoff-timeout', 'accept'],
  visit: ['from', 'grep', 'context', 'then', 'parallel', 'max-text', 'force'],
  group: ['url', 'title', 'color', 'collapsed'], ungroup: ['url'],
  'native-tabs': [], 'native-focus': [], 'native-group': ['ids', 'group-id', 'dry-run', 'allow-focus'],
  safari: ['args', 'tab'],
  annotations: ['clear', 'consume'], annotate: [], record: ['apps', 'label', 'video'], recording: ['steps'], recordings: [],
  ext: ['url', 'title', 'color', 'collapsed'], bridge: [], tray: [],
};

// Flags that mean another flag of the same command.
const FLAG_ALIASES = {
  text: { grep: 'match' }, fill: { text: 'value' }, release: { all: 'mine' }, shot: { path: 'out' },
  items: { match: 'grep' }, visit: { match: 'grep' }, do: { match: 'grep' },
};

// Short options, for the commands that have them. Everywhere else only -q exists, so a word
// like "-x" stays an argument (a value to type, a key, a find pattern).
// value: the option takes the next word.
export const SHORT = {
  _: { q: { name: 'quiet' } },
  grep: { i: { name: 'ignore-case' }, v: { name: 'invert-match' }, c: { name: 'count' }, n: { name: 'line-number' },
    F: { name: 'fixed-strings' }, E: { name: 'extended' }, q: { name: 'quiet' } },
  head: { n: { name: 'lines', value: true }, q: { name: 'quiet' } },
  tail: { n: { name: 'lines', value: true }, q: { name: 'quiet' } },
  shot: { o: { name: 'out', value: true }, q: { name: 'quiet' } },
  screenshot: { o: { name: 'out', value: true }, q: { name: 'quiet' } },
};

// Commands where a stray "-n 40" can only be a mistaken option: they take no free text.
const NO_DASH_WORDS = new Set(['text', 'read', 'items', 'table', 'fields', 'tabs', 'console', 'network', 'cookies', 'url', 'back', 'forward', 'reload', 'close']);

// Names agents reach for that mean an existing command (run, not only suggested).
export const COMMAND_ALIASES = {
  screenshot: 'shot', navigate: 'nav', goto: 'nav', go: 'nav', list: 'tabs', ls: 'tabs', press: 'key',
  snapshot: 'read', cat: 'text', cd: 'use', pwd: 'url',
};

// Commands whose first word is the tab (lib/current-tab.mjs lets agents leave it out).
const TAB_FIRST = new Set([...TAB_COMMANDS, 'use', 'rec', 'captcha']);

const usage = message => Object.assign(new Error(message), { exitCode: 2 });

// Flag names that commonly mean "wait this long", which browserctrl never does blindly.
const SLEEPS = ['ms', 'sleep', 'seconds', 'secs', 'delay', 'duration', 'time', 'for'];

export function parseArgs(argv, short = SHORT._) {
  const flags = {};
  const positional = [];
  let endOfOptions = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (endOfOptions) { positional.push(a); continue; }
    if (a === '--') { endOfOptions = true; continue; }
    const s = /^-([a-zA-Z])(.*)$/.exec(a);
    if (s && short[s[1]]) {
      const o = short[s[1]];
      if (o.value) {
        const v = s[2] !== '' ? s[2] : argv[i + 1];
        if (s[2] === '') i += 1;
        flags[o.name] = v;
      } else {
        flags[o.name] = true;
        // -ic: bundled switches.
        for (const ch of s[2]) {
          if (short[ch] && !short[ch].value) flags[short[ch].name] = true;
          else { positional.push(a); delete flags[o.name]; break; }
        }
      }
    } else if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      if (eq > 2) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--') || SWITCHES.has(name) || (name === 'count' && !/^\d+$/.test(next))) flags[name] = true;
      else { flags[name] = next; i += 1; }
    } else positional.push(a);
  }
  return { flags, positional };
}

// Flags that never take a value, so `--json <tab>` keeps the word that follows.
// --count takes one only when it is a number (click --count 2; find … --count).
export const SWITCHES = new Set(['quiet', 'json', 'jsonl', 'enabled', 'no-dedupe', 'id', 'csv', 'commit', 'headless', 'no-sandbox',
  'foreground', 'stop', 'vnc', 'require-mask', 'fix', 'background', 'case-sensitive', 'invert-match', 'line-number', 'fixed-strings',
  'ignore-case', 'extended', 'full', 'all', 'hard', 'failed', 'clear', 'mine', 'accept', 'no-wait', 'recover', 'no-diff', 'no-check',
  'no-handoff', 'no-notes', 'no-prefetch', 'no-focus', 'no-attempt', 'anonymous', 'force', 'present', 'network-idle',
  'emulate-focus', 'include-hidden', 'raw', 'apply', 'dry-run', 'allow-focus', 'off', 'steal', 'help', 'resume']);

// The command line as the command reads it: Unix command names become the command they mean,
// short options are read for commands that have them, and aliased flags take their own name.
// Returns { cmd, alias, flags, positional }; alias is the word typed when it differed.
export function resolve(argv, env = process.env) {
  let { flags, positional } = parseArgs(argv);
  const commandNotes = [];
  // A misspelt command that only looks (txet, tabss, shto) runs as the one meant, with a note.
  const word = positional[0];
  if (typeof word === 'string' && /^[a-z][a-z-]*$/.test(word) && !KNOWN_COMMANDS.has(word)) {
    const near = nearest(word, KNOWN_COMMANDS);
    const target = near && (COMMAND_ALIASES[near] || (['grep', 'head', 'tail'].includes(near) ? 'text' : near));
    if (near && READ_ONLY.has(target)) {
      const i = argv.indexOf(word);
      argv = [...argv.slice(0, i), near, ...argv.slice(i + 1)];
      ({ flags, positional } = parseArgs(argv));
      commandNotes.push(`(ran "${word}" as ${near})`);
    }
  }
  const typed = positional[0];
  if (SHORT[typed]) ({ flags, positional } = parseArgs(argv, { ...SHORT._, ...SHORT[typed] }));
  // --agent-id / --agent: the identity BROWSERCTRL_AGENT_ID sets, for this call.
  for (const k of ['agent-id', 'agent']) {
    if (flags[k] === undefined) continue;
    if (flags[k] === true || !String(flags[k]).trim()) throw usage(`--${k} needs a name: browserctrl --agent-id <name> …  (or BROWSERCTRL_AGENT_ID=<name>)`);
    env.BROWSERCTRL_AGENT_ID = String(flags[k]);
    if (k === 'agent') { flags['agent-id'] = flags.agent; delete flags.agent; }
  }
  let cmd = typed;
  const words = positional.slice(1);
  if (typed === 'grep') {
    // grep [<tab>] PATTERN: the page's lines that match, as grep prints them (case-sensitive
    // unless -i; -v, -n, -c, -F, -q as in grep).
    if (!words.length) throw usage('Usage: browserctrl grep [<tab>] PATTERN [-i] [-v] [-n] [-c] [-F] [-q]');
    if (words.length > 2) throw usage(`grep takes a tab and one PATTERN; quote a pattern with spaces: browserctrl grep ${words[0]} "${words.slice(1).join(' ')}"`);
    flags.match = words[words.length - 1];
    if (!flags['ignore-case']) flags['case-sensitive'] = true;
    delete flags['ignore-case']; delete flags.extended;
    cmd = 'text';
    positional = ['text', ...words.slice(0, -1)];
  } else if (typed === 'head' || typed === 'tail') {
    // head|tail [<tab>] [-n N | -N]: the first or last N lines of the page's text (10 by default).
    let n = flags.lines;
    const rest = [];
    for (const w of words) {
      if (/^-\d+$/.test(w)) n = w.slice(1);
      else if (/^\d+$/.test(w) && rest.length && n === undefined) n = w;
      else rest.push(w);
    }
    if (rest.length > 1) throw usage(`Usage: browserctrl ${typed} [<tab>] [-n N]`);
    n = n === undefined ? '10' : String(n);
    if (!/^\d+$/.test(n) || Number(n) < 1) throw usage(`${typed} -n takes a positive number of lines`);
    delete flags.lines;
    flags[typed] = n;
    cmd = 'text';
    positional = ['text', ...rest];
  } else if (COMMAND_ALIASES[typed]) {
    cmd = COMMAND_ALIASES[typed];
    positional = [cmd, ...words];
  }
  // --tab X: the tab, for commands that take one first (Safari's own --tab is a native handle).
  if (typeof flags.tab === 'string' && TAB_FIRST.has(cmd) && flags.browser !== 'safari') {
    positional = [cmd, flags.tab, ...positional.slice(1)];
    delete flags.tab;
  }
  // --at x,y: a point, as --x and --y.
  if (typeof flags.at === 'string' && Object.hasOwn(ACTION_FLAGS, cmd) && ACTION_FLAGS[cmd].includes('x')) {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(flags.at);
    if (!m) throw usage(`--at takes a point as x,y: browserctrl ${cmd} <tab> --at 120,340`);
    flags.x = m[1]; flags.y = m[2];
    delete flags.at;
  }
  for (const [from, to] of Object.entries(FLAG_ALIASES[cmd] || {})) {
    if (flags[from] !== undefined && flags[to] === undefined) { flags[to] = flags[from]; delete flags[from]; }
  }
  const notes = autocorrect(cmd, flags, positional);
  // shot --out FILE / -o FILE: the file shot takes as its last word.
  if (cmd === 'shot' && typeof flags.out === 'string') {
    if (positional.length > 2) {
      throw usage('shot takes its file once: browserctrl shot <tab> FILE, or --out FILE');
    }
    positional.push(flags.out);
    delete flags.out;
  }
  return { cmd, alias: cmd !== typed ? typed : undefined, flags, positional, notes: [...commandNotes, ...notes] };
}

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // a swap
  }
  return d[a.length][b.length];
}

// Names agents use for a flag a command has under another name. Each is taken as the first
// name in its list that the command takes, with a note on stderr. None is a flag of any command.
export const SYNONYMS = {
  first: ['head'], last: ['tail'], limit: ['max', 'limit'], 'max-chars': ['max-text'], chars: ['max-text'], 'max-chars-text': ['max-text'],
  bytes: ['max-text'], filter: ['match', 'grep'], pattern: ['match', 'grep'], regex: ['match', 'grep'], output: ['out'],
  css: ['selector'], sel: ['selector'], 'case-insensitive': ['ignore-case'], timeout_ms: ['timeout'], 'timeout-ms': ['timeout'],
};

// Commands that only look: a typo in one of their flags (or in their name) is corrected with a
// note instead of an error, since a wrong guess changes nothing on the page. Actions keep the
// error: a guess there could click or fill the wrong thing.
export const READ_ONLY = new Set(['text', 'read', 'items', 'table', 'fields', 'find', 'html', 'tabs', 'console', 'network', 'cookies',
  'url', 'shot', 'wait', 'ready', 'status', 'usage', 'trace', 'where', 'browsers', 'profiles', 'claims', 'whoami', 'doctor', 'site']);

// Every command word: the lists above, the Unix spellings, and commands without a flag list.
const KNOWN_COMMANDS = new Set([...Object.keys(COMMAND_FLAGS), ...Object.keys(ACTION_FLAGS), ...Object.keys(COMMAND_ALIASES),
  'grep', 'head', 'tail', 'help', 'name', 'overlay', 'marks', 'tray', 'bridge', 'annotate', 'annotations', 'record', 'recording', 'recordings', 'ext']);

// Every flag any command takes, so a typo is never "corrected" away from a real flag of another
// command (read --grep says text takes it instead).
const ANY_FLAG = new Set([...GLOBAL, ...ACTION_COMMON, ...Object.values(ACTION_FLAGS).flat(), ...Object.values(COMMAND_FLAGS).flat(),
  ...Object.values(THEN_FLAGS).flat()]);

// The flags cmd takes now (with --then's), or null for a command without a list.
function allowedFor(cmd, flags) {
  const action = Object.hasOwn(ACTION_FLAGS, cmd);
  if (!action && !Object.hasOwn(COMMAND_FLAGS, cmd)) return null;
  const then = action && typeof flags.then === 'string' && Object.hasOwn(THEN_FLAGS, flags.then) ? THEN_FLAGS[flags.then] : [];
  return new Set([...(action ? ACTION_COMMON : GLOBAL), ...(action ? ACTION_FLAGS[cmd] : COMMAND_FLAGS[cmd]), ...then, 'no-notes']);
}

// The one flag a typo most likely meant, or null when none is close or two are equally close.
function nearest(bad, pool) {
  const limit = Math.max(1, Math.floor(bad.length / 3));
  const scored = [...pool].map(f => [f, bad.length >= 3 && (f.startsWith(bad) || bad.startsWith(f)) ? 0.5 : editDistance(bad, f)])
    .sort((a, b) => a[1] - b[1]);
  if (!scored.length || scored[0][1] > limit) return null;
  if (scored[1] && scored[1][1] === scored[0][1]) return null;
  return scored[0][0];
}
function suggest(bad, allowed) {
  const syn = (SYNONYMS[bad] || []).find(f => allowed.includes(f));
  return syn || nearest(bad, allowed);
}

// Renames flags the command would not take to the one meant: a synonym on any command, a typo
// only on a command that just looks. Returns the notes to print on stderr.
export function autocorrect(cmd, flags, positional) {
  const allowed = allowedFor(cmd, flags);
  if (!allowed) return [];
  const notes = [];
  for (const bad of Object.keys(flags)) {
    if (allowed.has(bad)) continue;
    let to = (SYNONYMS[bad] || []).find(f => allowed.has(f));
    if (!to && READ_ONLY.has(cmd) && !ANY_FLAG.has(bad)) to = nearest(bad, allowed);
    if (!to || flags[to] !== undefined) continue;
    let value = flags[bad];
    // A switch typed wrong took the next word as its value: give the word back.
    if (SWITCHES.has(to) && typeof value === 'string') { positional.push(value); value = true; }
    flags[to] = value;
    delete flags[bad];
    notes.push(`(took --${bad} as --${to})`);
  }
  return notes;
}

const shellWord = w => /^[\w@%+=:,./-]+$/.test(w) ? w : `'${String(w).replace(/'/g, `'"'"'`)}'`;

// Throws a usage error (exit 2) when cmd was given a flag it would ignore, or a stray short
// option. Commands this table does not list (internal ones) are not checked.
export function checkFlags(cmd, flags, positional = []) {
  if (cmd === 'wait') {
    const sleep = SLEEPS.find(k => flags[k] !== undefined);
    if (sleep) throw usage(`wait waits for something on the page, not for a time: --text "Saved", --selector ".done", --gone ".spinner", --url /success or --network-idle (each up to --timeout ms, 15000 by default). nav, click and do steps already wait for the page to settle. For a fixed pause, sleep in the shell.`);
  }
  if (NO_DASH_WORDS.has(cmd)) {
    const dash = positional.slice(1).find(w => /^-[a-zA-Z]/.test(String(w)));
    if (dash) {
      const hint = cmd === 'text' && /^-n/.test(dash) ? ' For the first or last lines: --head N or --tail N (or browserctrl head|tail <tab> -n N).' : '';
      throw usage(`${cmd} has no option ${dash}; its options are long ones (--name).${hint} Run browserctrl help.`);
    }
  }
  const action = Object.hasOwn(ACTION_FLAGS, cmd);
  if (!action && !Object.hasOwn(COMMAND_FLAGS, cmd)) return;
  if (action && flags.then !== undefined && !Object.hasOwn(THEN_FLAGS, flags.then)) {
    throw usage(`--then takes ${Object.keys(THEN_FLAGS).join(', ')}: browserctrl ${cmd} <tab> … --then text`);
  }
  const own = action ? ACTION_FLAGS[cmd] : COMMAND_FLAGS[cmd];
  const common = action ? ACTION_COMMON : GLOBAL;
  const thenFlags = action && flags.then ? THEN_FLAGS[flags.then] : [];
  // A do plan that ends in --then items|text reads its own flags only.
  const allowed = new Set([...common, ...own, ...thenFlags, ...(action ? ['no-notes'] : [])]);
  const bad = Object.keys(flags).filter(k => !allowed.has(k));
  if (!bad.length) return;
  const list = bad.map(k => `--${k}`).join(', ');
  if (action) {
    // A flag that shapes what a look at the page shows: say which --then takes it.
    const kind = Object.keys(THEN_FLAGS).find(t => bad.every(k => THEN_FLAGS[t].includes(k)));
    if (kind && !flags.then) throw usage(`${cmd} does not take ${list}; ${kind} does. To ${cmd} and then show the page in one call: browserctrl ${cmd} <tab> … --then ${kind} ${bad.map(k => `--${k}${flags[k] === true ? '' : ` ${shellWord(String(flags[k]))}`}`).join(' ')}`);
  }
  // A flag of a neighbouring command (read --grep, read --tail): say which one takes it.
  const sibling = ['text', 'read', 'items', 'find', 'table', 'fields'].find(c => c !== cmd && bad.every(k => COMMAND_FLAGS[c].includes(k)));
  if (sibling && !action && COMMAND_FLAGS[cmd] && ['text', 'read', 'items', 'find', 'table', 'fields'].includes(cmd)) {
    throw usage(`${cmd} does not take ${list}; ${sibling} does: browserctrl ${sibling} <tab> ${bad.map(k => `--${k}${flags[k] === true ? '' : ` ${shellWord(String(flags[k]))}`}`).join(' ')}`);
  }
  const pool = [...own, ...thenFlags];
  const near = bad.length === 1 ? suggest(bad[0], pool) : null;
  const takes = [...own, ...(action ? ACTION_COMMON : ['browser', 'port', 'json', 'timeout']).filter(f => !['help', 'quiet', 'agent-id'].includes(f))];
  throw usage(`${cmd} does not take ${list}.${near ? ` Did you mean --${near}?` : ''} It takes ${takes.map(f => `--${f}`).join(', ')}, and -q${flags.then && action ? `; with --then ${flags.then} also ${THEN_FLAGS[flags.then].map(f => `--${f}`).join(', ')}` : ''}.`);
}

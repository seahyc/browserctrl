// Where browserctrl keeps things, and how it reads settings.
//
// Settings are environment variables named BROWSERCTRL_<NAME>. The older CDP_<NAME>
// spelling is still read, so existing setups keep working.
//
// Files follow each OS's convention, and BROWSERCTRL_HOME puts everything under one folder:
//   data     notes, recordings, traces, captured traffic   (grows; capped per kind)
//   config   recipes, taps, plugins, Jev key file
//   state    tab aliases, marks, cool-downs, small bookkeeping
//   runtime  daemon sockets, claims, the bridge token        (private to this user)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function setting(name, env = process.env) {
  const v = env[`BROWSERCTRL_${name}`];
  if (v !== undefined && v !== '') return v;
  const legacy = env[`CDP_${name}`];
  return legacy !== undefined && legacy !== '' ? legacy : undefined;
}

export function flag(name, fallback = false, env = process.env) {
  const v = setting(name, env);
  if (v === undefined) return fallback;
  return !/^(0|false|off|no)$/i.test(v);
}

export function visionMode(env = process.env) {
  return setting('VISION', env)?.toLowerCase() === 'off' ? 'off' : 'auto';
}

export function number(name, fallback, env = process.env) {
  const v = Number(setting(name, env));
  return Number.isFinite(v) ? v : fallback;
}

// Where earlier versions kept things, on every OS: data in ~/.local/share/browserctrl, config
// in ~/.config/browserctrl, state in ~/.cdp.
export const legacyDirs = (home = os.homedir()) => ({
  data: path.join(home, '.local', 'share', 'browserctrl'),
  config: path.join(home, '.config', 'browserctrl'),
  state: path.join(home, '.cdp'),
});

/** @returns {import('./types.js').Dirs} */
export function directories({ platform = process.platform, env = process.env, home = os.homedir(), uid = process.getuid?.() ?? os.userInfo().username, exists = fs.existsSync } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const root = setting('HOME', env);
  if (root) return { data: root, config: root, state: root, runtime: p.join(root, 'run'), legacy: [] };
  /** @type {import('./types.js').Dirs} */
  let d;
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || p.join(home, 'AppData', 'Local');
    const roaming = env.APPDATA || p.join(home, 'AppData', 'Roaming');
    d = { data: p.join(local, 'browserctrl'), config: p.join(roaming, 'browserctrl'), state: p.join(local, 'browserctrl', 'state'), runtime: p.join(local, 'browserctrl', 'run') };
  } else if (platform === 'darwin') {
    const app = p.join(home, 'Library', 'Application Support', 'browserctrl');
    // A short runtime path: a unix socket path may hold only about 100 bytes.
    d = { data: app, config: app, state: p.join(app, 'state'), runtime: p.join('/tmp', `browserctrl-${uid}`) };
  } else {
    d = {
      data: p.join(env.XDG_DATA_HOME || p.join(home, '.local', 'share'), 'browserctrl'),
      config: p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'browserctrl'),
      state: p.join(env.XDG_STATE_HOME || p.join(home, '.local', 'state'), 'browserctrl'),
      runtime: env.XDG_RUNTIME_DIR ? p.join(env.XDG_RUNTIME_DIR, 'browserctrl') : p.join('/tmp', `browserctrl-${uid}`),
    };
  }
  // A folder an earlier version made is used where it is while the new place does not exist
  // yet: nothing is moved behind the user's back, and an older browserctrl still running
  // beside this one keeps seeing the same notes, recipes and state. `browserctrl migrate`
  // moves them when the user chooses.
  const old = legacyDirs(home);
  d.legacy = [];
  for (const kind of ['data', 'config', 'state']) {
    if (old[kind] !== d[kind] && exists(old[kind]) && !exists(d[kind])) { d[kind] = old[kind]; d.legacy.push(kind); }
  }
  return d;
}

export const dirs = directories();

export const dataPath = (...parts) => path.join(dirs.data, ...parts);
export const configPath = (...parts) => path.join(dirs.config, ...parts);
export const statePath = (...parts) => path.join(dirs.state, ...parts);
export const runtimePath = (...parts) => path.join(dirs.runtime, ...parts);

// The runtime folder holds sockets and the bridge token, so only its owner may enter it.
// On a shared machine a folder in /tmp that someone else made is refused, not reused.
export function ensureRuntimeDir(dir = dirs.runtime) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return dir;
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a directory browserctrl can use`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`${dir} belongs to another user; set BROWSERCTRL_HOME to a folder of your own`);
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  return dir;
}

// `browserctrl migrate`: move what an earlier version left in the old folders to this OS's
// folders, once the user has stopped any older browserctrl. Each entry moves only into an
// empty place; anything that cannot move stays where it was. With dry, it only says what
// it would do.
/** @returns {[string, string][]} */
export function legacyMoves(home = os.homedir(), target = directories({ home, exists: () => false })) {
  const old = legacyDirs(home);
  /** @type {[string, string][]} */
  const moves = [
    // Recordings are large: they go to the data folder, ahead of the rest of ~/.cdp.
    [path.join(old.state, 'recordings'), path.join(target.data, 'recordings')],
    [old.data, target.data],
    [old.config, target.config],
    [old.state, target.state],
  ];
  return moves.filter(([from, to]) => path.resolve(from) !== path.resolve(to));
}

/** @param {{ moves?: [string, string][], dry?: boolean }} [opts] */
export function migrateLegacy({ moves = legacyMoves(), dry = false } = {}) {
  const done = [];
  // A folder that is itself moved on its own (recordings) is not moved again with its parent.
  const own = new Set(moves.map(([from]) => path.resolve(from)));
  for (const [from, to] of moves) {
    let entries;
    try { entries = fs.readdirSync(from); } catch { continue; }
    if (!dry) fs.mkdirSync(to, { recursive: true });
    for (const name of entries) {
      const src = path.join(from, name), dst = path.join(to, name);
      if (own.has(path.resolve(src))) continue;
      if (fs.existsSync(dst)) { done.push({ from: src, to: dst, skipped: 'already there' }); continue; }
      if (dry) { done.push({ from: src, to: dst }); continue; }
      try { fs.renameSync(src, dst); done.push({ from: src, to: dst }); } catch (e) { done.push({ from: src, to: dst, skipped: e.message }); }
    }
  }
  return done;
}

// Node 22 is the oldest with a built-in WebSocket, which the daemon uses to talk to the
// browser; older versions fail later with "WebSocket is not defined". Say so up front.
export function requireNode(version = process.versions.node) {
  const major = Number(String(version).split('.')[0]);
  if (major >= 22) return;
  process.stderr.write(`browserctrl needs Node.js 22 or newer; this is Node ${version} (${process.execPath}). Install a newer Node from https://nodejs.org/ or select one with your version manager.\n`);
  process.exit(1);
}

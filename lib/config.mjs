// Where browserctrl keeps things, and how it reads settings.
//
// Settings are environment variables named BROWSERCTRL_<NAME>. The older CDP_<NAME>
// spelling is still read, so existing setups keep working.
//
// Files follow each OS's convention, and BROWSERCTRL_HOME puts everything under one folder:
//   data     notes, recordings, traces, captured traffic   (grows; capped per kind)
//   config   recipes, taps, captcha solver settings, Jev key file
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

export function number(name, fallback, env = process.env) {
  const v = Number(setting(name, env));
  return Number.isFinite(v) ? v : fallback;
}

export function directories({ platform = process.platform, env = process.env, home = os.homedir(), uid = process.getuid?.() ?? os.userInfo().username } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const root = setting('HOME', env);
  if (root) return { data: root, config: root, state: root, runtime: p.join(root, 'run') };
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || p.join(home, 'AppData', 'Local');
    const roaming = env.APPDATA || p.join(home, 'AppData', 'Roaming');
    return { data: p.join(local, 'browserctrl'), config: p.join(roaming, 'browserctrl'), state: p.join(local, 'browserctrl', 'state'), runtime: p.join(local, 'browserctrl', 'run') };
  }
  if (platform === 'darwin') {
    const app = p.join(home, 'Library', 'Application Support', 'browserctrl');
    // A short runtime path: a unix socket path may hold only about 100 bytes.
    return { data: app, config: app, state: p.join(app, 'state'), runtime: p.join('/tmp', `browserctrl-${uid}`) };
  }
  return {
    data: p.join(env.XDG_DATA_HOME || p.join(home, '.local', 'share'), 'browserctrl'),
    config: p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'browserctrl'),
    state: p.join(env.XDG_STATE_HOME || p.join(home, '.local', 'state'), 'browserctrl'),
    runtime: env.XDG_RUNTIME_DIR ? p.join(env.XDG_RUNTIME_DIR, 'browserctrl') : p.join('/tmp', `browserctrl-${uid}`),
  };
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

// Earlier versions kept files in ~/.cdp, ~/.local/share/browserctrl, ~/.config/browserctrl
// and ~/.local/share/chrome-cdp. The first run of this version moves each into place once,
// when the new place is still empty; anything it cannot move stays where it was.
export function legacyMoves(home = os.homedir()) {
  return [
    [path.join(home, '.local', 'share', 'browserctrl'), dirs.data],
    [path.join(home, '.config', 'browserctrl'), dirs.config],
    [path.join(home, '.cdp'), dirs.state],
    [path.join(home, '.local', 'share', 'chrome-cdp', 'telemetry'), path.join(dirs.data, 'telemetry')],
  ];
}

let migrated = false;
export function migrateLegacy({ moves = legacyMoves(), log = () => {} } = {}) {
  if (migrated || setting('HOME')) return;
  migrated = true;
  for (const [from, to] of moves) {
    if (path.resolve(from) === path.resolve(to)) continue;
    let entries;
    try { entries = fs.readdirSync(from); } catch { continue; }
    fs.mkdirSync(to, { recursive: true });
    for (const name of entries) {
      const src = path.join(from, name), dst = path.join(to, name);
      if (fs.existsSync(dst)) continue;
      try { fs.renameSync(src, dst); log(`moved ${src} to ${dst}`); } catch {}
    }
  }
}

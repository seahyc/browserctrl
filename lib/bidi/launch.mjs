// Start Firefox or Camoufox on its own profile with WebDriver BiDi on a local port.
// Never touches a running personal browser: a separate instance, a separate profile.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setting, dataPath } from '../config.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export const BIDI_BROWSERS = {
  firefox: { label: 'Firefox', defaultPort: 9337 },
  camoufox: { label: 'Camoufox', defaultPort: 9338 },
};

export const isBidiBrowser = name => Object.hasOwn(BIDI_BROWSERS, String(name || '').toLowerCase());

export function bidiPort(name, { port, env = process.env } = {}) {
  if (port !== undefined && port !== true) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--port must be a TCP port, got "${port}"`);
    return n;
  }
  const key = String(name).toLowerCase();
  const configured = setting(`${key.toUpperCase()}_PORT`, env);
  return configured ? Number(configured) : BIDI_BROWSERS[key].defaultPort;
}

export function bidiCandidates(key, { platform = process.platform, home = os.homedir() } = {}) {
  if (key === 'firefox') {
    if (platform === 'darwin') return ['/Applications/Firefox.app/Contents/MacOS/firefox', '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox', '/Applications/Firefox Nightly.app/Contents/MacOS/firefox'];
    if (platform === 'win32') return [path.win32.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Mozilla Firefox', 'firefox.exe')];
    return ['/usr/bin/firefox', '/usr/bin/firefox-esr', '/snap/bin/firefox', '/usr/lib/firefox/firefox', '/opt/firefox/firefox'];
  }
  if (key === 'camoufox') {
    if (platform === 'darwin') return [path.join(home, 'Library', 'Caches', 'camoufox', 'Camoufox.app', 'Contents', 'MacOS', 'camoufox')];
    if (platform === 'win32') return [path.join(home, 'AppData', 'Local', 'camoufox', 'camoufox', 'Cache', 'camoufox.exe')];
    return [path.join(home, '.cache', 'camoufox', 'camoufox-bin'), path.join(home, '.cache', 'camoufox', 'camoufox')];
  }
  return [];
}

export function findBidiBrowser(key, { platform = process.platform, env = process.env, home = os.homedir(), exists = fs.existsSync, which = whichOnPath } = {}) {
  const override = setting(`${key.toUpperCase()}_BIN`, env);
  if (override) return exists(override) ? override : null;
  const fixed = bidiCandidates(key, { platform, home }).find(p => exists(p));
  if (fixed) return fixed;
  return which(key, platform);
}

function whichOnPath(name, platform) {
  try {
    const out = execFileSync(platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return out.split(/\r?\n/).find(Boolean) || null;
  } catch { return null; }
}

// Quiet first-run prefs for a profile this launch owns. Firefox applies its own remote
// "recommended" prefs when the remote agent starts; these only stop start-up noise.
const USER_JS = [
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("browser.startup.homepage_override.mstone", "ignore");',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
  'user_pref("browser.aboutwelcome.enabled", false);',
].join('\n') + '\n';

export function planBidiLaunch({ key, port, userDataDir, headless = false, platform, env, home, exists, which }) {
  const meta = BIDI_BROWSERS[key];
  const exe = findBidiBrowser(key, { platform, env, home, exists, which });
  if (!exe) throw new Error(`Could not find ${meta.label}. Install it, or set BROWSERCTRL_${key.toUpperCase()}_BIN to its program.`);
  const dir = userDataDir || dataPath('profiles', key);
  const args = ['--remote-debugging-port', String(port), '-no-remote', '-profile', dir, ...(headless ? ['--headless'] : []), 'about:blank'];
  return { exe, args, userDataDir: dir, port, label: meta.label };
}

/** True once something on the port answers HTTP the way Firefox's remote agent does. */
export async function bidiListening(port, { fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  try {
    const r = await fetchImpl(`http://127.0.0.1:${port}/session`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.status === 400 || r.status === 405 || r.status === 426 || r.ok;
  } catch { return false; }
}

export async function startBidiBrowser({ plan, probe = () => bidiListening(plan.port), spawnFn = spawn, readyTimeoutMs = 45000, pollMs = 300, foreground = false }) {
  if (await probe()) return { ready: true, alreadyRunning: true, waitedMs: 0 };
  fs.mkdirSync(plan.userDataDir, { recursive: true });
  const userJs = path.join(plan.userDataDir, 'user.js');
  if (!fs.existsSync(userJs)) fs.writeFileSync(userJs, USER_JS);
  const logFile = path.join(plan.userDataDir, 'browserctrl-launch.log');
  const out = fs.openSync(logFile, 'a');
  const child = spawnFn(plan.exe, plan.args, { detached: !foreground, stdio: ['ignore', out, out] });
  let exited = null;
  let spawnError = null;
  child.on?.('error', e => { spawnError = e; });
  child.on?.('exit', (code, signal) => { exited = { code, signal }; });
  if (!foreground) child.unref?.();
  const started = Date.now();
  while (Date.now() - started < readyTimeoutMs) {
    if (spawnError) throw new Error(`could not start ${plan.exe}: ${spawnError.message}`);
    if (exited) {
      let tail = '';
      try { tail = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-6).join('\n'); } catch {}
      if (/already running|profile.*in use|lock/i.test(tail)) throw new Error(`${plan.label} says the profile ${plan.userDataDir} is in use; close that browser or pass --user-data-dir <another folder>`);
      throw new Error(`${plan.label} exited before WebDriver BiDi started (${exited.code ?? exited.signal}):\n${tail}`);
    }
    if (await probe()) return { ready: true, alreadyRunning: false, waitedMs: Date.now() - started, child, logFile };
    await sleep(pollMs);
  }
  throw new Error(`started ${plan.exe} but WebDriver BiDi did not answer on port ${plan.port} within ${readyTimeoutMs / 1000}s (log: ${logFile})`);
}

export const LAUNCH_STATE = 'browserctrl-launch.json';

export function recordBidiLaunch(dir, state) {
  fs.writeFileSync(path.join(dir, LAUNCH_STATE), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

export async function stopBidiLaunch(dir, { alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } }, kill = process.kill, wait = sleep } = {}) {
  const file = path.join(dir, LAUNCH_STATE);
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { stopped: false, reason: `no browser started by browserctrl launch in ${dir}` }; }
  if (Number.isInteger(state.pid) && alive(state.pid)) {
    try { kill(state.pid, 'SIGTERM'); } catch {}
    for (let i = 0; i < 40 && alive(state.pid); i++) await wait(250);
    if (alive(state.pid)) { try { kill(state.pid, 'SIGKILL'); } catch {} }
  }
  fs.rmSync(file, { force: true });
  return { stopped: true, port: state.port, profile: dir };
}

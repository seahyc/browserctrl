// Relaunch a browser with its debug port, and only report success once the
// port answers. macOS `open -a` on an app that is still quitting just focuses
// the dying instance and drops --args, so the old launcher could print
// "launched" while the browser never came back.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setting, dataPath } from './config.mjs';
import { playwrightChromiumCandidates, headlessArgs, diagnoseEarlyExit, apparmorProfile } from './server-browser.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function relaunchWithDebugPort({
  quit,             // () => Promise: ask the app to quit
  isRunning,        // () => Promise<boolean>
  open,             // () => Promise: open the app with the debug-port args
  probe,            // () => Promise<object|null>: /json/version, null if not up
  quitTimeoutMs = 30000,
  readyTimeoutMs = 45000,
  reopenAfterMs = 10000,
  pollMs = 500,
  now = Date.now,
  wait = sleep,
}) {
  await quit().catch(() => {});
  const quitDeadline = now() + quitTimeoutMs;
  while (await isRunning()) {
    if (now() >= quitDeadline) {
      throw new Error(`browser did not quit within ${quitTimeoutMs / 1000}s; not relaunching (close it manually, then retry)`);
    }
    await wait(pollMs);
  }

  const started = now();
  await open();
  let reopened = false;
  while (now() - started < readyTimeoutMs) {
    const version = await probe().catch(() => null);
    if (version) return { ready: true, version, waitedMs: now() - started, reopened };
    if (!reopened && now() - started >= reopenAfterMs && !(await isRunning())) {
      // The first open raced the old instance's shutdown and was swallowed.
      reopened = true;
      await open();
    }
    await wait(pollMs);
  }
  const running = await isRunning();
  throw new Error(running
    ? `browser is running but its debug port did not answer within ${readyTimeoutMs / 1000}s`
    : `browser did not start within ${readyTimeoutMs / 1000}s${reopened ? ' (reopened once)' : ''}`);
}

// Decide how to launch: relaunch the user's real profile with a debug port, or
// start a separate instance on its own profile (--user-data-dir), which leaves
// the user's normal browser untouched. Throws before anything is quit when the
// real profile cannot be debugged this way (Chrome 136+).
export function planLaunch({ name, meta, userDataDir, extension }) {
  const args = [`--remote-debugging-port=${meta.port}`];
  if (extension) args.push(`--load-extension=${extension}`);
  if (userDataDir) {
    args.push(`--user-data-dir=${userDataDir}`);
    return { separateInstance: true, args, processMatch: `--user-data-dir=${userDataDir}` };
  }
  if (meta.realProfileDebugBlocked) {
    throw new Error(`${meta.label} refuses --remote-debugging-port on your real profile, so nothing was quit. ` +
      `Either ${meta.enable.replace(/, or relaunch with .*$/, '')}, or run: browserctrl launch ${name} --user-data-dir <dir> ` +
      `(a separate ${meta.label} instance on its own profile; your normal ${meta.label} stays open).`);
  }
  return { separateInstance: false, args, processMatch: null };
}

// ---- Linux and Windows: start a separate instance --------------------------------
// There is no safe way to ask the user's running browser to restart on these systems,
// and Chrome 136+ ignores a debug port on the default profile anyway. So we only ever
// start a new instance on its own profile folder and never quit anything.

const WINDOWS_APPS = {
  chrome: ['Google', 'Chrome', 'Application', 'chrome.exe'],
  edge: ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
  brave: ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
  chromium: ['Chromium', 'Application', 'chrome.exe'],
};
const LINUX_PATHS = {
  chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
  edge: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'],
  brave: ['/usr/bin/brave-browser', '/usr/bin/brave', '/opt/brave.com/brave/brave'],
  chromium: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
};
// Names to look up on PATH when none of the fixed places has the browser.
const PATH_NAMES = {
  chrome: ['google-chrome', 'google-chrome-stable', 'chrome'],
  edge: ['microsoft-edge', 'microsoft-edge-stable', 'msedge'],
  brave: ['brave-browser', 'brave'],
  chromium: ['chromium', 'chromium-browser'],
};

const MAC_APPS = {
  chrome: 'Google Chrome', edge: 'Microsoft Edge', brave: 'Brave Browser', chromium: 'Chromium',
};

export function browserCandidates(key, { platform = process.platform, env = process.env } = {}) {
  if (platform === 'darwin') return MAC_APPS[key] ? [`/Applications/${MAC_APPS[key]}.app/Contents/MacOS/${MAC_APPS[key]}`] : [];
  if (platform === 'win32') {
    const file = WINDOWS_APPS[key];
    if (!file) return [];
    return [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean).map(root => path.win32.join(root, ...file));
  }
  return LINUX_PATHS[key] || [];
}

// An explicit BROWSERCTRL_<BROWSER>_BIN first, then the usual install places, then PATH, then
// (Linux, chromium) a Chromium build Playwright downloaded, which is common on servers.
export function findBrowserExecutable(key, { platform = process.platform, env = process.env, exists = fs.existsSync, which = whichOnPath, playwright = playwrightChromiumCandidates } = {}) {
  const override = setting(`${key.toUpperCase()}_BIN`, env);
  if (override) return exists(override) ? override : null;
  const fixed = browserCandidates(key, { platform, env }).find(p => exists(p));
  if (fixed) return fixed;
  for (const name of PATH_NAMES[key] || []) {
    const found = which(name, platform);
    if (found) return found;
  }
  if (platform === 'linux' && key === 'chromium') return playwright({ env }).find(p => exists(p)) || null;
  return null;
}

function whichOnPath(name, platform) {
  try {
    const out = execFileSync(platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return out.split(/\r?\n/).find(Boolean) || null;
  } catch { return null; }
}

// headless: null, 'virtual' (the caller runs it on an Xvfb display) or 'new'. noSandbox only
// when the user asked for it. version: `<exe> --version`, for the headless user agent.
export function planDirectLaunch({ key, meta, userDataDir, extension, port, headless = null, noSandbox = false, version = '', platform = process.platform, env = process.env, exists, which, playwright }) {
  const exe = findBrowserExecutable(key, { platform, env, exists, which, playwright });
  if (!exe) {
    throw new Error(`Could not find ${meta.label} on this computer. Install it, or set BROWSERCTRL_${key.toUpperCase()}_BIN to its executable.`);
  }
  const dir = userDataDir || dataPath('profiles', key);
  const args = [
    `--remote-debugging-port=${port || meta.port}`, `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check',
    ...headlessArgs(headless, { version }),
    ...(noSandbox ? ['--no-sandbox'] : []),
    ...(extension ? [`--load-extension=${extension}`] : []),
  ];
  return { exe, args, userDataDir: dir, headless, port: port || meta.port };
}

// Start it (detached unless foreground) and wait for the debug port to answer. The browser's
// output goes to plan.logFile when given, so an early exit can be explained.
export async function startDetached({ plan, probe, readyTimeoutMs = 30000, pollMs = 500, spawnFn = spawn, now = Date.now, wait = sleep, env = process.env, foreground = false, openLog = f => fs.openSync(f, 'a'), readLog = f => fs.readFileSync(f, 'utf8') }) {
  const already = await probe().catch(() => null);
  if (already) return { ready: true, version: already, waitedMs: 0, alreadyRunning: true };
  const out = plan.logFile ? openLog(plan.logFile) : 'ignore';
  const child = spawnFn(plan.exe, plan.args, { detached: !foreground, stdio: ['ignore', out, out], env: plan.env ? { ...env, ...plan.env } : env });
  let spawnError = null;
  let exited = null;
  child.on?.('error', e => { spawnError = e; });
  child.on?.('exit', (code, signal) => { exited = { code, signal }; });
  if (!foreground) child.unref?.();
  const started = now();
  while (now() - started < readyTimeoutMs) {
    if (spawnError) throw new Error(`could not start ${plan.exe}: ${spawnError.message}`);
    if (exited) {
      let log = '';
      try { log = plan.logFile ? readLog(plan.logFile) : ''; } catch {}
      const profileFile = plan.logFile ? path.join(path.dirname(plan.logFile), 'apparmor-browser-profile') : 'apparmor-browser-profile';
      if (/No usable sandbox|CanCreateUserNamespace|Failed to move to new namespace/i.test(log)) {
        try { fs.writeFileSync(profileFile, apparmorProfile(plan.exe)); } catch {}
      }
      const how = exited.code === null || exited.code === undefined ? `signal ${exited.signal || 'unknown'}` : `exit ${exited.code}`;
      throw new Error(`could not start ${plan.exe} (${how}): ${diagnoseEarlyExit(log, { exe: plan.exe, profileFile })}`);
    }
    const version = await probe().catch(() => null);
    if (version) return { ready: true, version, waitedMs: now() - started, alreadyRunning: false, child };
    await wait(pollMs);
  }
  throw new Error(`started ${plan.exe} but its debug port did not answer within ${readyTimeoutMs / 1000}s. ` +
    `If a browser is already using ${plan.userDataDir}, close it or pass --user-data-dir <another folder>.`);
}

// ---- Stopping a server browser this launch started ---------------------------------
// A detached --headless launch records its processes in the profile, so `--stop` ends
// exactly what it started and nothing else.

export const LAUNCH_STATE = 'browserctrl-launch.json';

export function recordLaunch(userDataDir, state, { write = fs.writeFileSync } = {}) {
  write(path.join(userDataDir, LAUNCH_STATE), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

export async function stopLaunched(userDataDir, { read = f => fs.readFileSync(f, 'utf8'), remove = f => fs.rmSync(f, { force: true }), kill = process.kill, wait = sleep, alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } } } = {}) {
  const file = path.join(userDataDir, LAUNCH_STATE);
  let state;
  try { state = JSON.parse(read(file)); } catch { return { stopped: false, reason: `no browser started by browserctrl launch in ${userDataDir}` }; }
  const ended = [];
  for (const [what, pid] of [['browser', state.pid], ['vnc', state.vncPid], ['display', state.displayPid]]) {
    if (!Number.isInteger(pid) || !alive(pid)) continue;
    try { kill(pid, 'SIGTERM'); } catch {}
    for (let i = 0; i < 20 && alive(pid); i++) await wait(250);
    if (alive(pid)) { try { kill(pid, 'SIGKILL'); } catch {} }
    ended.push(what);
  }
  remove(file);
  if (state.vncInfo) remove(state.vncInfo);
  return { stopped: true, ended, port: state.port, profile: userDataDir };
}

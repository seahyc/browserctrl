// Relaunch a browser with its debug port, and only report success once the
// port answers. macOS `open -a` on an app that is still quitting just focuses
// the dying instance and drops --args, so the old launcher could print
// "launched" while the browser never came back.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setting, dataPath } from './config.mjs';

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

export function browserCandidates(key, { platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') {
    const file = WINDOWS_APPS[key];
    if (!file) return [];
    return [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean).map(root => path.win32.join(root, ...file));
  }
  return LINUX_PATHS[key] || [];
}

// An explicit BROWSERCTRL_<BROWSER>_BIN first, then the usual install places, then PATH.
export function findBrowserExecutable(key, { platform = process.platform, env = process.env, exists = fs.existsSync, which = whichOnPath } = {}) {
  const override = setting(`${key.toUpperCase()}_BIN`, env);
  if (override) return exists(override) ? override : null;
  const fixed = browserCandidates(key, { platform, env }).find(p => exists(p));
  if (fixed) return fixed;
  for (const name of PATH_NAMES[key] || []) {
    const found = which(name, platform);
    if (found) return found;
  }
  return null;
}

function whichOnPath(name, platform) {
  try {
    const out = execFileSync(platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return out.split(/\r?\n/).find(Boolean) || null;
  } catch { return null; }
}

export function planDirectLaunch({ key, meta, userDataDir, extension, platform = process.platform, env = process.env, exists, which }) {
  const exe = findBrowserExecutable(key, { platform, env, exists, which });
  if (!exe) {
    throw new Error(`Could not find ${meta.label} on this computer. Install it, or set BROWSERCTRL_${key.toUpperCase()}_BIN to its executable.`);
  }
  const dir = userDataDir || dataPath('profiles', key);
  const args = [
    `--remote-debugging-port=${meta.port}`, `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check',
    ...(extension ? [`--load-extension=${extension}`] : []),
  ];
  return { exe, args, userDataDir: dir };
}

// Start it detached and wait for the debug port to answer.
export async function startDetached({ plan, probe, readyTimeoutMs = 30000, pollMs = 500, spawnFn = spawn, now = Date.now, wait = sleep }) {
  const already = await probe().catch(() => null);
  if (already) return { ready: true, version: already, waitedMs: 0, alreadyRunning: true };
  const child = spawnFn(plan.exe, plan.args, { detached: true, stdio: 'ignore' });
  let spawnError = null;
  child.on?.('error', e => { spawnError = e; });
  child.unref?.();
  const started = now();
  while (now() - started < readyTimeoutMs) {
    if (spawnError) throw new Error(`could not start ${plan.exe}: ${spawnError.message}`);
    const version = await probe().catch(() => null);
    if (version) return { ready: true, version, waitedMs: now() - started, alreadyRunning: false };
    await wait(pollMs);
  }
  throw new Error(`started ${plan.exe} but its debug port did not answer within ${readyTimeoutMs / 1000}s. ` +
    `If a browser is already using ${plan.userDataDir}, close it or pass --user-data-dir <another folder>.`);
}

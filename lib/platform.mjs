import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { dirs, ensureRuntimeDir } from './config.mjs';

export const isWindows = process.platform === 'win32';
export const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
export const runtimeDirectory = dirs.runtime;

// Earlier versions listened here; a new daemon asks one still running there to exit.
export const legacyDaemonAddress = port => `/tmp/cdp-master-${port}.sock`;

export function daemonAddress(port, platform = process.platform, user = os.userInfo().username) {
  if (platform !== 'win32') return runtimePath(`master-${port}.sock`);
  const tag = crypto.createHash('sha256').update(user.toLowerCase()).digest('hex').slice(0, 12);
  return `\\\\.\\pipe\\browserctrl-${tag}-${port}`;
}

// Sockets, claims and tokens go in the private runtime folder. It is made (or refused,
// if someone else owns it) the first time a path in it is asked for.
let runtimeReady = false;
export function runtimePath(name) {
  if (!runtimeReady) { ensureRuntimeDir(); runtimeReady = true; }
  return path.join(dirs.runtime, name);
}

export function browserDataDirs(browser, platform = process.platform, home = os.homedir(), local = localAppData) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const mac = {
    chrome: ['Google', 'Chrome'], dia: ['Dia'], brave: ['BraveSoftware', 'Brave-Browser'],
    edge: ['Microsoft Edge'], chromium: ['Chromium'], arc: ['Arc', 'User Data'],
  };
  const linux = {
    chrome: ['google-chrome'], dia: ['Dia'], brave: ['BraveSoftware', 'Brave-Browser'],
    edge: ['microsoft-edge'], chromium: ['chromium'], arc: ['arc'],
  };
  const windows = {
    chrome: ['Google', 'Chrome', 'User Data'], dia: ['Dia', 'User Data'],
    brave: ['BraveSoftware', 'Brave-Browser', 'User Data'], edge: ['Microsoft', 'Edge', 'User Data'],
    chromium: ['Chromium', 'User Data'], arc: ['Arc', 'User Data'],
  };
  if (platform === 'win32') return windows[browser] ? [paths.join(local, ...windows[browser])] : [];
  if (platform === 'darwin') {
    const parts = mac[browser];
    return parts ? [paths.join(home, 'Library', 'Application Support', ...parts)] : [];
  }
  const parts = linux[browser];
  if (!parts) return [];
  const dirs = [paths.join(home, '.config', ...parts)];
  const flatpak = { chrome: ['com.google.Chrome', 'google-chrome'], brave: ['com.brave.Browser', 'BraveSoftware/Brave-Browser'], edge: ['com.microsoft.Edge', 'microsoft-edge'], chromium: ['org.chromium.Chromium', 'chromium'] }[browser];
  if (flatpak) dirs.push(paths.join(home, '.var', 'app', flatpak[0], 'config', flatpak[1]));
  return dirs;
}

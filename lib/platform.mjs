import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const isWindows = process.platform === 'win32';
export const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
export const runtimeDirectory = isWindows
  ? path.join(localAppData, 'browserctrl')
  : path.join(process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), '.cache'), 'browserctrl');

export function daemonAddress(port, platform = process.platform, user = os.userInfo().username) {
  if (platform !== 'win32') return `/tmp/cdp-master-${port}.sock`;
  const tag = crypto.createHash('sha256').update(user.toLowerCase()).digest('hex').slice(0, 12);
  return `\\\\.\\pipe\\browserctrl-${tag}-${port}`;
}

export function runtimePath(name) {
  return path.join(runtimeDirectory, name);
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

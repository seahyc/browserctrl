// Shared constants, paths and identity helpers.
import os from 'os';
import path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { browserDataDirs, daemonAddress, runtimePath } from './platform.mjs';
const identities = new AsyncLocalStorage();
export function withAgentIdentity(owner, fn) {
  if (typeof owner !== 'string' || !owner.trim() || owner.length > 256) throw new Error('agentId must be a nonempty string of at most 256 characters');
  return identities.run(owner, fn);
}

export const APP_SUPPORT = process.platform === 'win32'
  ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
  : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config');

// Known Chromium-family browsers. `dataDirs` are searched for DevToolsActivePort
// when the HTTP discovery endpoints are unavailable (Chrome's chrome://inspect
// toggle mode exposes only the browser-level WebSocket, no /json endpoints).
export const BROWSERS = {
  chrome: {
    port: 9222,
    label: 'Chrome',
    app: 'Google Chrome',
    dataDirs: browserDataDirs('chrome'),
    // Chrome 136+ refuses --remote-debugging-port on a real profile.
    enable: 'open the toggle at chrome://inspect/#remote-debugging (real profile), or relaunch with --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug (blank profile)',
  },
  dia: {
    port: 9223,
    label: 'Dia',
    app: 'Dia',
    dataDirs: browserDataDirs('dia'),
    enable: 'browserctrl launch dia   (quits Dia and reopens it with --remote-debugging-port=9223)',
  },
  brave: {
    port: 9224,
    label: 'Brave',
    app: 'Brave Browser',
    dataDirs: browserDataDirs('brave'),
    enable: 'browserctrl launch brave',
  },
  edge: {
    port: 9225,
    label: 'Edge',
    app: 'Microsoft Edge',
    dataDirs: browserDataDirs('edge'),
    enable: 'browserctrl launch edge',
  },
  chromium: {
    port: 9226,
    label: 'Chromium',
    app: 'Chromium',
    dataDirs: browserDataDirs('chromium'),
    enable: 'browserctrl launch chromium',
  },
  arc: {
    port: 9227,
    label: 'Arc',
    app: 'Arc',
    dataDirs: browserDataDirs('arc'),
    enable: 'browserctrl launch arc',
  },
};

if (process.platform !== 'darwin') {
  for (const [key, browser] of Object.entries(BROWSERS)) browser.enable = `Enable browser debugging or start a separate profile with --remote-debugging-port=${browser.port}; then use --browser ${key} or --port <actual-port>. Automatic relaunch is macOS-only.`;
}

export const PORT_TO_KEY = Object.fromEntries(
  Object.entries(BROWSERS).map(([key, b]) => [b.port, key]),
);

export const SOCK = port => daemonAddress(port);
export { runtimePath };
export const CLAIMS_FILE = process.env.CDP_CLAIMS_FILE || (process.platform === 'win32' ? runtimePath('claims.json') : '/tmp/cdp-claims.json');
export const ANONYMOUS_CONTEXTS_FILE = process.platform === 'win32' ? runtimePath('anonymous-contexts.json') : '/tmp/cdp-anonymous-contexts.json';

export const IDLE_EXIT_MS = 300 * 24 * 60 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 30000;
export const CLAIM_TTL_MS = 15 * 60 * 1000;

// Stable-ish identity for the calling agent, so two agents on one browser can
// see who holds which tab. Falls back to the parent pid.
export function agentId() {
  return (
    identities.getStore() ||
    process.env.CDP_AGENT_ID ||
    process.env.CODEX_THREAD_ID ||
    process.env.CODEX_SESSION_ID ||
    process.env.CLAUDE_CODE_SESSION_ID ||
    `pid:${process.pid}`
  );
}

export function agentLabel() {
  if (process.env.CDP_AGENT_LABEL) return process.env.CDP_AGENT_LABEL;
  if (process.env.CODEX_SESSION_ID) return 'codex';
  if (process.env.CLAUDE_CODE_SESSION_ID) return 'claude-code';
  return 'shell';
}

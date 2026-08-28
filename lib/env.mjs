// Shared constants, paths and identity helpers.
import os from 'os';
import path from 'path';

export const APP_SUPPORT = path.join(os.homedir(), 'Library', 'Application Support');

// Known Chromium-family browsers. `dataDirs` are searched for DevToolsActivePort
// when the HTTP discovery endpoints are unavailable (Chrome's chrome://inspect
// toggle mode exposes only the browser-level WebSocket, no /json endpoints).
export const BROWSERS = {
  chrome: {
    port: 9222,
    label: 'Chrome',
    app: 'Google Chrome',
    dataDirs: [path.join(APP_SUPPORT, 'Google', 'Chrome')],
    // Chrome 146+ refuses --remote-debugging-port on a real profile.
    enable: 'open the toggle at chrome://inspect/#remote-debugging (real profile), or relaunch with --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug (blank profile)',
  },
  dia: {
    port: 9223,
    label: 'Dia',
    app: 'Dia',
    dataDirs: [path.join(APP_SUPPORT, 'Dia'), path.join(APP_SUPPORT, 'Dia', 'User Data')],
    enable: 'cdp launch dia   (quits Dia and reopens it with --remote-debugging-port=9223)',
  },
  brave: {
    port: 9224,
    label: 'Brave',
    app: 'Brave Browser',
    dataDirs: [path.join(APP_SUPPORT, 'BraveSoftware', 'Brave-Browser')],
    enable: 'cdp launch brave',
  },
  edge: {
    port: 9225,
    label: 'Edge',
    app: 'Microsoft Edge',
    dataDirs: [path.join(APP_SUPPORT, 'Microsoft Edge')],
    enable: 'cdp launch edge',
  },
  chromium: {
    port: 9226,
    label: 'Chromium',
    app: 'Chromium',
    dataDirs: [path.join(APP_SUPPORT, 'Chromium')],
    enable: 'cdp launch chromium',
  },
  arc: {
    port: 9227,
    label: 'Arc',
    app: 'Arc',
    dataDirs: [path.join(APP_SUPPORT, 'Arc', 'User Data')],
    enable: 'cdp launch arc',
  },
};

export const PORT_TO_KEY = Object.fromEntries(
  Object.entries(BROWSERS).map(([key, b]) => [b.port, key]),
);

export const SOCK = port => `/tmp/cdp-master-${port}.sock`;
export const CLAIMS_FILE = '/tmp/cdp-claims.json';
export const ANONYMOUS_CONTEXTS_FILE = '/tmp/cdp-anonymous-contexts.json';

export const IDLE_EXIT_MS = 30 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 15000;
export const CLAIM_TTL_MS = 15 * 60 * 1000;

// Stable-ish identity for the calling agent, so two agents on one browser can
// see who holds which tab. Falls back to the parent pid.
export function agentId() {
  return (
    process.env.CDP_AGENT_ID ||
    process.env.CODEX_SESSION_ID ||
    process.env.CLAUDE_CODE_SESSION_ID ||
    `pid:${process.ppid}`
  );
}

export function agentLabel() {
  if (process.env.CDP_AGENT_LABEL) return process.env.CDP_AGENT_LABEL;
  if (process.env.CODEX_SESSION_ID) return 'codex';
  if (process.env.CLAUDE_CODE_SESSION_ID) return 'claude-code';
  return 'shell';
}

// Notices to the person through agent-notify (~/Code/agent-notify), the notification
// layer every agent tool on the Mac shares: one look, keyed notices that replace instead of
// stacking, withdrawn once resolved, and a click that takes the person to the right place.
// macOS only, and only where agent-notify is installed. A notice never affects the work.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { flag } from './config.mjs';
import { PORT_TO_KEY } from './env.mjs';

// Browsers a click brings to the front, by browserctrl key.
export const BUNDLES = {
  dia: 'company.thebrowser.dia', chrome: 'com.google.Chrome', brave: 'com.brave.Browser',
  edge: 'com.microsoft.edgemac', arc: 'company.thebrowser.Browser', chromium: 'org.chromium.Chromium',
};
const NAMES = { dia: 'Dia', chrome: 'Chrome', brave: 'Brave', edge: 'Edge', arc: 'Arc', chromium: 'Chromium' };

export const browserBundle = port => BUNDLES[PORT_TO_KEY[port]] || null;
export const browserName = port => NAMES[PORT_TO_KEY[port]] || 'the browser';

// The agent-notify program, or null where notices can't be shown. A detached daemon's PATH may
// lack ~/.local/bin, so that is checked too.
export function notifier({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (platform !== 'darwin' || !flag('NOTIFY', true, env)) return null;
  const dirs = [...String(env.PATH || '').split(':').filter(Boolean), path.join(home, '.local/bin')];
  for (const dir of dirs) {
    const file = path.join(dir, 'agent-notify');
    try { if (fs.statSync(file).isFile()) return file; } catch {}
  }
  return null;
}

function run(program, args) {
  try {
    const child = execFile(program, args, { windowsHide: true }, () => {});
    child.on('error', () => {});
  } catch {}
}

export function postNotice(args, { program = notifier(), runner = run } = {}) {
  if (!program) return false;
  runner(program, ['post', '--source', 'browserctrl', ...args]);
  return true;
}

export function clearNotice(key, { program = notifier(), runner = run } = {}) {
  if (!program || !key) return false;
  runner(program, ['clear', '--source', 'browserctrl', '--key', key]);
  return true;
}

// Run `work`; if it is still waiting on the person after `delayMs`, post a notice, and withdraw
// it however the wait ends. A wait that finishes in time never notifies.
export async function noticeWhileWaiting(work, { delayMs, key, post, clear = clearNotice }) {
  let posted = false;
  const timer = setTimeout(() => { posted = Boolean(post()); }, delayMs);
  timer.unref?.();
  try {
    return await work();
  } finally {
    clearTimeout(timer);
    if (posted) clear(key);
  }
}

// Chromium's remote-debugging prompt ("Allow"), which a new connection waits on silently.
export const DEBUG_PROMPT_NOTICE_MS = 3000;
export function debugPromptNotice(port, { program = notifier(), runner = run } = {}) {
  const key = `allow-debugging-${port}`;
  const name = browserName(port);
  const bundle = browserBundle(port);
  return {
    key,
    post: () => postNotice([
      '--title', `🔌 ${name} wants you to allow debugging`,
      '--message', `An agent can't connect until you click Allow in ${name}'s remote debugging prompt.`,
      '--urgency', 'urgent', '--key', key, '--kind', 'browser-debug', ...(bundle ? ['--activate', bundle] : []),
      ...(bundle ? ['--button', `go=🔌 Switch to ${name}`] : []), '--button', 'snooze',
    ], { program, runner }),
    clear: () => clearNotice(key, { program, runner }),
  };
}

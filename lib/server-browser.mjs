// Running a Chromium browser on a server: no screen, often no user namespaces, and sites
// that turn away "HeadlessChrome". Helpers for `browserctrl launch <browser> --headless`.
//
// * virtual (the default on Linux when Xvfb is installed): the full browser on a private
//   Xvfb display. Pages see a normal desktop browser, and a VNC viewer can attach to the
//   display for a human handoff.
// * new: Chromium's own headless mode, with "Headless" removed from the user agent.
// * Sandbox: Ubuntu 23.10+ blocks the unprivileged user namespaces Chromium's sandbox
//   needs unless an AppArmor profile allows them. A browser that dies on that is reported
//   with the profile to install; --no-sandbox is honoured only when asked for.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

export const HEADLESS_MODES = ['virtual', 'new'];
export const DEFAULT_WINDOW = { width: 1280, height: 900 };

/** `--headless` alone means virtual where Xvfb exists, else Chromium's headless mode. */
export function resolveHeadlessMode(value, { platform = process.platform, hasXvfb = () => Boolean(findXvfb()) } = {}) {
  if (value === undefined || value === false) return null;
  const mode = value === true || value === '' ? null : String(value).toLowerCase();
  if (mode && !HEADLESS_MODES.includes(mode)) throw new Error(`--headless must be ${HEADLESS_MODES.join(' or ')}, got "${value}"`);
  if (mode === 'virtual' && platform !== 'linux') throw new Error('--headless=virtual needs Linux with Xvfb; use --headless=new here');
  if (mode === 'virtual' && !hasXvfb()) throw new Error('--headless=virtual needs Xvfb (apt install xvfb); or use --headless=new');
  return mode ?? (platform === 'linux' && hasXvfb() ? 'virtual' : 'new');
}

export function findXvfb({ exists = fs.existsSync } = {}) {
  return ['/usr/bin/Xvfb', '/bin/Xvfb', '/usr/local/bin/Xvfb'].find(p => exists(p)) || null;
}

/** Playwright's downloaded Chromium builds, newest first (a common server install). */
export function playwrightChromiumCandidates({ home = os.homedir(), env = process.env, readdir = safeReaddir } = {}) {
  const base = env.PLAYWRIGHT_BROWSERS_PATH || path.join(home, '.cache', 'ms-playwright');
  const builds = readdir(base)
    .map(name => /^chromium-(\d+)$/.exec(name))
    .filter(Boolean)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  return builds.flatMap(m => [path.join(base, m[0], 'chrome-linux', 'chrome'), path.join(base, m[0], 'chrome-linux64', 'chrome')]);
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

const UA_PLATFORM = {
  linux: 'X11; Linux x86_64',
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  win32: 'Windows NT 10.0; Win64; x64',
};

/** A desktop user agent for this browser build and OS: what a visible window would send. */
export function desktopUserAgent(versionText, platform = process.platform) {
  const major = /(\d+)\.\d+\.\d+\.\d+/.exec(String(versionText || ''))?.[1];
  if (!major) return null;
  return `Mozilla/5.0 (${UA_PLATFORM[platform] || UA_PLATFORM.linux}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export function browserVersion(exe, { run = execFileSync } = {}) {
  try {
    return run(exe, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim();
  } catch { return ''; }
}

/** Extra browser arguments for a headless mode (window size, headless flag, user agent). */
export function headlessArgs(mode, { version = '', window = DEFAULT_WINDOW, platform = process.platform } = {}) {
  const size = `--window-size=${window.width},${window.height}`;
  if (mode === 'virtual') return [size, '--window-position=0,0', '--disable-dev-shm-usage'];
  if (mode === 'new') {
    const ua = desktopUserAgent(version, platform);
    return ['--headless=new', size, '--disable-dev-shm-usage', ...(ua ? [`--user-agent=${ua}`] : [])];
  }
  return [];
}

/** The first X display number with neither a socket nor a lock file. */
export function freeDisplay({ from = 90, to = 199, exists = fs.existsSync } = {}) {
  for (let n = from; n <= to; n++) {
    if (!exists(`/tmp/.X11-unix/X${n}`) && !exists(`/tmp/.X${n}-lock`)) return n;
  }
  throw new Error(`no free X display between :${from} and :${to}`);
}

/** Start Xvfb on a free display and wait for its socket. Resolves { display, process }. */
export async function startVirtualDisplay({ window = DEFAULT_WINDOW, xvfb = findXvfb(), spawnFn = spawn, exists = fs.existsSync, detached = true, timeoutMs = 10000 } = {}) {
  if (!xvfb) throw new Error('Xvfb is not installed (apt install xvfb)');
  const n = freeDisplay({ exists });
  const child = spawnFn(xvfb, [`:${n}`, '-screen', '0', `${window.width}x${window.height}x24`, '-nolisten', 'tcp', '-ac'], { detached, stdio: 'ignore' });
  let failed = null;
  child.on?.('error', e => { failed = e; });
  child.on?.('exit', code => { failed ??= new Error(`Xvfb exited with ${code}`); });
  if (detached) child.unref?.();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (failed) throw new Error(`could not start Xvfb on :${n}: ${failed.message}`);
    if (exists(`/tmp/.X11-unix/X${n}`)) return { display: `:${n}`, process: child };
    await new Promise(r => setTimeout(r, 100));
  }
  try { child.kill?.(); } catch {}
  throw new Error(`Xvfb did not open display :${n} within ${timeoutMs / 1000}s`);
}

/** True when the kernel blocks unprivileged user namespaces (Ubuntu 23.10+ AppArmor default). */
export function userNamespacesRestricted({ read = p => fs.readFileSync(p, 'utf8') } = {}) {
  try { return read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns').trim() === '1'; } catch { return false; }
}

/** An AppArmor profile that lets this one browser binary create its sandbox namespaces. */
export function apparmorProfile(exe) {
  const name = `browserctrl-${path.basename(path.dirname(exe))}-${path.basename(exe)}`.replace(/[^A-Za-z0-9_.-]/g, '-');
  return `abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile ${name} ${exe} flags=(unconfined) {\n  userns,\n  include if exists <local/${name}>\n}\n`;
}

/** Explain a browser that died before its debug port opened, using the end of its log. */
export function diagnoseEarlyExit(log, { exe, profileFile } = {}) {
  const text = String(log || '');
  if (/No usable sandbox|setuid sandbox|Failed to move to new namespace|CanCreateUserNamespace/i.test(text)) {
    return `the browser's sandbox could not start: this system blocks unprivileged user namespaces (AppArmor). ` +
      `Install the profile written to ${profileFile} with:\n  sudo install -m 0644 ${profileFile} /etc/apparmor.d/ && sudo apparmor_parser -r /etc/apparmor.d/${path.basename(profileFile)}\n` +
      `Or, if you accept running without Chromium's sandbox, pass --no-sandbox (${exe}).`;
  }
  if (/Missing X server|cannot open display/i.test(text)) return 'the browser could not open its display; use --headless (virtual or new)';
  if (/SingletonLock|profile appears to be in use/i.test(text)) return 'another browser is using this profile; close it or pass --user-data-dir <another folder>';
  const tail = text.trim().split('\n').slice(-5).join('\n');
  return tail ? `the browser exited before its debug port opened:\n${tail}` : 'the browser exited before its debug port opened';
}

/**
 * A VNC server on the virtual display for a human handoff (logins, captchas). It listens on
 * 127.0.0.1 only and has no password, so reach it through an authenticated tunnel or relay.
 * Resolves { port, process } once x11vnc reports its port.
 */
export async function startVnc({ display, spawnFn = spawn, detached = true, firstPort = 5900, timeoutMs = 10000 } = {}) {
  const child = spawnFn('x11vnc', ['-display', display, '-localhost', '-autoport', String(firstPort), '-nopw', '-forever', '-shared', '-quiet'],
    { detached, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(value); };
    const scan = chunk => {
      const port = /PORT=(\d+)/.exec(String(chunk))?.[1];
      if (port) done(null, { port: Number(port), process: child });
    };
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);
    child.on?.('error', e => done(new Error(`could not start x11vnc (apt install x11vnc): ${e.message}`)));
    child.on?.('exit', code => done(new Error(`x11vnc exited before listening (${code})`)));
    const timer = setTimeout(() => { try { child.kill?.(); } catch {} done(new Error('x11vnc did not report a port in time')); }, timeoutMs);
    if (detached) child.unref?.();
  });
}

/** The handoff file other tools read to find the VNC server: {"port","display","ts"}. */
export function writeVncInfo(file, { port, display }, { write = fs.writeFileSync } = {}) {
  write(file, JSON.stringify({ port, display, ts: Date.now() }) + '\n', { mode: 0o600 });
}

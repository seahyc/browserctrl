// Browser profiles: which profile each tab belongs to, and opening tabs in one.
//
// CDP lists every profile's tabs, each with a browserContextId, but nothing
// names the profile behind a context. And Target.createTarget only accepts the
// *default* context (Chrome's last-used profile, which moves as the user
// switches windows) or contexts CDP created itself; any other profile's id
// fails with "Failed to find browser context". So:
//   - names come from the browser's own `Local State` (profile.info_cache);
//   - a context is identified by loading chrome://version in a tab of it and
//     reading its Profile Path. The default context gets that tab from
//     Target.createTarget. Any other gets it from a scripted cmd/ctrl-click in
//     one of its tabs (isolated world, so the page cannot interfere), which
//     opens a background tab in the same profile that CDP may then navigate
//     anywhere, chrome:// included. The same trick opens URLs there;
//   - identities are cached per port. Context ids are random per browser
//     launch, so a stale entry can never match a live context;
//   - a profile with no tabs has no context at all. Only launching the browser
//     binary with --profile-directory, which the process singleton forwards to
//     the running instance, can create one.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { BROWSERS, PORT_TO_KEY, runtimePath } from './env.mjs';
import * as claims from './claims.mjs';
import { newTab } from './ops.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isPage = t => t.type === 'page' && !t.url.startsWith('devtools://');

// ------------------------------------------------------------ pure logic ----

// "Default", "Profile 1", "Profile 2", ..., "Profile 10", then anything else.
function profileOrder(a, b) {
  const rank = d => (d === 'Default' ? -1 : /^Profile \d+$/.test(d) ? Number(d.slice(8)) : Infinity);
  return rank(a.dir) - rank(b.dir) || a.dir.localeCompare(b.dir);
}

export function parseLocalState(state) {
  const cache = state?.profile?.info_cache;
  if (!cache || typeof cache !== 'object') return [];
  const lastActive = Array.isArray(state.profile.last_active_profiles) ? state.profile.last_active_profiles : [];
  return Object.entries(cache)
    .map(([dir, info]) => ({
      dir,
      name: info?.name || dir,
      email: info?.user_name || null,
      lastActive: lastActive.includes(dir),
    }))
    .sort(profileOrder);
}

const describe = profiles => profiles.map(p => `${p.name} (${p.dir}${p.email ? `, ${p.email}` : ''})`).join(', ') || '(none)';

// Directory name, account email, exact display name, then unique display-name
// prefix; all case-insensitive. Display names repeat (several "modelmonkey.io"
// profiles), and guessing between two matches would open the wrong account.
export function resolveProfile(profiles, query) {
  const wanted = String(query ?? '').trim().toLowerCase();
  if (!wanted) throw new Error(`No profile given. Profiles: ${describe(profiles)}`);
  const exact = profiles.find(p => p.dir.toLowerCase() === wanted || p.email?.toLowerCase() === wanted);
  if (exact) return exact;
  for (const match of [p => p.name.toLowerCase() === wanted, p => p.name.toLowerCase().startsWith(wanted)]) {
    const hits = profiles.filter(match);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new Error(`Ambiguous profile "${query}": matches ${describe(hits)}. Use the directory name or account email.`);
  }
  throw new Error(`Unknown profile "${query}". Profiles: ${describe(profiles)}`);
}

// `ps -o command=` joins argv with spaces, so a path with spaces is ambiguous.
// Split on " --flag" boundaries; the caller trims a trailing positional (the
// start URL) by checking which prefix exists on disk.
export function parseProcessCommand(command) {
  const parts = String(command).trim().split(/ (?=--[a-z])/);
  const flags = {};
  for (const part of parts.slice(1)) {
    const m = part.match(/^--([a-z0-9-]+)(?:=(.*))?$/s);
    if (m) flags[m[1]] = m[2] ?? true;
  }
  return { exe: parts[0], userDataDir: typeof flags['user-data-dir'] === 'string' ? flags['user-data-dir'] : null };
}

// Map each live context to a profile directory. Contexts CDP created
// (anonymous tabs) are nobody's profile. With one profile there is nothing to
// tell apart, so no probe is needed.
export function mapContexts({ contexts, cache, profiles, userDataDir, anonymous = [] }) {
  const map = new Map();
  for (const ctx of contexts) {
    if (!ctx || anonymous.includes(ctx)) continue;
    const known = cache[ctx];
    if (known && (!userDataDir || samePath(path.dirname(known), userDataDir))) map.set(ctx, path.basename(known));
    else if (profiles.length === 1) map.set(ctx, profiles[0].dir);
    else map.set(ctx, null);
  }
  return map;
}

// /tmp and /private/tmp are one directory on macOS; Chrome reports the latter.
function samePath(a, b) {
  const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return real(a) === real(b);
}

// ----------------------------------------------------------------- cache ----

const cacheFile = port => process.env.BROWSERCTRL_PROFILE_CONTEXTS
  ? `${process.env.BROWSERCTRL_PROFILE_CONTEXTS}-${port}.json`
  : runtimePath(`profile-contexts-${port}.json`);

function loadCache(port) {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(port), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

// Only live contexts are kept: a closed profile's id never comes back.
function saveCache(port, cache, live) {
  const kept = Object.fromEntries(Object.entries(cache).filter(([ctx]) => live.has(ctx)));
  const file = cacheFile(port);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(kept, null, 2));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------- the process ----

const run = (cmd, args) => new Promise(resolve =>
  execFile(cmd, args, { maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? '' : stdout)));

// The browser behind a port: its executable (to open a profile window) and its
// --user-data-dir. A forwarded or remote port has no such local process.
export async function browserProcess(port) {
  if (!['darwin', 'linux'].includes(process.platform)) return null;
  const pid = (await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'])).match(/^p(\d+)$/m)?.[1];
  if (!pid) return null;
  let exe;
  let userDataDir;
  if (process.platform === 'linux') {
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    exe = argv[0];
    userDataDir = argv.find(a => a.startsWith('--user-data-dir='))?.slice(16) ?? null;
  } else {
    ({ exe, userDataDir } = parseProcessCommand(await run('/bin/ps', ['-ww', '-o', 'command=', '-p', pid])));
    // "--user-data-dir=/tmp/x about:blank": drop trailing words until it exists.
    const words = userDataDir?.split(' ') ?? [];
    while (words.length && !fs.existsSync(words.join(' '))) words.pop();
    userDataDir = words.length ? words.join(' ') : null;
  }
  if (!exe) return null;
  const key = Object.entries(BROWSERS).find(([, b]) => exe.includes(`/${b.app}.app/`))?.[0] ?? PORT_TO_KEY[port];
  return { pid: Number(pid), exe, userDataDir, key };
}

// ----------------------------------------------------------------- probes ---

const webFirst = t => (/^(https?|file):|^about:blank/.test(t.url) ? 0 : 1);

// A background tab in `ctx`, made from inside one of its own tabs: a modified
// click on a noopener link opens in the background without raising the window.
async function scratchTab(conn, ctx, pages) {
  const marker = `browserctrl-profile-${process.pid}-${Date.now().toString(36)}`;
  const modifier = process.platform === 'darwin' ? 'metaKey' : 'ctrlKey';
  const expression = `(() => { const a = document.createElement('a'); a.href = 'about:blank#${marker}';
    a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.dispatchEvent(new MouseEvent('click', { ${modifier}: true, bubbles: true, cancelable: true })); })()`;
  const sources = pages.filter(t => t.browserContextId === ctx).sort((a, b) => webFirst(a) - webFirst(b)).slice(0, 3);
  const errors = [];
  for (const source of sources) {
    try {
      const light = { light: true };
      // A frozen background tab queues Page.* forever; an evaluate makes the
      // daemon thaw it first (see THAW_BEFORE in daemon.mjs).
      await conn.send(source.targetId, 'Runtime.evaluate', { expression: '0' }, 8000, light);
      const { frameTree } = await conn.send(source.targetId, 'Page.getFrameTree', {}, 8000, light);
      const { executionContextId } = await conn.send(source.targetId, 'Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'browserctrl-profile' }, 8000, light);
      await conn.send(source.targetId, 'Runtime.evaluate', { expression, contextId: executionContextId, userGesture: true }, 8000, light);
      for (const deadline = Date.now() + 3000; Date.now() < deadline; await sleep(100)) {
        const { targetInfos } = await conn.browser('Target.getTargets');
        const made = targetInfos.find(t => t.url.endsWith(`#${marker}`));
        if (made?.browserContextId === ctx) return made.targetId;
        if (made) throw new Error('scratch tab opened in another profile');
      }
      throw new Error('no tab appeared');
    } catch (e) {
      errors.push(`${source.targetId.slice(0, 8)}: ${e.message}`);
    }
  }
  throw new Error(`Could not open a tab in that profile from its existing tabs (${errors.join('; ') || 'it has no tabs'}).`);
}

const VERSION_URL = 'chrome://version';

// A hidden chrome://version tab leaves its Profile Path cell empty and gets
// WebUI replies only after 10-20s of background throttling. Focus emulation
// brings that to ~0.5s (measured, Chrome 155), but it is per renderer, so set
// it only once the WebUI document has committed; then ask the handler directly.
// The tab is closed straight after, so the emulation needs no undoing.
async function readProfilePath(conn, targetId) {
  const light = { light: true };
  const evaluate = (expression, timeoutMs) => conn.send(targetId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs, light)
    .then(r => r?.result?.value, () => null);
  for (const deadline = Date.now() + 15000; Date.now() < deadline; await sleep(200)) {
    if (!String(await evaluate('location.href', 2000)).startsWith(VERSION_URL)) continue;
    await conn.send(targetId, 'Emulation.setFocusEmulationEnabled', { enabled: true }, 3000, light).catch(() => {});
    const value = await evaluate(`document.getElementById('profile_path')?.textContent ||
      import('chrome://resources/js/cr.js').then(m => m.sendWithPromise('requestPathInfo')).then(i => i.profilePath, () => null)`, 5000);
    if (value) return value.trim();
  }
  throw new Error(`${VERSION_URL} did not report a profile path`);
}

// The full profile path behind a context, e.g. /tmp/ud/Profile 1. The default
// context takes Target.createTarget; any other needs a scratch tab.
export async function probeContext(conn, ctx, { defaultContextId, pages }) {
  let targetId = null;
  if (ctx === defaultContextId) {
    targetId = await conn.browser('Target.createTarget', { url: VERSION_URL, browserContextId: ctx, background: true })
      .then(r => r.targetId, () => null); // the default moved since we asked
  }
  if (!targetId) {
    targetId = await scratchTab(conn, ctx, pages);
    await conn.send(targetId, 'Page.navigate', { url: VERSION_URL }, 5000, { light: true })
      .catch(async e => { await conn.browser('Target.closeTarget', { targetId }).catch(() => {}); throw e; });
  }
  try {
    return await readProfilePath(conn, targetId);
  } finally {
    await conn.browser('Target.closeTarget', { targetId }).catch(() => {});
  }
}

// ---------------------------------------------------------------- inspect ---

// Everything the frontends need: profiles from Local State, each with its live
// contexts and tab count, and the context -> profile map. Probes unknown
// contexts unless told not to.
export async function inspect(conn, { probe = true } = {}) {
  const { targetInfos } = await conn.browser('Target.getTargets');
  const { browserContextIds: anonymous = [], defaultBrowserContextId: defaultContextId = null } =
    await conn.browser('Target.getBrowserContexts').catch(() => ({}));
  const pages = targetInfos.filter(isPage);
  const live = new Set(targetInfos.map(t => t.browserContextId).filter(Boolean));
  const pageContexts = [...new Set(pages.map(t => t.browserContextId).filter(c => c && !anonymous.includes(c)))];
  const cache = loadCache(conn.port);

  let userDataDir = Object.entries(cache).find(([ctx]) => live.has(ctx))?.[1];
  userDataDir = userDataDir ? path.dirname(userDataDir) : null;
  const proc = userDataDir ? null : await browserProcess(conn.port);
  if (proc) {
    userDataDir = proc.userDataDir ||
      (BROWSERS[proc.key]?.dataDirs ?? []).find(d => fs.existsSync(path.join(d, 'Local State'))) || null;
  }
  if (!userDataDir && probe && pageContexts.length) {
    const ctx = pageContexts.includes(defaultContextId) ? defaultContextId : pageContexts[0];
    const found = await probeContext(conn, ctx, { defaultContextId, pages }).catch(() => null);
    if (found) {
      cache[ctx] = found;
      userDataDir = path.dirname(found);
    }
  }
  if (!userDataDir) throw new Error(`Cannot tell which user-data directory the browser on port ${conn.port} uses, so its profiles are unknown.`);

  let localState;
  try {
    localState = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read profiles from ${path.join(userDataDir, 'Local State')}: ${e.message}`);
  }
  const profiles = parseLocalState(localState);

  let map = mapContexts({ contexts: pageContexts, cache, profiles, userDataDir, anonymous });
  if (probe) {
    for (const [ctx, dir] of map) {
      if (dir) continue;
      const found = await probeContext(conn, ctx, { defaultContextId, pages }).catch(() => null);
      if (found) cache[ctx] = found;
    }
    map = mapContexts({ contexts: pageContexts, cache, profiles, userDataDir, anonymous });
  }
  saveCache(conn.port, cache, live);

  const rows = profiles.map(p => {
    const contexts = [...map].filter(([, dir]) => dir === p.dir).map(([ctx]) => ctx);
    return {
      ...p,
      contexts,
      tabs: pages.filter(t => contexts.includes(t.browserContextId)).length,
      default: contexts.includes(defaultContextId),
    };
  });
  return { userDataDir, profiles: rows, map, defaultContextId, anonymous, pages };
}

// Add profile / profileDir to rows from ops.tabs(). Never throws: a browser
// whose profiles cannot be read still lists its tabs.
export async function labelTabs(conn, rows, { probe = true } = {}) {
  let info;
  try {
    info = await inspect(conn, { probe });
  } catch {
    return rows;
  }
  return applyLabels(rows, info);
}

function applyLabels(rows, info) {
  for (const row of rows) {
    const dir = info.map.get(row.browserContextId);
    const profile = dir && info.profiles.find(p => p.dir === dir);
    row.profile = profile ? profile.name : info.anonymous.includes(row.browserContextId) ? null : '?';
    row.profileDir = dir || null;
  }
  return rows;
}

export async function filterByProfile(conn, rows, query) {
  const info = await inspect(conn);
  const profile = resolveProfile(info.profiles, query);
  return applyLabels(rows, info).filter(r => r.profileDir === profile.dir);
}

// ------------------------------------------------------------------- open ---

// The singleton forwards --profile-directory to the running instance, which
// opens a window there. --user-data-dir is passed only when the browser itself
// was started with one, so this never reaches a different browser instance.
export function launchCommand(proc, dir, url, platform = process.platform) {
  const args = [...(proc.userDataDir ? [`--user-data-dir=${proc.userDataDir}`] : []), `--profile-directory=${dir}`, url];
  if (platform === 'darwin') {
    const app = proc.exe.match(/^(.*?\.app)\//)?.[1];
    if (!app) throw new Error(`Cannot find the app bundle for ${proc.exe}`);
    return ['/usr/bin/open', ['-na', app, '--args', ...args]];
  }
  return [proc.exe, args];
}

function launchProfile(proc, dir, url) {
  const [cmd, args] = launchCommand(proc, dir, url);
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

async function navigateOwned(conn, targetId, url) {
  claims.claim(conn.port, targetId, { steal: true });
  await conn.send(targetId, 'Page.navigate', { url }, 10000, { light: true });
  return targetId;
}

export async function openInProfile(conn, url, query, { timeoutMs = 30000 } = {}) {
  const target = url || 'about:blank';
  const info = await inspect(conn);
  const profile = resolveProfile(info.profiles, query);
  const done = (targetId, how) => ({ targetId, id: targetId.slice(0, 8), url: target, profile: profile.name, profileDir: profile.dir, how });
  const ctx = profile.contexts[0];

  if (ctx && ctx === info.defaultContextId) {
    const res = await newTab(conn, target, { browserContextId: ctx }).catch(() => null);
    if (res) return done(res.targetId, 'createTarget');
  }
  let fallback = null;
  if (ctx) {
    const targetId = await scratchTab(conn, ctx, info.pages).catch(e => { fallback = e.message; return null; });
    if (targetId) return done(await navigateOwned(conn, targetId, target), 'existing window');
  }

  const proc = await browserProcess(conn.port);
  if (!proc) {
    throw new Error(`Cannot open a tab in profile "${profile.name}": ${fallback || 'it has no open window'}, and the browser process behind port ${conn.port} is not local, so no window can be opened from here. Open a window in that profile, then retry.`);
  }
  const before = new Set(info.pages.map(t => t.targetId));
  const others = new Set([...info.map].filter(([, dir]) => dir && dir !== profile.dir).map(([c]) => c));
  launchProfile(proc, profile.dir, target);
  const cache = loadCache(conn.port);
  const checked = new Map();
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(250)) {
    const { targetInfos } = await conn.browser('Target.getTargets');
    const pages = targetInfos.filter(isPage);
    const { browserContextIds: anonymous = [], defaultBrowserContextId } = await conn.browser('Target.getBrowserContexts').catch(() => ({}));
    const fresh = pages.filter(t => !before.has(t.targetId) && !others.has(t.browserContextId) && !anonymous.includes(t.browserContextId) &&
      !t.url.startsWith(VERSION_URL) && !t.url.includes('#browserctrl-profile-')); // our own probe tabs
    for (const page of fresh) {
      const c = page.browserContextId;
      if (!checked.has(c)) {
        // A failed probe (the window still starting) is retried next round.
        const found = cache[c] ?? await probeContext(conn, c, { defaultContextId: defaultBrowserContextId, pages }).catch(() => null);
        if (!found) continue;
        cache[c] = found;
        checked.set(c, path.basename(found) === profile.dir);
      }
      if (checked.get(c)) {
        saveCache(conn.port, cache, new Set(targetInfos.map(t => t.browserContextId)));
        claims.claim(conn.port, page.targetId, { steal: true });
        return { ...done(page.targetId, 'opened profile window'), ...(fallback ? { fallback } : {}) };
      }
    }
  }
  throw new Error(`Asked the browser to open profile "${profile.name}", but no tab appeared in it within ${timeoutMs / 1000}s.`);
}

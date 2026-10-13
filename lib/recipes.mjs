// Recipes: a site's own first-party API call, written down once and replayed
// inside a tab on that site. A recipe returns structured data in seconds where
// driving the UI takes minutes, and the page's own cookies, signing and
// anti-fraud wrappers apply because the call runs in the page.
//
// Recipes live in ~/.config/browserctrl/recipes/<site>/<name>.json, and in
// taps: git repos of recipes cloned under ~/.config/browserctrl/taps/<tap>/.
// A local recipe overrides a tapped one with the same name. Recipes hold no
// secrets: auth is a source (cookie, value embedded in the page HTML), resolved
// at call time. See references/recipes.md for the format.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as ops from './ops.mjs';
import * as captcha from './captcha.mjs';

export const recipeDir = () => process.env.BROWSERCTRL_RECIPES || path.join(os.homedir(), '.config/browserctrl/recipes');
export const tapDir = () => process.env.BROWSERCTRL_TAPS || path.join(os.homedir(), '.config/browserctrl/taps');
const tabsFile = () => process.env.BROWSERCTRL_RECIPE_TABS || path.join(os.homedir(), '.local/share/browserctrl/recipe-tabs.json');
const git = promisify(execFile);

// <site>/<name>.json files under one root. A tap may keep them in recipes/.
function scan(root, tap) {
  const base = fs.existsSync(path.join(root, 'recipes')) ? path.join(root, 'recipes') : root;
  const rows = [];
  for (const site of fs.existsSync(base) ? fs.readdirSync(base).sort() : []) {
    const siteDir = path.join(base, site);
    if (site.startsWith('.') || !fs.statSync(siteDir).isDirectory()) continue;
    for (const f of fs.readdirSync(siteDir).filter(f => f.endsWith('.json')).sort()) {
      const name = `${site}/${f.slice(0, -5)}`, file = path.join(siteDir, f);
      try {
        const r = JSON.parse(fs.readFileSync(file, 'utf8'));
        rows.push({ name, kind: r.kind || 'read', description: r.description, tab: r.tab || 'owned', origin: r.origin, match: r.match, keywords: r.keywords, verified: r.verified, source: tap || 'local', file });
      } catch (e) {
        rows.push({ name, error: `unreadable: ${e.message}`, source: tap || 'local', file });
      }
    }
  }
  return rows;
}

export function listTaps(dir = tapDir()) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(t => !t.startsWith('.') && fs.statSync(path.join(dir, t)).isDirectory()).sort() : [];
}

export function listRecipes(dir = recipeDir(), taps = tapDir()) {
  const byName = new Map();
  for (const tap of listTaps(taps)) for (const r of scan(path.join(taps, tap), tap)) if (!byName.has(r.name)) byName.set(r.name, r);
  for (const r of scan(dir)) byName.set(r.name, r);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function loadRecipe(name, dir = recipeDir(), taps = tapDir()) {
  if (name.endsWith('.json')) return JSON.parse(fs.readFileSync(name, 'utf8'));
  const row = listRecipes(dir, taps).find(r => r.name === name);
  if (!row) throw new Error(`No recipe ${name}. Find one with: browserctrl recipe find <url or words>`);
  return { ...JSON.parse(fs.readFileSync(row.file, 'utf8')), name };
}

// A recipe applies to a URL when one of its `match` regexes matches, or by
// default when the URL is on its site (the directory name) or origin host,
// including subdomains: taobao.com covers buyertrade.taobao.com.
export function recipeMatches(row, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (row.match?.length) return row.match.some(m => { try { return new RegExp(m).test(url); } catch { return false; } });
  const hosts = [row.name.split('/')[0]];
  if (row.origin) try { hosts.push(new URL(row.origin).host); } catch {}
  return hosts.some(h => u.host === h || u.host.endsWith(`.${h}`) || h.endsWith(`.${u.host}`));
}

// URL → recipes for that page; words → recipes whose name, description or
// keywords contain every word.
export function findRecipes(query, rows = listRecipes()) {
  const ok = rows.filter(r => !r.error);
  if (/^https?:\/\//.test(query)) return ok.filter(r => recipeMatches(r, query));
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return ok.filter(r => {
    const hay = [r.name, r.description, ...(r.keywords || [])].join(' ').toLowerCase();
    return words.every(w => hay.includes(w));
  });
}

// One line for open/nav/read output, so an agent about to drive a site's UI
// learns there is a faster path. Null when nothing matches.
export function recipeHint(url, rows) {
  let found;
  try { found = findRecipes(url, rows ?? listRecipes()); } catch { return null; }
  if (!found.length) return null;
  const names = found.slice(0, 5).map(r => `${r.name}${r.description ? ` (${r.description.split(/[.(]/)[0].trim()})` : ''}`);
  return `Recipes for this site, faster than the UI: ${names.join('; ')}. Run one with: browserctrl recipe run <name>`;
}

// Taps: git repos of recipes, cloned shallow and updated fast-forward only.
export async function tapAdd(url, name, dir = tapDir()) {
  const tap = name || url.replace(/\.git$/, '').split(/[/:]/).slice(-2).join('-');
  const dest = path.join(dir, tap);
  if (fs.existsSync(dest)) throw new Error(`Tap ${tap} already exists. Update it with: browserctrl recipe tap update ${tap}`);
  fs.mkdirSync(dir, { recursive: true });
  await git('git', ['clone', '--depth', '1', url, dest]);
  return { tap, recipes: scan(dest, tap).length };
}

export async function tapUpdate(name, dir = tapDir()) {
  const taps = name ? [name] : listTaps(dir);
  const out = [];
  for (const tap of taps) {
    if (!fs.existsSync(path.join(dir, tap))) throw new Error(`No tap ${tap}.`);
    await git('git', ['-C', path.join(dir, tap), 'pull', '--ff-only', '--quiet']);
    out.push({ tap, recipes: scan(path.join(dir, tap), tap).length });
  }
  return out;
}

export function tapRemove(name, dir = tapDir()) {
  const dest = path.join(dir, name);
  if (!name || name.includes('/') || !fs.existsSync(dest)) throw new Error(`No tap ${name}.`);
  fs.rmSync(dest, { recursive: true, force: true });
  return { removed: name };
}

// Paths: a.b[0].c, [-1] for the last element, [*] to collect every element.
export function get(obj, p) {
  if (!p) return obj;
  let cur = [obj];
  let many = false;
  for (const part of p.match(/[^.[\]]+|\[-?\d+\]|\[\*\]/g)) {
    const next = [];
    for (const v of cur) {
      if (v == null) continue;
      if (part === '[*]') { many = true; if (Array.isArray(v)) next.push(...v); }
      else if (part.startsWith('[')) next.push(Array.isArray(v) ? v.at(Number(part.slice(1, -1))) : undefined);
      else next.push(v[part]);
    }
    cur = next;
  }
  return many ? [...new Set(cur.filter(v => v != null))] : cur[0];
}

// "{{x}}" on its own keeps x's type; inside a longer string it is interpolated.
// Inside a URL, interpolated values are percent-encoded.
export function fill(t, scope, { encode = false } = {}) {
  if (typeof t === 'string') {
    const whole = t.match(/^\{\{([\w.]+)\}\}$/);
    if (whole) return get(scope, whole[1]) ?? t;
    return t.replace(/\{\{([\w.]+)\}\}/g, (_, k) => {
      const v = get(scope, k) ?? '';
      return encode ? encodeURIComponent(v) : String(v);
    });
  }
  if (Array.isArray(t)) return t.map(x => fill(x, scope, { encode }));
  if (t && typeof t === 'object') return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, fill(v, scope, { encode })]));
  return t;
}

// Command-line values arrive as strings; recipe defaults keep their JSON types.
export function coerce(value, like) {
  if (typeof like === 'number' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (typeof like === 'boolean' && /^(true|false)$/.test(value)) return value === 'true';
  return value;
}

export function shape(recipe, items, { raw = false } = {}) {
  if (raw || !recipe.output) return items;
  return items.map(x => Object.fromEntries(Object.entries(recipe.output).map(([k, p]) => [k, get(x, p)])));
}

function readOwned() {
  try { return JSON.parse(fs.readFileSync(tabsFile(), 'utf8')); } catch { return {}; }
}
function writeOwned(owned) {
  fs.mkdirSync(path.dirname(tabsFile()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tabsFile(), JSON.stringify(owned, null, 1), { mode: 0o600 });
}

// A recipe runs either in a background tab browserctrl opened and reuses, or,
// for `tab: "handoff"` sites, in a tab the human opened. Sites like Taobao drop
// the session for automation-started page loads, so a handoff tab is used as
// found: never opened, navigated or reloaded here.
async function recipeTab(conn, recipe) {
  const origin = new URL(recipe.origin).origin;
  const key = `${conn.port} ${origin}`;
  const owned = readOwned();
  const rows = await ops.tabs(conn, { focus: false });
  if (recipe.tab === 'handoff') {
    const match = new RegExp(recipe.handoff_match || `^${origin.replace(/[.]/g, '\\.')}/`);
    const mine = new Set(Object.values(owned));
    const candidates = rows.filter(t => match.test(t.url || '') && !mine.has(t.targetId) && !t.suspended);
    const tab = candidates.find(t => t.marked) || candidates[0];
    if (!tab) throw new Error(`${recipe.name} needs a tab you opened yourself: open ${origin}${recipe.warm_path || '/'} in the browser (log in if asked), optionally mark it, then call again.`);
    return { targetId: tab.targetId, handoff: true };
  }
  const existing = rows.find(t => t.targetId === owned[key]);
  if (existing) return { targetId: existing.targetId, url: existing.url };
  const { targetId } = await ops.newTab(conn, origin + (recipe.warm_path || '/'));
  writeOwned({ ...owned, [key]: targetId });
  return { targetId, created: true, url: 'about:blank' };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function runRecipe(conn, recipe, params = {}, { raw = false, timeoutMs = 30000 } = {}) {
  const started = Date.now();
  const origin = new URL(recipe.origin).origin;
  const tab = await recipeTab(conn, recipe);
  const evaluate = expr => ops.evaluate(conn, tab.targetId, expr, { timeoutMs });
  if (tab.handoff) {
    // Dia puts idle tabs to sleep; a sleeping tab never answers. Waking it would
    // focus or reload the human's tab, so ask instead of waiting out a timeout.
    const awake = await ops.evaluate(conn, tab.targetId, '1', { timeoutMs: 3000, light: true }).then(() => true, () => false);
    if (!awake) throw new Error(`Your ${new URL(origin).host} tab (${tab.targetId.slice(0, 8)}) is asleep. Click it once in the browser, then call ${recipe.name} again.`);
  }

  if (!tab.handoff) {
    // Our own tab: put it back on the site if it is elsewhere. Dia sometimes
    // creates a tab without loading its URL, leaving it on about:blank.
    if (!(await evaluate('location.href')).startsWith(origin)) {
      await ops.navigate(conn, tab.targetId, origin + (recipe.warm_path || '/'), { waitUntil: 'load' });
      tab.created = true;
    }
    // Anti-fraud SDKs (Shopee) only sign requests once the page has fully loaded.
    await ops.waitForReady(conn, tab.targetId, { waitUntil: 'load', timeoutMs: 30000 }).catch(() => {});
  }
  // A challenge page (slider, verify step) would make every call fail or hang.
  // Clear it first: one automatic attempt for a plain slider, else the human.
  const challenge = await captcha.solve(conn, tab.targetId, { timeoutMs: recipe.captcha_wait_ms ?? 120000 });
  if (challenge.captcha) tab.created = true; // let the site's SDKs settle again
  const at = await evaluate('location.href');
  if (new URL(at).origin !== origin) throw new Error(`The ${recipe.name} tab is on ${at}, not ${origin}. The site probably wants you to log in there.`);
  if (tab.created) await sleep(recipe.settle_ms ?? 1500);

  const builtins = { now_iso: new Date().toISOString() };
  const vars = { ...builtins, ...fill(recipe.params || {}, builtins) };
  for (const [k, v] of Object.entries(params)) vars[k] = coerce(v, recipe.params?.[k]);

  const auth = {};
  for (const [name, src] of Object.entries(recipe.auth || {})) {
    if (src.from === 'html') {
      const html = await evaluate(`fetch(${JSON.stringify(src.path || '/')}, {credentials: 'include'}).then(r => r.text())`);
      auth[name] = html.match(new RegExp(src.regex))?.[1];
    } else if (src.from === 'cookie') {
      auth[name] = await evaluate(`(document.cookie.match(new RegExp('(?:^|; )' + ${JSON.stringify(src.name)} + '=([^;]*)')) || [])[1]`);
    } else throw new Error(`Unknown auth source ${src.from} in ${recipe.name}`);
    if (!auth[name]) throw new Error(`${recipe.name}: auth value ${name} was not found. The session may have expired; log in on ${origin}.`);
  }

  const pg = recipe.paginate || {};
  const items = [];
  const seen = new Set();
  let calls = 0;
  if (recipe.js) {
    // A page hook for sites whose own client has to sign the call (Taobao mtop)
    // or whose responses are not plain lists: (cursor, params) => ({items, next}).
    for (let cursor = pg.start ?? null; ;) {
      const res = await evaluate(`(${recipe.js})(${JSON.stringify(cursor)}, ${JSON.stringify(vars)})`);
      calls++;
      if (res?.error) throw new Error(`${recipe.name} call ${calls}: ${res.error}`);
      items.push(...(res?.items || []));
      if (res?.next == null || calls >= (pg.max_pages || 100)) break;
      cursor = res.next;
      await sleep(recipe.pace_ms || 0);
    }
  } else {
    for (;;) {
      const scope = { ...vars, auth };
      const req = recipe.request;
      const init = { method: req.method || 'GET', credentials: 'include', headers: fill(req.headers || {}, scope) };
      if (req.body !== undefined) init.body = typeof req.body === 'string' ? fill(req.body, scope) : JSON.stringify(fill(req.body, scope));
      const url = fill(req.url, scope, { encode: true });
      const res = await evaluate(`fetch(${JSON.stringify(url)}, ${JSON.stringify(init)}).then(async r => ({status: r.status, text: await r.text()}))`);
      calls++;
      if (res.status >= 400) throw new Error(`${recipe.name}: HTTP ${res.status} on call ${calls}: ${res.text.slice(0, 200)}`);
      const json = JSON.parse(res.text);
      const batch = (pg.items ? get(json, pg.items) : json) || [];
      const list = Array.isArray(batch) ? batch : [batch];
      const fresh = pg.dedupe ? list.filter(x => { const id = get(x, pg.dedupe); return !seen.has(id) && seen.add(id); }) : list;
      items.push(...fresh);
      if (!pg.type || !fresh.length || calls >= (pg.max_pages || 100)) break;
      if (pg.type === 'offset') {
        const step = Number(fill(String(pg.step), scope));
        if (list.length < Number(fill(String(pg.stop_when_fewer_than ?? step), scope))) break;
        vars[pg.param] = Number(vars[pg.param] || 0) + step;
      } else if (pg.type === 'cursor') {
        const next = get(json, pg.next);
        if (!next || next === vars[pg.param]) break;
        vars[pg.param] = next;
      } else throw new Error(`Unknown pagination ${pg.type} in ${recipe.name}`);
      await sleep(recipe.pace_ms || 0);
    }
  }
  return { recipe: recipe.name, items: shape(recipe, items, { raw }), count: items.length, calls, ms: Date.now() - started, tab: tab.targetId.slice(0, 8), ...(challenge.captcha ? { challenge } : {}) };
}

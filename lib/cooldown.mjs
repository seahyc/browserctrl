// Per-site cool-down after a challenge. A site that just showed a captcha or
// verification step is watching this browser; loading it again soon, or
// retrying into the challenge, makes the next check harder. So after a
// challenge on a site, commands that would load or navigate it refuse until the
// window ends, unless forced. Reading a tab that is already open stays allowed.
//
// The window starts at 20 minutes and doubles for each further challenge on the
// same site within a day, up to 2 hours. A challenge seen gone (cleared by the
// solver or the human) ends the window early but keeps the count for doubling.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DAY = 24 * 60 * 60 * 1000;
export const BASE_MS = 20 * 60 * 1000;
export const CAP_MS = 2 * 60 * 60 * 1000;

export const file = () => process.env.BROWSERCTRL_COOLDOWN || path.join(os.homedir(), '.local/share/browserctrl/cooldown.json');
const baseMs = () => Number(process.env.BROWSERCTRL_COOLDOWN_MS) || BASE_MS;

// The site a challenge belongs to: the registrable part of the host, so a
// challenge on www.shopee.sg also cools shopee.sg and mall.shopee.sg.
// IP addresses and single-label hosts are kept as they are.
export function siteOf(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { host = String(url || '').toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/:?#]/)[0]; }
  if (!host || /^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return host || null;
  const parts = host.split('.');
  const second = /^(com|co|net|org|gov|edu|ac|or|ne)$/.test(parts.at(-2)) && parts.at(-1).length === 2;
  return parts.slice(second ? -3 : -2).join('.');
}

function read() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return {}; }
}
function write(all) {
  fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

// Record a challenge on the url's site. Returns the entry.
export function record(url, { kind = 'challenge', now = Date.now() } = {}) {
  const site = siteOf(url);
  if (!site) return null;
  const all = read();
  const prev = all[site];
  // Still inside a window from the same challenge: keep it, do not double again.
  if (prev && prev.until > now) {
    all[site] = { ...prev, kind, lastSeen: now };
    write(all);
    return all[site];
  }
  const repeat = prev && now - prev.at < DAY;
  const windowMs = repeat ? Math.min(prev.windowMs * 2, CAP_MS) : baseMs();
  all[site] = { site, kind, at: now, lastSeen: now, until: now + windowMs, windowMs, strikes: repeat ? prev.strikes + 1 : 1 };
  write(all);
  return all[site];
}

// The challenge is gone: end the window now, keep the history for doubling.
export function clear(url, { now = Date.now() } = {}) {
  const site = siteOf(url);
  const all = read();
  const e = site && all[site];
  if (!e || e.until <= now) return null;
  all[site] = { ...e, until: now, cleared: now };
  write(all);
  return all[site];
}

export function active(url, { now = Date.now() } = {}) {
  const site = siteOf(url);
  const e = site && read()[site];
  return e && e.until > now ? e : null;
}

export function list({ now = Date.now() } = {}) {
  return Object.values(read()).filter(e => e.until > now).sort((a, b) => a.until - b.until);
}

const clock = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const mins = ms => `${Math.max(1, Math.round(ms / 60000))} min`;
const nth = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`;

export function describe(e, { now = Date.now() } = {}) {
  return `${e.site} until ${clock(e.until)} (${mins(e.until - now)} left; ${e.kind}, ${nth(e.strikes)} challenge today)`;
}

export class CooldownError extends Error {}

// Refuse to load or navigate a site that is cooling down, unless forced.
export function guard(url, { force = false, action = 'load', now = Date.now() } = {}) {
  const e = active(url, { now });
  if (!e || force) return e;
  throw Object.assign(new CooldownError(
    `${e.site} is cooling down after a ${e.kind} at ${clock(e.at)}: refusing to ${action} it until ${clock(e.until)} (${mins(e.until - now)} from now). ` +
    `Loading the site again or retrying into its challenge escalates the check. Read tabs that are already open, ` +
    `or hand a tab that still shows the challenge to the human with: browserctrl captcha <tab> (clearing it ends the cool-down). ` +
    `Override with --force only if the user wants it now.`), { cooldown: e });
}

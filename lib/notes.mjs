// Flow notes: short facts about how a site works, shown as a hint when open, nav, read or a
// `do` step touch that site. Recipes are exact API calls written on purpose; notes are advice.
// Agents write them: after a task, the agent adds what would have saved it time (`notes add`),
// confirms notes that held and drops ones that were wrong. Before a note is stored, Jev is
// asked whether it is a reusable fact about the site rather than this task's answer or values.
// Two general rules add notes without an agent: a control that put a filter in the address
// (from `do` traces) and a challenge drawn by loading several pages at once (from `visit`).
// No site knowledge lives here.
//
// This file only keeps the books: each fact has an id, a count of runs that confirmed it,
// the last time it did, and a count of runs that contradicted it. A contradiction after the
// last success outweighs one confirmation, so a fact that worked once and then failed is
// dropped; facts unseen for 90 days are pruned. Stored per site, one JSON file each.
//
// BROWSERCTRL_NOTES=off stops both recording and hints; =quiet records without hinting
// (the notes-off arm of a benchmark). BROWSERCTRL_NOTES_DIR moves the store.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { siteOf } from './cooldown.mjs';
import { parseStep } from './steps.mjs';
import * as jev from './jev.mjs';

const DAY = 24 * 60 * 60 * 1000;
const KEEP = 60;          // facts stored per site
const SHOW = 5;           // facts in a hint
const STALE_MS = 90 * DAY;
const MAX_TEXT = 200;
const RULES = 2;          // version of the rules below; facts from older rules are purged
const KEPT_KINDS = new Set(['agent', 'api', 'url', 'challenge']);

export const dir = () => process.env.BROWSERCTRL_NOTES_DIR || path.join(os.homedir(), '.local/share/browserctrl/notes');
const mode = () => String(process.env.BROWSERCTRL_NOTES || 'on').toLowerCase();
export const recording = () => !['off', '0', 'false'].includes(mode());
export const hinting = () => recording() && mode() !== 'quiet';

export const siteOfUrl = (url) => siteOf(url);
const fileFor = (site) => path.join(dir(), `${site.replace(/[^\w.-]/g, '_')}.json`);
const clip = (s, n = 60) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

// Ids in a path vary per page: /issues/123 and /p/abc123def456 are the same kind of page.
export function pathTemplate(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  return u.pathname.replace(/\/+$/, '').split('/').map(seg =>
    /^\d+$/.test(seg) || /^[0-9a-f-]{12,}$/i.test(seg) || (/\d/.test(seg) && seg.length > 16) ? '*' : seg).join('/') || '/';
}

const NOISE = /^(utm_|fbclid|gclid|_|spm$|ref$|ref_|scm$|trackingid|sessionid|sid$)/i;
function addedParams(before, after) {
  let a, b;
  try { a = new URL(before); b = new URL(after); } catch { return []; }
  const out = [];
  // A repeated parameter (?c=a&c=b) counts as added only for the values that are new.
  for (const [k, v] of b.searchParams) if (!a.searchParams.getAll(k).includes(v) && !NOISE.test(k)) out.push([k, v]);
  return out;
}
const samePath = (a, b) => { try { const x = new URL(a), y = new URL(b); return x.origin === y.origin && pathTemplate(a) === pathTemplate(b); } catch { return false; } };

// A value is the site's when it is a short enum (state=closed, o=-created) or the control's
// own label; anything else (a classifier string, a price, an id) is the task's: "…".
const ENUM = /^-?[a-z][a-z_-]{0,23}$/i;
function paramValue(v, control) {
  if (ENUM.test(v) || (norm(v) && norm(v) === norm(control))) return v;
  return '…';
}

// A value the plan typed is the task's, not the site's: "<text>" in a note.
function template(s, typed) {
  let t = String(s ?? '');
  for (const v of typed) if (v && v.length > 1) t = t.split(v).join('<text>');
  return t;
}

// Facts and contradictions from one `do` run's trace records (steps then a run line).
// Returns [{ site, key, kind, text, path?, ok }]; ok=false contradicts an existing fact.
// The only rule here: a click or select that changed this page's address parameters.
export function derive(records) {
  const steps = records.filter(r => r.kind !== 'run' && typeof r.step === 'number');
  const run = records.find(r => r.kind === 'run');
  const out = [];
  const typed = [];
  const parsed = steps.map(r => { try { return parseStep(r.do); } catch { return null; } });
  for (const p of parsed) if (p && (p.action === 'fill' || p.action === 'type')) typed.push(p.action === 'fill' ? p.value : p.target);
  steps.forEach((r, i) => {
    const s = parsed[i];
    if (!s || r.skipped || !['click', 'select'].includes(s.action) || !r.url_after) return;
    const failed = Boolean(r.stop);
    const at = r.url_before || run?.url;
    const site = siteOf(at);
    if (!site) return;
    const tpl = pathTemplate(at);
    const ctl = s.action === 'select' ? `${s.target} = ${s.value}` : s.target;
    const label = s.action === 'select' ? s.value : s.target;
    const key = `url ${tpl} ${norm(template(ctl, typed))}`;
    const params = addedParams(r.url_before, r.url_after);
    if (params.length && samePath(r.url_before, r.url_after) && !failed) {
      const set = params.slice(0, 4).map(([k, v]) => `${k}=${clip(template(paramValue(v, label), typed), 30)}`).join('&');
      out.push({ site, key, kind: 'url', path: tpl, ok: true,
        text: `on ${tpl}, ${s.action} "${clip(template(ctl, typed), 40)}" sets ?${set} in the URL; nav to it directly` });
    } else if (failed) out.push({ site, key, kind: 'url', ok: false });
  });
  return out;
}

export const idOf = (site, key) => crypto.createHash('sha1').update(`${site}\n${key}`).digest('hex').slice(0, 5);

// Facts from rules that no longer exist (flows, Enter, overlays) or from an older version of a
// rule are dropped on load; agent notes always stay.
const current = (f) => f.author === 'agent' || (KEPT_KINDS.has(f.kind) && (f.v || 0) >= RULES);
function load(site) {
  let note;
  try { note = JSON.parse(fs.readFileSync(fileFor(site), 'utf8')); } catch { return { site, facts: [] }; }
  const kept = note.facts.filter(current);
  if (kept.length !== note.facts.length) {
    note.purged = (note.purged || 0) + note.facts.length - kept.length;
    note.facts = kept;
    try { if (kept.length) save(note); else fs.rmSync(fileFor(site), { force: true }); } catch {}
  }
  for (const f of note.facts) f.id ||= idOf(site, f.key);
  return note;
}
function save(note) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const tmp = `${fileFor(note.site)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(note, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, fileFor(note.site));
}

const score = (f) => f.count - 2 * (f.fails || 0);

// Merge observations into the store. A contradiction only counts against a fact that
// exists; it never creates one.
export function record(observations, { now = Date.now() } = {}) {
  if (!recording()) return [];
  const bySite = new Map();
  for (const o of observations) (bySite.get(o.site) || bySite.set(o.site, []).get(o.site)).push(o);
  const touched = [];
  for (const [site, obs] of bySite) {
    try {
      const note = load(site);
      const iso = new Date(now).toISOString();
      for (const o of obs) {
        const f = note.facts.find(x => x.key === o.key);
        if (o.ok && f && o.verified !== false) delete f.verified;
        if (o.ok) {
          if (f) Object.assign(f, { text: o.text, count: f.count + 1, last: iso, ...(o.path ? { path: o.path } : {}), ...(o.recipe ? { recipe: o.recipe } : {}) });
          else note.facts.push({ id: idOf(site, o.key), key: o.key, kind: o.kind, author: o.author || 'rule', v: RULES, text: o.text,
            ...(o.path ? { path: o.path } : {}), ...(o.recipe ? { recipe: o.recipe } : {}), ...(o.verified === false ? { verified: false } : {}), count: 1, fails: 0, first: iso, last: iso });
        } else if (f) Object.assign(f, { fails: (f.fails || 0) + 1, failed: iso });
      }
      note.facts = note.facts
        .filter(f => score(f) > 0 && now - Date.parse(f.last) < STALE_MS)
        .sort((a, b) => score(b) - score(a) || b.last.localeCompare(a.last))
        .slice(0, KEEP);
      if (note.facts.length) save(note); else fs.rmSync(fileFor(site), { force: true });
      touched.push(site);
    } catch {}
  }
  return touched;
}

// Called with each `do` run's trace records.
export function learn(records) {
  if (!recording()) return [];
  try { return record(derive(records)); } catch { return []; }
}

// The best facts for a page: those about its own path first, then site-wide ones, then
// those about the site's other pages.
export function forUrl(url, { max = SHOW, site: siteIn } = {}) {
  const site = siteIn || siteOf(url);
  if (!site) return [];
  const tpl = url ? pathTemplate(url) : null;
  const facts = load(site).facts;
  const here = (f) => (!f.path ? 1 : f.path === tpl ? 2 : 0);
  return [...facts].sort((a, b) => here(b) - here(a) || score(b) - score(a) || b.last.localeCompare(a.last)).slice(0, max);
}

// One line per fact: id, text, its links, and how well it has held.
export function line(f) {
  const tags = [f.kind === 'api' ? 'api, recipe candidate' : null, f.verified === false ? 'unchecked' : null].filter(Boolean);
  return `${f.id} ${f.kind === 'api' ? '[api] ' : ''}${f.text}${f.recipe ? ` → recipe run ${f.recipe}` : ''} (worked ${f.count}×, last ${f.last.slice(0, 10)}${tags.length ? `, ${tags.join(', ')}` : ''})`;
}

// How many facts a site has, for "3 of 9" in a hint header.
export const total = (siteOrUrl) => show(siteOrUrl).facts.length;

// The notes part of a hint: one line per fact, or nothing.
export function hintLines(url) {
  if (!hinting() || !url) return [];
  return forUrl(url).map(f => `  ${line(f)}`);
}

export function sites() {
  let names = [];
  try { names = fs.readdirSync(dir()).filter(n => n.endsWith('.json')); } catch {}
  return names.map(n => load(n.slice(0, -5))).filter(n => n.facts?.length).map(n => ({ site: n.site, facts: n.facts.length, last: n.facts.map(f => f.last).sort().at(-1) }));
}

// A site's facts; given a page URL, that page's notes first, then site-wide, then others.
export function show(siteOrUrl) {
  const site = siteFrom(siteOrUrl);
  const note = load(site);
  if (/^https?:\/\//.test(siteOrUrl)) note.facts = forUrl(siteOrUrl, { max: Infinity, site });
  return note;
}

export function clear(siteOrUrl) {
  if (!siteOrUrl) { fs.rmSync(dir(), { recursive: true, force: true }); return 'all'; }
  const { site } = show(siteOrUrl);
  fs.rmSync(fileFor(site), { force: true });
  return site;
}

export function format(note) {
  if (!note.facts.length) return `No flow notes for ${note.site}.`;
  return [`${note.site}  ${note.facts.length} notes`, ...note.facts.map(f =>
    `  ${f.id} [${f.kind}] ${f.text}${f.recipe ? ` → recipe run ${f.recipe}` : ''}${f.kind === 'api' ? ' (recipe candidate)' : ''}\n      ${f.author || 'rule'}${f.path ? `, on ${f.path}` : ''}, worked ${f.count}×${f.fails ? `, failed ${f.fails}×` : ''}${f.verified === false ? ', not checked by Jev' : ''}, first ${f.first.slice(0, 10)}, last ${f.last.slice(0, 10)}`)].join('\n');
}

// Is this a reusable fact about how the site works? One Jev yes/no question. Returns
// { ok, p } or { ok: true, unchecked: reason } when Jev cannot be asked.
export const LEAK_QUESTION = 'Is this note a reusable fact about how the website works (its controls, layout, URL parameters, filters, flows or quirks) that would help with a different task on the same site? Answer no if it states a specific task\'s answer or result, values chosen for one task (such as a product, price, date, name or search term), or personal data.';
export async function judge(site, text, { path: p, cfg, fetchImpl } = {}) {
  let key;
  try { key = cfg || jev.jevKey(); } catch (e) { return { ok: true, unchecked: e.message }; }
  try {
    const r = await jev.systemOne(key, { site, page: p || null, note: text },
      { reusable: { type: 'noul', instructions: LEAK_QUESTION } }, fetchImpl ? { fetchImpl } : undefined);
    const prob = Math.round((r.answers.reusable?.noul ?? NaN) * 100) / 100;
    if (Number.isNaN(prob)) return { ok: true, unchecked: 'Jev gave no answer' };
    return { ok: prob >= 0.5, p: prob };
  } catch (e) { return { ok: true, unchecked: e.message }; }
}

export function siteFrom(siteOrUrl) {
  siteOrUrl = String(siteOrUrl || '');
  return siteOf(/[/:]/.test(siteOrUrl) ? (/^https?:/.test(siteOrUrl) ? siteOrUrl : `https://${siteOrUrl}`) : `https://${siteOrUrl}/`) || siteOrUrl;
}

// An agent's note. Rejected when too long, multi-line, or judged task-specific (unless force).
// api: the note says where a page's data comes from ("orders come from GET /api/v4/…"), a
// candidate for a recipe. recipe: the name of a recipe the note points to.
export async function add(siteOrUrl, text, { path: p, force = false, api = false, recipe, now = Date.now(), ...judgeOpts } = {}) {
  const site = siteFrom(String(siteOrUrl || ''));
  text = String(text ?? '').trim();
  if (!site) return { ok: false, reason: 'give a site (example.com) or a URL' };
  if (!text) return { ok: false, reason: 'the note is empty' };
  if (/\n/.test(text)) return { ok: false, reason: 'a note is one line' };
  if (text.length > MAX_TEXT) return { ok: false, reason: `a note is at most ${MAX_TEXT} characters (this one is ${text.length}); keep the one fact that saves time` };
  if (!recording()) return { ok: false, reason: 'notes are off (BROWSERCTRL_NOTES=off)' };
  if (!p && /[/:]/.test(String(siteOrUrl))) p = pathTemplate(/^https?:/.test(siteOrUrl) ? siteOrUrl : `https://${siteOrUrl}`);
  if (p === '/') p = undefined;
  const verdict = force ? { ok: true, forced: true } : await judge(site, text, { path: p, ...judgeOpts });
  if (!verdict.ok) return { ok: false, site, p: verdict.p,
    reason: `Jev judged this task-specific (p=${verdict.p} that it is a reusable site fact). A note says how the site works, never an answer, chosen values or personal data. Rephrase it, or pass --force.` };
  const kind = api ? 'api' : 'agent';
  const key = `${kind} ${p || ''} ${norm(text)}`;
  record([{ site, key, kind, author: 'agent', text, ...(p ? { path: p } : {}), ...(recipe ? { recipe } : {}), ok: true, ...(verdict.unchecked ? { verified: false } : {}) }], { now });
  return { ok: true, site, id: idOf(site, key), ...(verdict.p != null ? { p: verdict.p } : {}), ...(verdict.unchecked ? { unchecked: verdict.unchecked } : {}) };
}

function findId(id) {
  id = String(id || '').replace(/^#/, '').toLowerCase();
  for (const { site } of sites()) {
    const note = load(site);
    const f = note.facts.find(x => x.id === id);
    if (f) return { note, f };
  }
  return null;
}

// An agent relied on a note and it held.
export function confirm(id, { now = Date.now() } = {}) {
  const hit = findId(id);
  if (!hit) return { ok: false, reason: `no note ${id}` };
  record([{ site: hit.note.site, key: hit.f.key, kind: hit.f.kind, text: hit.f.text, ok: true }], { now });
  return { ok: true, site: hit.note.site, id: hit.f.id, count: hit.f.count + 1 };
}

// A note turned out wrong: remove it, keeping the reason in the site's file.
export function drop(id, { why = '', now = Date.now() } = {}) {
  const hit = findId(id);
  if (!hit) return { ok: false, reason: `no note ${id}` };
  const { note, f } = hit;
  note.facts = note.facts.filter(x => x !== f);
  note.dropped = [...(note.dropped || []), { id: f.id, text: f.text, why: String(why).slice(0, MAX_TEXT), at: new Date(now).toISOString() }].slice(-20);
  if (note.facts.length) save(note); else fs.rmSync(fileFor(note.site), { force: true });
  return { ok: true, site: note.site, id: f.id, text: f.text };
}

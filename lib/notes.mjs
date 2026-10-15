// Flow notes: short facts about how a site works, learned from the user's own `do` traces
// and `visit` runs, and shown as a hint when open, nav or read touch that site. Recipes are
// exact API calls written on purpose; notes are advice written automatically. The rules
// here are general (what a step changed in the address, which key submitted a field, which
// control closed an overlay, which sequence of steps worked); no site knowledge lives here.
//
// Each fact keeps a count of runs that confirmed it, the last time it did, and a count of
// runs that contradicted it. A contradiction after the last success outweighs one
// confirmation, so a fact that worked once and then failed is dropped; facts unseen for
// 90 days are pruned. Stored per site next to the traces, one JSON file each.
//
// BROWSERCTRL_NOTES=off stops both recording and hints; =quiet records without hinting
// (the notes-off arm of a benchmark). BROWSERCTRL_NOTES_DIR moves the store.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { siteOf } from './cooldown.mjs';
import { parseStep } from './steps.mjs';

const DAY = 24 * 60 * 60 * 1000;
const KEEP = 60;          // facts stored per site
const SHOW = 5;           // facts in a hint
const STALE_MS = 90 * DAY;

export const dir = () => process.env.BROWSERCTRL_NOTES_DIR || path.join(os.homedir(), '.local/share/browserctrl/notes');
const mode = () => String(process.env.BROWSERCTRL_NOTES || 'on').toLowerCase();
export const recording = () => !['off', '0', 'false'].includes(mode());
export const hinting = () => recording() && mode() !== 'quiet';

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
  for (const [k, v] of b.searchParams) if (a.searchParams.get(k) !== v && !NOISE.test(k)) out.push([k, v]);
  return out;
}
const samePath = (a, b) => { try { const x = new URL(a), y = new URL(b); return x.origin === y.origin && pathTemplate(a) === pathTemplate(b); } catch { return false; } };

// A value the plan typed is the task's, not the site's: "<text>" in a note.
function template(s, typed) {
  let t = String(s ?? '');
  for (const v of typed) if (v && v.length > 1) t = t.split(v).join('<text>');
  return t;
}

// Facts and contradictions from one `do` run's trace records (steps then a run line).
// Returns [{ site, key, kind, text, path?, ok }]; ok=false contradicts an existing fact.
export function derive(records) {
  const steps = records.filter(r => r.kind !== 'run' && typeof r.step === 'number');
  const run = records.find(r => r.kind === 'run');
  const out = [];
  const typed = [];
  const parsed = steps.map(r => { try { return parseStep(r.do); } catch { return null; } });
  for (const p of parsed) if (p && (p.action === 'fill' || p.action === 'type')) typed.push(p.action === 'fill' ? p.value : p.target);
  steps.forEach((r, i) => {
    const s = parsed[i];
    if (!s || r.skipped) return;
    const failed = Boolean(r.stop);
    const at = r.url_before || run?.url;
    const site = siteOf(at);
    if (!site) return;
    const tpl = pathTemplate(at);
    // A control that changed the address: the same filter can be set with one nav step.
    if (['click', 'select'].includes(s.action) && r.url_after) {
      const params = addedParams(r.url_before, r.url_after);
      const ctl = s.action === 'select' ? `${s.target} = ${s.value}` : s.target;
      const key = `url ${tpl} ${norm(template(ctl, typed))}`;
      if (params.length && samePath(r.url_before, r.url_after) && !failed) {
        const set = params.slice(0, 4).map(([k, v]) => `${k}=${clip(template(v, typed), 30)}`).join('&');
        out.push({ site, key, kind: 'url', path: tpl, ok: true,
          text: `on ${tpl}, ${s.action} "${clip(template(ctl, typed), 40)}" sets ?${set} in the URL; nav to it directly` });
      } else if (failed) out.push({ site, key, kind: 'url', ok: false });
    }
    // A key that submitted the field before it: Enter after fill, with the URL it led to.
    if (s.action === 'key' && /^enter$/i.test(s.target) && i > 0 && ['fill', 'type'].includes(parsed[i - 1]?.action)) {
      const prev = parsed[i - 1];
      const field = prev.action === 'fill' ? prev.target : 'the focused field';
      const key = `enter ${tpl} ${norm(field)}`;
      const moved = r.url_after && r.url_after !== r.url_before;
      if (moved && !failed) {
        const params = addedParams(r.url_before, r.url_after).filter(([, v]) => typed.some(t => norm(v).includes(norm(t))));
        let dest = '';
        try { dest = new URL(r.url_after).pathname; } catch {}
        const q = params.length ? `${dest}?${params[0][0]}=<text>` : dest;
        out.push({ site, key, kind: 'enter', path: tpl, ok: true,
          text: `on ${tpl}, "${clip(field, 40)}" submits on Enter → ${clip(q, 60)}${params.length ? '; nav there directly' : ''}` });
      } else if (failed) out.push({ site, key, kind: 'enter', ok: false });
    }
    // An overlay that appeared and the control that closed it.
    for (const d of r.dismissed || []) {
      out.push({ site, key: `overlay ${norm(d.category)} ${norm(d.control)}`, kind: 'overlay', ok: true,
        text: `a ${d.category} appears ("${clip(d.text, 40)}"); ${d.control} closes it` });
    }
  });
  // The whole interaction sequence, when the run finished: the next task on the site can
  // reuse its shape. Navigation and waits are not part of the flow.
  const flow = steps.map((r, i) => ({ r, s: parsed[i] })).filter(({ r, s }) => s && !r.skipped && ['click', 'fill', 'select', 'key', 'type', 'hover'].includes(s.action));
  const site = siteOf(steps[0]?.url_before || run?.url);
  if (site && flow.length >= 2 && flow.length <= 8) {
    const label = ({ s, r }) => {
      // The element it landed on, when its name differs from the plan's ("Closed" → tab "Closed 12").
      const el = r.target?.name && norm(r.target.name) !== norm(s.target) ? ` (${r.target.role} "${clip(template(r.target.name, typed), 30)}")` : '';
      if (s.action === 'fill') return `fill "${clip(template(s.target, typed), 30)}"`;
      if (s.action === 'type') return 'type <text>';
      if (s.action === 'key') return `key ${s.target}`;
      if (s.action === 'select') return `select "${clip(s.target, 30)}"`;
      return `${s.action} "${clip(template(s.target, typed), 40)}"${el}`;
    };
    const tpl = pathTemplate(steps[0]?.url_before || run?.url);
    const key = `flow ${tpl} ${flow.map(({ s }) => `${s.action}:${norm(['fill', 'type'].includes(s.action) ? '' : template(s.target, typed))}`).join('>')}`;
    if (run?.done) out.push({ site, key, kind: 'flow', path: tpl, ok: true, text: `on ${tpl}, worked: ${flow.map(label).join(' → ')}` });
    else if (run && flow.some(({ r }) => r.stop)) out.push({ site, key, kind: 'flow', ok: false });
  }
  return out;
}

function load(site) {
  try { return JSON.parse(fs.readFileSync(fileFor(site), 'utf8')); } catch { return { site, facts: [] }; }
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
        if (o.ok) {
          if (f) Object.assign(f, { text: o.text, count: f.count + 1, last: iso, ...(o.path ? { path: o.path } : {}) });
          else note.facts.push({ key: o.key, kind: o.kind, text: o.text, ...(o.path ? { path: o.path } : {}), count: 1, fails: 0, first: iso, last: iso });
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

// The best facts for a page: those about its own path first, then the site's.
export function forUrl(url, { max = SHOW } = {}) {
  const site = siteOf(url);
  if (!site) return [];
  const tpl = pathTemplate(url);
  const facts = load(site).facts;
  const here = (f) => (f.path && f.path === tpl ? 1 : 0);
  return [...facts].sort((a, b) => here(b) - here(a) || score(b) - score(a) || b.last.localeCompare(a.last)).slice(0, max);
}

// One hint line per fact, or nothing.
export function hintLines(url) {
  if (!hinting() || !url) return [];
  const facts = forUrl(url);
  if (!facts.length) return [];
  const site = siteOf(url);
  return [`Flow notes for ${site}, from your past runs (advice, may be out of date):`,
    ...facts.map(f => `  ${f.text} (worked ${f.count}×, last ${f.last.slice(0, 10)})`)];
}

export function sites() {
  let names = [];
  try { names = fs.readdirSync(dir()).filter(n => n.endsWith('.json')); } catch {}
  return names.map(n => load(n.slice(0, -5))).filter(n => n.facts?.length).map(n => ({ site: n.site, facts: n.facts.length, last: n.facts.map(f => f.last).sort().at(-1) }));
}

export function show(siteOrUrl) {
  const site = siteOf(siteOrUrl.includes('/') || siteOrUrl.includes(':') ? siteOrUrl : `https://${siteOrUrl}/`) || siteOrUrl;
  return load(site);
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
    `  [${f.kind}] ${f.text}\n      worked ${f.count}×${f.fails ? `, failed ${f.fails}×` : ''}, first ${f.first.slice(0, 10)}, last ${f.last.slice(0, 10)}`)].join('\n');
}

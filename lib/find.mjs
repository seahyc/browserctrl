// find and fields: the two questions agents answered with hand-written eval in the Online-
// Mind2Web runs (25 of 95). "Where is the control that says X, even if a collapsed section
// hides it, and where does it link?" and "what does every field on this form hold now?"
// Both walk open shadow roots, and name each hit by a ref from the last read when it has
// one, else by a pinned selector that click, fill and do steps accept.

// The page code is in lib/page (find.js, fields.js, page-state-for-diff.js, and findKit in
// shared.mjs, which all three use).
import { page } from './page/index.mjs';

export const FIND = (pattern, { limit = 25, pin = false } = {}) => page('find', { pattern, limit, pin });

export const FIELDS = ({ all = false } = {}) => page('fields', { all });

// What a person would notice changed after a plan: controls by role and name with their
// state, headings, alerts and status lines, and result counts. Taken before and after a do
// plan; diffPage compares the two.
export const PAGE_STATE_FOR_DIFF = page('page-state-for-diff');

const q = (s) => `"${String(s ?? '').replace(/"/g, '\\"')}"`;

export function formatFind(r, pattern) {
  if (!r?.rows?.length) return `Nothing on the page matches /${pattern}/ (open shadow roots and hidden sections included). Try fewer words, or read --all.`;
  const lines = r.rows.map(x => {
    const bits = [`${x.handle.padEnd(9)} ${x.role.padEnd(9)} ${q(x.name)}`];
    if (x.value !== undefined) bits.push(`value ${q(x.value)}`);
    if (x.disabled) bits.push('disabled');
    if (x.hidden) bits.push(x.opens_with ? `${x.hidden}: opens with ${x.opens_with.role} ${q(x.opens_with.name)} ${x.opens_with.handle}` : x.hidden);
    if (x.href) bits.push(`→ ${x.href}`);
    if (x.runs) bits.push(`runs ${x.runs}`);
    return bits.join('  ');
  });
  if (r.more) lines.push(`(${r.more} more; narrow the pattern)`);
  lines.push('', 'Use a handle in a step: do <tab> \'click ref_12\' or \'click [data-bc-pin="…"]\'. A hidden one: click its opener first, or nav to its link.');
  return lines.join('\n');
}

export function formatFields(r) {
  if (!r?.rows?.length) return r?.unticked ? `No filled fields; ${r.unticked} unticked boxes (--all lists them).` : 'No form fields on this page.';
  const lines = r.rows.map(x => {
    const bits = [`${String(x.handle || '').padEnd(9)} ${x.role.padEnd(11)} ${q(x.label)}`];
    if (x.role === 'radio group') bits.push(x.value ? `= ${q(x.value)} (of ${x.options})` : `nothing chosen (${x.options} options)`);
    else bits.push(`= ${q(x.value)}`);
    if (x.options && x.role !== 'radio group') bits.push(`(${x.options} options)`);
    if (x.range) bits.push(`range ${x.range}`);
    for (const k of ['required', 'invalid', 'disabled']) if (x[k]) bits.push(k);
    if (x.hidden) bits.push(`(${x.hidden})`);
    return bits.join('  ');
  });
  if (r.unticked) lines.push(`(${r.unticked} unticked boxes not listed; --all lists them)`);
  if (r.more) lines.push(`(${r.more} more fields not listed)`);
  return lines.join('\n');
}

const uncount = (s) => String(s || '').replace(/\s*\(\s*\d[\d,.]*\s*\)\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
const stateWords = (st) => {
  const w = [];
  if ('checked' in st) w.push(st.checked ? 'checked' : 'unchecked');
  if ('pressed' in st) w.push(st.pressed ? 'pressed' : 'not pressed');
  if ('open' in st) w.push(st.open ? 'open' : 'closed');
  if ('selected' in st) w.push(st.selected ? 'selected' : 'not selected');
  if ('value' in st) w.push(`"${st.value}"`);
  if (st.disabled) w.push('disabled');
  return w.join(', ');
};

// The changes between two PAGE_STATE_FOR_DIFF results, a person's view: what flipped, what
// counts moved, what dialogs or controls appeared or went. null when nothing visible changed.
export function diffPage(a, b, { max = 12 } = {}) {
  if (!a || !b) return null;
  const path = (u) => { try { const x = new URL(u); return x.origin + x.pathname.replace(/\/+$/, ''); } catch { return u; } };
  const out = { changed: [], counts: [], notices: [], added: [], gone: [] };
  // A new document, not a new address: single-page apps keep state in the path (a map's
  // @lat,lng) without loading a page.
  if (a.doc && b.doc ? a.doc !== b.doc : path(a.url) !== path(b.url)) {
    out.newPage = { title: b.title, headings: b.texts.filter(t => t.kind === 'heading').slice(0, 4).map(t => t.text) };
    return out;
  }
  // A slider is often named by its own value ("10000"): match it by its words alone.
  const key = (c) => `${c.role}|${c.role === 'slider' || c.role === 'spinbutton' ? uncount(c.name).replace(/[\d,.$%]+/g, '').replace(/\s+/g, ' ').trim() : uncount(c.name)}`;
  const group = (list) => { const m = new Map(); for (const c of list) { const k = key(c); if (!m.has(k)) m.set(k, []); m.get(k).push(c); } return m; };
  const A = group(a.controls), B = group(b.controls);
  for (const [k, bs] of B) {
    const as = A.get(k) || [];
    bs.forEach((c, i) => {
      const old = as[i];
      if (!old) { out.added.push(c); return; }
      const was = stateWords(old.st), now = stateWords(c.st);
      // A slider renamed by its own value: report the value, not the name.
      if (/^(slider|spinbutton)$/.test(c.role) && old.name !== c.name) { if (was !== now) out.changed.push({ role: c.role, name: /[A-Za-z]{3}/.test(c.name) ? c.name : '', was, now }); return; }
      if (was !== now || old.name !== c.name) out.changed.push({ role: c.role, name: c.name, was: old.name !== c.name ? `${old.name}` : was, now: old.name !== c.name ? `${c.name}${now ? `, ${now}` : ''}` : now, renamed: old.name !== c.name });
    });
  }
  for (const [k, as] of A) { const bs = B.get(k) || []; for (const c of as.slice(bs.length)) out.gone.push(c); }
  const textSet = (list, kind) => new Set(list.filter(t => t.kind === kind).map(t => t.text));
  for (const kind of ['count', 'notice', 'heading']) {
    const was = textSet(a.texts, kind), now = textSet(b.texts, kind);
    const fresh = [...now].filter(t => !was.has(t)), lost = [...was].filter(t => !now.has(t));
    if (kind === 'count') fresh.forEach((t, i) => out.counts.push({ was: lost[i] || null, now: t }));
    // A live region that only holds prices or numbers (a cart total, a carousel's prices)
    // is not a notice a person reads.
    else if (kind === 'notice') fresh.filter(t => (t.match(/[A-Za-z\u00C0-\uFFFF]/g) || []).length >= t.replace(/\s/g, '').length * 0.5).forEach(t => out.notices.push(t));
    else fresh.forEach(t => out.notices.push(`heading "${t}"`));
  }
  // A dialog that appeared is the first thing a person sees.
  out.added.sort((x, y) => (/dialog/.test(y.role) ? 1 : 0) - (/dialog/.test(x.role) ? 1 : 0));
  const any = out.changed.length + out.counts.length + out.notices.length + out.added.length + out.gone.length;
  return any ? out : null;
}

export function formatDiff(d, { max = 10 } = {}) {
  if (!d) return '';
  if (d.newPage) return `page now: a different page, "${clip(d.newPage.title, 80)}"${d.newPage.headings.length ? `; headings: ${d.newPage.headings.map(h => `"${clip(h, 50)}"`).join(', ')}` : ''}`;
  const lines = ['changed on the page:'];
  for (const c of d.counts.slice(0, 4)) lines.push(`  ${c.was ? `"${clip(c.was, 60)}" → ` : ''}"${clip(c.now, 60)}"`);
  for (const n of d.notices.slice(0, 4)) lines.push(`  ! ${clip(n, 100)}`);
  for (const c of d.changed.slice(0, max)) lines.push(c.renamed ? `  ${c.role} "${clip(c.was, 50)}" → "${clip(c.now, 60)}"` : `  ${c.role}${c.name ? ` "${clip(c.name, 50)}"` : ''}: ${c.was || '—'} → ${c.now || '—'}`);
  if (d.changed.length > max) lines.push(`  (${d.changed.length - max} more changed)`);
  // Named, once each: a reloaded list adds and removes dozens of "Yes"/"No" and unnamed
  // buttons that say nothing; its count says enough.
  const named = (xs) => { const seen = new Set(); return xs.filter(c => { const k = `${c.role}|${c.name}`; if (!c.name || seen.has(k)) return false; seen.add(k); return true; }); };
  const list = (xs, n) => { const ys = named(xs); return ys.slice(0, n).map(c => `${c.role} "${clip(c.name, 40)}"`).join(', ') + (ys.length > n ? `, …` : ''); };
  const many = d.added.length > 15 || d.gone.length > 15;
  for (const c of named(d.added.filter(c => /dialog/.test(c.role)))) lines.push(`  + ${c.role} "${clip(c.name, 60)}" opened`);
  if (many) lines.push(`  a list or section was redrawn: ${d.added.length} controls new, ${d.gone.length} gone; new ones include ${list(d.added, 4) || 'unnamed controls'}`);
  else {
    if (d.added.length) lines.push(`  + ${d.added.length} new: ${list(d.added, 6) || 'unnamed controls'}`);
    if (d.gone.length) lines.push(`  − ${d.gone.length} gone: ${list(d.gone, 6) || 'unnamed controls'}`);
  }
  return lines.join('\n');
}

function clip(s, n) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n); }

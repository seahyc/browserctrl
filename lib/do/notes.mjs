// Flow notes during a plan (lib/notes.mjs): the current page's notes ride along in each Jev
// request as context, a reveal note runs when a step's target cannot be found, an on note
// runs when Jev sees its situation, and a URL note that covers a planned click is suggested.
// Notes that ran are confirmed or contradicted at the end of the run.
import * as notes from '../notes.mjs';
import * as site from '../site.mjs';
import { parseStep } from './parse.mjs';
import { settle } from './wait.mjs';
import { clip, prob } from './context.mjs';

export const pageKind = (url) => { const t = notes.pathTemplate(url); return t ? `${notes.siteOfUrl(url)} ${t}` : null; };

// The page's notes, read again only when the run reaches another kind of page.
export function pageNotes(ctx, url) {
  const cache = ctx.noteCache;
  if (!ctx.useNotes) return cache;
  const k = pageKind(url);
  if (k !== cache.kind) {
    cache.kind = k;
    try {
      cache.context = notes.forUrl(url, { max: 5 }).map(f => clip(f.text, 200));
      cache.runnable = notes.runnable(url);
    } catch { cache.context = []; cache.runnable = []; }
  }
  return cache;
}

// A URL note on this page that covers a planned click: say so, but leave the plan alone.
export function suggestUrlNotes(ctx) {
  if (!ctx.useNotes) return;
  const { report, view } = ctx;
  try {
    const tpl = notes.pathTemplate(view.url);
    const urlNotes = notes.forUrl(view.url, { max: Infinity }).filter(f => f.kind === 'url' && f.path === tpl);
    for (const s of ctx.steps) {
      if (!['click', 'select'].includes(s.action)) continue;
      const ctl = (s.action === 'select' ? `${s.target} = ${s.value}` : s.target).toLowerCase().replace(/\s+/g, ' ').trim();
      const f = urlNotes.find(n => n.key.split(' ').slice(2).join(' ') === ctl);
      if (f && !(report.suggestions ||= []).some(x => x.id === f.id)) report.suggestions.push({ id: f.id, text: f.text });
    }
  } catch {}
}

// A note's steps, run as sub-steps of a row. An on note stops at the first step it cannot
// do. A reveal note goes on past one: the page may already be part way there (Airbnb's
// filters dialog was open, so "click Filters" had nothing to do but the next step did).
// Returns { ok: every step acted, acted: how many did }.
export async function runNote(ctx, f, row, which) {
  const lines = (f.reveal || f.on).steps;
  let acted = 0;
  for (const [k, line] of lines.entries()) {
    const sub = { step: `${row.step}.${which}${k + 1}`, do: line };
    let r;
    try { r = await ctx.perform(parseStep(line), sub, { canSkip: false, inNote: true }); } catch (e) { r = { stop: { reason: e.message } }; }
    if (r.stop) {
      (row.note_steps ||= []).push({ do: line, stopped: r.stop.reason });
      if (f.on) return { ok: false, acted };
      continue;
    }
    if (r.acted) { acted++; await ctx.timed('settle', settle(ctx.conn, ctx.tab, 'step')); }
    (row.note_steps ||= []).push({ do: line, target: sub.target });
  }
  if (acted) ctx.view = await ctx.look();
  return { ok: acted === lines.length, acted };
}

// On notes ride along only when a request is made anyway, at most 3 per run each. Adds their
// questions; returns the notes asked about.
export function askOnNotes(ctx, known, questions, inNote) {
  const onNotes = !inNote && Object.keys(questions).length ? known.runnable.filter(f => f.on && (ctx.fired.get(f.id) || 0) < 3).slice(0, 3) : [];
  for (const f of onNotes) questions[`on_${f.id}`] = { type: 'noul', instructions: `Is this situation showing on the page right now: ${f.on.situation}?` };
  return onNotes;
}

// A situation an on note handles: run its steps. true when they all ran (ground the step
// again on the page they left).
export async function runOnNote(ctx, onNotes, answers, row) {
  const onHit = onNotes.find(f => prob(answers[`on_${f.id}`]) >= 0.5);
  if (!onHit) return false;
  ctx.fired.set(onHit.id, (ctx.fired.get(onHit.id) || 0) + 1);
  const { ok } = await runNote(ctx, onHit, row, 'on');
  ctx.applied.set(onHit.id, ok && ctx.applied.get(onHit.id) !== false);
  (row.via_notes ||= []).push({ id: onHit.id, kind: 'on', ok });
  ctx.report.events.push({ type: 'note', after_step: ctx.lastRow?.step ?? 0, id: onHit.id, kind: 'on', text: onHit.on.situation, ok });
  return ok;
}

// The target is not on the page: a reveal note may say how to bring it out. true when its
// steps acted (ground the step again from the start).
export async function runRevealNote(ctx, step, row, why, inNote) {
  const reveal = why && !row.revealed && !inNote ? notes.revealFor(pageNotes(ctx, ctx.view.url).runnable, step.target) : null;
  if (!reveal) return false;
  row.revealed = reveal.id;
  const { ok, acted } = await runNote(ctx, reveal, row, 'r');
  (row.via_notes ||= []).push({ id: reveal.id, kind: 'reveal', ok });
  // Only a note that ran in full and still left the target out is wrong; one whose
  // steps could not run did not apply here and is neither confirmed nor contradicted.
  row.reveal_full = ok;
  return Boolean(acted);
}

// After a step: the recipes and notes of a kind of page the run reached for the first time.
export function afterStep(ctx, row) {
  if (ctx.opts.noNotes) return;
  const before = pageKind(row.url_before), after = pageKind(row.url_after);
  if (before) ctx.hinted.add(before);
  if (after && !ctx.hinted.has(after)) {
    ctx.hinted.add(after);
    const h = site.hintBlock(row.url_after);
    if (h.length) row.hints = h;
  }
}

// Notes that ran: confirmed when they worked, contradicted when they did not.
export function settleNotes(ctx) {
  const { applied, report } = ctx;
  if (!applied.size) return;
  report.notes_applied = [...applied].map(([id, ok]) => ({ id, ok }));
  for (const { id, ok } of report.notes_applied) { try { ok ? notes.confirm(id) : notes.contradict(id); } catch {} }
}

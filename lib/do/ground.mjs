// Grounding a step: which element its words mean. A ref, items id or selector names one
// directly; otherwise an element whose name is exactly the target, an option of an open
// list, or one Jev choice among the page's controls. When none is found with confidence,
// the step stops with a report of what is there instead.
import * as ops from '../ops.mjs';
import * as jev from '../jev.mjs';
import * as show from '../show.mjs';
import * as finder from '../find.mjs';
import { page } from '../page/index.mjs';
import { parseDateText, monthNumber } from '../page/shared.mjs';
import { STEP, sleep } from '../timing.mjs';
import { settle } from './wait.mjs';
import { norm, clip, describeEl, pinKey, AFRESH } from './context.mjs';
import { safeToDismiss, DISMISS_WORDS } from './overlays.mjs';
import { runRevealNote } from './notes.mjs';
import { visionPick } from './vision.mjs';
import { closeOpenedSection } from './toggles.mjs';

// An element whose name is exactly the target needs no model: "Apply", "More filters".
export function exactMatch(snap, step) {
  // Alternatives ("Filters" | "All filters"): the first one the page has by exact name.
  if (step.alts) {
    for (const target of step.alts) { const e = exactMatch(snap, { ...step, target, alts: null }); if (e) return { ...e, alt: target }; }
    return null;
  }
  const want = norm(step.target);
  // A field's placeholder is the name a person sees ("Search or filter results…").
  const bare = (s) => norm(s).replace(/[.…]+$/, '');
  let hits = jev.candidatesFor(snap.elements, step.action).filter(e => norm(e.name) === want || (e.placeholder && bare(e.placeholder) === bare(want)));
  // A covered Save button can be recovered by closing its inline picker after grounding.
  if (!hits.length && step.action === 'click') hits = snap.elements.filter(e => !e.disabled && !e.hidden && !e.inert && e.covered && e.role === 'button' && norm(e.name) === want && /^(save|done|apply|submit|confirm|update|create|continue|finish)\b/i.test(e.name));
  // A filter written with the result count the page shows beside it ("Middle Income Jobs
  // ($30K-$49K) (924)"), or a control named with its count when the plan left it out: the
  // count is not part of the name.
  if (!hits.length && ['click', 'hover'].includes(step.action)) {
    const uncounted = (s) => norm(s).replace(/\s*\(\s*\d[\d,.]*\s*\)$/, '');
    if (uncounted(want)) hits = jev.candidatesFor(snap.elements, step.action).filter(e => e.name && uncounted(e.name) === uncounted(want));
  }
  // A click wants the control that acts on a click: "click Search" after filling the search
  // box is its button, not the box whose placeholder also says "Search" (Ohio Means Jobs).
  // A name beats a placeholder, and a button, link or option beats a text field.
  if (step.action === 'click' && hits.length > 1) {
    const prefer = (keep) => { const k = hits.filter(keep); if (k.length) hits = k; };
    prefer(e => norm(e.name) === want);
    prefer(e => !/^(textbox|searchbox|combobox)$/.test(e.role));
  }
  if (hits.length <= 1) return hits[0] || null;
  // Several controls carry the exact name (a header link and a hero button both saying
  // "Order Now"): the plan named it exactly, so take the first one on screen, in page order.
  // One that nothing covers first (a sticky results bar over a tab row's first copy).
  const pick = hits.find(e => !e.offscreen && !e.covered) || hits.find(e => !e.offscreen) || hits[0];
  return { ...pick, duplicates: hits.length };
}

// Every word of a step's target in a control's name, with max/maximum and min/minimum alike
// and symbols ignored: "Max Price $" carries "Maximum Price".
const WORD_FORMS = { maximum: 'max', minimum: 'min', from: 'min', to: 'max' };
const wordsOf = (s) => new Set((String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).map(w => WORD_FORMS[w] || w));
export function sameWords(name, target) {
  const want = [...wordsOf(target)].filter(w => w.length > 1);
  if (!want.length) return false;
  const have = wordsOf(name);
  return want.every(w => have.has(w));
}

// Numbers and dates the intent names must show up in what Jev picked: "October 17, 2026"
// is not "When Add dates", and "Under $25,000" is not "Payment & Price". Ordinals ("2nd
// result") describe position, not text. Returns the missing pieces, or [].
export function missingFromPick(intent, el) {
  // A result count the page prints beside a filter, "(924)", is not part of its name.
  const said = String(intent || '').toLowerCase().replace(/\s*\(\s*\d[\d,.]*\s*\)\s*$/, '');
  const seen = [el?.name, el?.value, el?.placeholder, el?.within, el?.testid, el?.href].filter(Boolean).join(' ').toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1');
  const nums = [...said.replace(/(\d),(?=\d{3}\b)/g, '$1').matchAll(/(?<![\w.])(\d+(?:\.\d+)?)(?!\d|st\b|nd\b|rd\b|th\b)/g)].map(m => m[1]);
  const missing = nums.filter(n => !new RegExp(`(?<!\\d)${n.replace('.', '\\.')}(?!\\d)`).test(seen));
  // A month the intent names, in any language, must be the pick's month too.
  const seenMonths = new Set((seen.match(/\p{L}+/gu) || []).map(monthNumber).filter(Boolean));
  // Three letters count only as the English abbreviations: "ago", "out" and "set" start
  // month names elsewhere but are ordinary words in an intent.
  const ABBR = new Set(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']);
  for (const w of said.match(/\p{L}+/gu) || []) {
    const m = (w.length > 3 || ABBR.has(w)) && monthNumber(w);
    if (!m || (!/\d/.test(said) && ['may', 'march', 'mart', 'mai'].includes(w))) continue; // "may" the verb
    if (!seenMonths.has(m)) missing.push(w);
  }
  return [...new Set(missing)];
}

// A target named directly: a pinned ref, an item id, a CSS selector. null when the step
// has none (or a selector-like target matches nothing: then it is described to Jev).
export async function findDirect(ctx, step, snap) {
  const kind = step.pin ? 'pin' : step.item ? 'item' : step.selector ? 'selector' : null;
  if (!kind && !step.ref) return null;
  if (step.ref && (step.pinError || !step.pin)) return { stop: { reason: `${step.ref} is not on the page any more (${step.pinError || 'no snapshot'}); read the page again and use the new ref` } };
  const key = step.pin || pinKey();
  const r = await ops.evaluate(ctx.conn, ctx.tab, page('find-direct', { kind, value: step.pin || step.item || step.selector, key, action: step.action })).catch(e => ({ error: e.message }));
  if (r?.error) {
    if (kind === 'selector') return null;
    if (kind === 'item') return { stop: { reason: r.error === 'no_items' ? `${step.item} is an items id, but items has not run on this page; run items, then use its ids` : `${step.item} is not on the page any more; run items again` } };
    return { stop: { reason: `${step.ref} is not on the page any more (${r.error}); read the page again and use the new ref` } };
  }
  const fromSnap = r.ref && snap?.elements.find(e => e.ref === r.ref);
  const how = kind === 'pin' ? step.ref : kind === 'item' ? `item ${step.item}` : 'selector';
  return { el: { ...(fromSnap || { ...r, ref: null }), selector: r.selector }, how };
}

// Unnamed icon buttons take their row's name ("Increase Children").
export async function nameUnnamed(ctx, snap) {
  const refs = snap.elements.filter(e => !e.hidden && ['button', 'link', 'generic'].includes(e.role) && !(e.name || '').trim()).map(e => e.ref).slice(0, 80);
  if (!refs.length) return;
  const names = await ops.evaluate(ctx.conn, ctx.tab, page('name-unnamed', { refs })).catch(() => ({}));
  for (const e of snap.elements) if (names?.[e.ref]) { e.name = names[e.ref]; e.derived = true; if (!/^(Increase|Decrease|Close)\b/.test(e.name)) e.borrowed = true; }
}

// Candidates that share a name get their row's heading or label, for Jev and for a stop.
export async function nameDuplicates(ctx, snap, action) {
  const groups = new Map();
  for (const e of jev.candidatesFor(snap.elements, action)) { const k = norm(e.name); if (k) (groups.get(k) || groups.set(k, []).get(k)).push(e); }
  const refs = [...groups.values()].filter(g => g.length > 1).flat().map(e => e.ref).slice(0, 40);
  if (!refs.length) return;
  const near = await ops.evaluate(ctx.conn, ctx.tab, page('near-context', { refs })).catch(() => ({}));
  for (const e of snap.elements) if (near?.[e.ref]) e.near = clip(near[e.ref], 60);
}

// Read the page and find the step's element without a model: directly, by exact name, or as
// an option of an open list. g (the step's grounding so far) gets snap, and el or the Jev
// question (tq). Returns a result to end the step with (a skip or a stop), or null.
export async function groundTarget(ctx, step, row, g, { canSkip }) {
  const { conn, tab } = ctx;
  g.snap = await ctx.readPage();
  await nameUnnamed(ctx, g.snap);
  const direct = await findDirect(ctx, step, g.snap);
  if (direct?.stop) { if (canSkip) { row.skipped = direct.stop.reason; return {}; } return direct; }
  if (direct?.el) { g.el = direct.el; row.how = direct.how; }
  else {
    g.el = exactMatch(g.snap, step);
    if (g.el) row.how = g.el.duplicates ? `exact, first of ${g.el.duplicates}` : 'exact';
    else if (step.action === 'click') {
      // An option of an open custom listbox is often missing from the snapshot.
      const key = pinKey();
      const o = await ops.evaluate(conn, tab, page('find-direct', { kind: 'option', value: step.target, key, action: 'click' })).catch(() => null);
      if (o && !o.error && o.shown) { g.el = { ...(o.ref && g.snap.elements.find(e => e.ref === o.ref) || { ...o, ref: null }), selector: o.selector }; row.how = 'option'; }
    }
  }
  if (!g.el) { await nameDuplicates(ctx, g.snap, step.action); g.tq = jev.targetQuestion(g.snap, { intent: step.target, action: step.action }); }
  if (ctx.showOn) {
    // What Jev is shown: every candidate it will choose among (or the exact match).
    await show.annotate(conn, tab, { cands: g.el ? [g.el] : g.tq?.cands || [], pick: g.el?.ref });
    await show.panel(conn, tab, { title: 'browserctrl do', append: g.el ? `${row.do}\n   exact name match, no model call` : `${row.do}\n   Jev sees ${g.tq?.cands?.length || 0} ${step.action}able controls + on-screen text` });
    await sleep(STEP.SHOW_CANDIDATES);
  }
  return null;
}

// What Jev answered for the target, shown to a person watching (--show): candidates tinted
// by probability, the pick in red.
export async function showPick(ctx, g) {
  const probs = Object.fromEntries((g.pick.ranked || []).map(c => [c.ref, c.p]));
  await show.annotate(ctx.conn, ctx.tab, { cands: g.tq.cands, probs, pick: g.pick.pick?.ref });
  await show.panel(ctx.conn, ctx.tab, { title: 'browserctrl do', append: `   Jev: ${(g.pick.ranked || []).slice(0, 3).map(c => `${Math.round(c.p * 100)}% ${c.ref === 'none' ? 'none' : `${c.role} "${clip(c.name, 30)}"`}`).join(', ')}` });
  await sleep(STEP.SHOW_ANSWER);
}

// Not on screen, but a control of exactly that name sits in a collapsed section (a filter
// group the last plan left shut, a closed <details>): open that section, once. Only when
// every hidden match has the same opener. true when it was opened (ground the step again).
async function openCollapsed(ctx, step, row, inNote) {
  if (row.autoRevealed || inNote || !['click', 'hover', 'fill', 'select'].includes(step.action) || step.ref || step.item || step.selector) return false;
  const exact = `^\\s*${String(step.target).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`;
  const found = await ops.evaluate(ctx.conn, ctx.tab, finder.FIND(exact, { limit: 6, pin: true })).catch(() => null);
  const hidden = (found?.rows || []).filter(x => x.hidden);
  const openers = [...new Set(hidden.map(x => x.opens_with?.handle))];
  if (!(hidden.length && openers.length === 1 && openers[0] && hidden.length === (found.rows || []).length)) return false;
  row.autoRevealed = hidden[0].opens_with.name;
  await ctx.timed('input', ctx.clickSel({ selector: openers[0] })).catch(() => {});
  await ctx.timed('settle', settle(ctx.conn, ctx.tab, 'section'));
  return true;
}

// No element yet: take Jev's pick, or settle and ask once more, or bring the target out of
// hiding (a reveal note, closing a section this plan opened, opening a collapsed one), or
// stop with the candidates and what is on the page. Sets g.el (and g.snap after a second
// read). Returns AFRESH to ground the step again from the start, a result to end it with,
// or null when g.el is the element to act on.
export async function resolvePick(ctx, step, row, g, { retryMs, canSkip, inNote }) {
  const { conn, tab } = ctx;
  if (!g.tq?.question) g.pick = { pick: null, ranked: [], reason: `No ${step.action}able elements on the page` };
  if (!g.pick.pick || (g.pick.p ?? 0) < ctx.minP) {
    // Often the page is still rendering what the step needs (a suggestion list that
    // loads after typing): settle once more and ask again before giving up.
    row.retried = true;
    await ctx.timed('retry', settle(conn, tab, { maxMs: retryMs }));
    g.snap = await ctx.readPage();
    await nameUnnamed(ctx, g.snap);
    g.el = exactMatch(g.snap, step);
    if (g.el) { row.how = 'exact'; g.pick = null; }
    else {
      await nameDuplicates(ctx, g.snap, step.action);
      ctx.view = await ctx.look();
      const first = g.pick;
      try { g.pick = await jev.pickTarget(ctx.getCfg(), g.snap, { intent: step.target, action: step.action, view: ctx.view }, ctx.fetchOpts); ctx.report.jev_calls++; }
      catch (e) { return { stop: { reason: e.message } }; }
      // A second look that lands on a different element without real confidence is a
      // coin flip, not new information: stop with both rather than act.
      if (first?.pick && g.pick.pick && first.pick.ref !== g.pick.pick.ref && (g.pick.p ?? 0) < 0.8) {
        g.pick = { ...g.pick, pick: null, reason: `Jev was unsure between ${describeEl(first.pick)} (p=${first.p}) and ${describeEl(g.pick.pick)} (p=${g.pick.p}); name the element exactly` };
      }
    }
  }
  if (g.el) return null;
  let visionReason;
  if (!g.pick?.pick || (g.pick.p ?? 0) < ctx.minP) {
    const visual = await visionPick(ctx, step, row, g.snap);
    if (visual?.el) { g.el = visual.el; return null; }
    if (visual?.result) return visual.result;
    visionReason = visual?.reason;
  }
  const { pick, snap } = g;
  const cctx = ctx.commitCtx(snap);
  let why = jev.refusal(pick, ctx.minP, cctx);
  // A pick that lacks a number or date the step names is a different element.
  const missing = !why && ['click', 'hover'].includes(step.action) ? missingFromPick(step.target, pick.pick) : [];
  if (missing.length) why = `Jev picked ${describeEl(pick.pick)} (p=${pick.p}), which does not show ${missing.map(m => `"${m}"`).join(', ')} from the step; name the element exactly${parseDateText(step.target) ? ', or use a date step (date YYYY-MM-DD)' : ''}`;
  if (why) {
    // The target is not on the page: a reveal note may say how to bring it out.
    if (await runRevealNote(ctx, step, row, why, inNote)) return AFRESH;
    if (await closeOpenedSection(ctx, step, row)) return AFRESH;
    if (await openCollapsed(ctx, step, row, inNote)) return AFRESH;
  }
  if (why && visionReason) why += `; ${visionReason}`;
  // Several candidates with the same name: Jev cannot tell them apart by name, but
  // the caller can by ref.
  const top = (pick.ranked || []).find(c => c.ref !== 'none');
  const lead = pick.pick || (top && top.p >= 0.3 ? top : null); // not when Jev found nothing like it
  const twins = why && lead && snap ? jev.candidatesFor(snap.elements, step.action).filter(c => norm(c.name) === norm(lead.name)) : [];
  if (twins.length > 1) why = `${why}; ${twins.length} controls share the same name "${clip(lead.name, 40)}": click ${twins.slice(0, 4).map(c => `${c.ref}${c.near ? ` (near "${clip(c.near, 40)}")` : ''}`).join(' or click ')}`;
  if (why) {
    const committing = pick.pick && jev.commits(pick.pick.name, pick.pick, cctx);
    if (committing && step.commit) return { stop: { reason: `A committing step needs the control's exact name; Jev guessed "${clip(pick.pick.name, 60)}". Re-plan with ${step.action}! "<its exact name>"`, candidates: (pick.ranked || []).filter(c => c.ref !== 'none') } };
    if (canSkip && !committing) { row.skipped = why; return {}; }
    return { stop: { reason: why, candidates: (pick.ranked || []).filter(c => c.ref !== 'none'), ...(await ctx.timed('stop_report', whatIsThere(ctx, step))) } };
  }
  g.el = pick.pick;
  row.how = `jev p=${pick.p}`;
  // Acted on, but not sure: the report marks it ⚠ so the caller looks before trusting it.
  if ((pick.p ?? 0) < 0.75) row.unsure = true;
  return null;
}

// When a step finds nothing, say what is there instead: a hidden element with that name
// (often opened by another control) and the controls on screen, so the caller can
// re-plan from this report rather than probing the page.
export async function whatIsThere(ctx, step) {
  const { conn, tab } = ctx;
  const out = {};
  try {
    const all = await ops.readPage(conn, tab, { maxText: 0, max: 600, includeHidden: true, all: true });
    const want = norm(step.target).split(' ').filter(w => w.length > 2);
    const hidden = all.elements.filter(e => e.hidden && want.some(w => norm(e.name).includes(w))).slice(0, 5);
    if (hidden.length) out.hidden = hidden.map(e => `${e.role} "${(e.name || '').slice(0, 50)}" (hidden or zero-size)`);
    const shown = await ops.readPage(conn, tab, { maxText: 0, max: 1500, all: true });
    // A cross-origin popup (marketing sign-up, chat) is an iframe whose text the overlay check
    // cannot see: many controls covered by an iframe is the sign.
    const underFrame = shown.elements.filter(e => !e.hidden && /^iframe\b/.test(String(e.covered || ''))).length;
    if (underFrame >= 5) out.covered = `${underFrame} controls are covered by an iframe, likely a sign-up or chat popup; close it (its close button, or key Escape), then re-plan`;
    // The target is there but something sits on it (a tooltip, a popover): say what.
    const under = shown.elements.filter(e => !e.hidden && e.covered && !e.coverPinned && want.some(w => norm(e.name).includes(w))).slice(0, 3);
    if (under.length && !out.covered) out.covered = under.map(e => `${describeEl(e)} is under ${e.covered}`).join('; ');
    // A dialog, popover or coachmark on top ("Now you'll see one price…", "Got it") makes
    // the rest of the page unreachable: name it and the harmless control that closes it.
    const top = shown.elements.filter(e => !e.hidden && e.modal);
    // Not when the target itself is in the dialog (Gym in Airbnb's Filters): closing it would
    // be the wrong advice.
    const targetInside = top.some(e => want.length && want.every(w => norm(e.name).includes(w)));
    if ((shown.modal || top.length) && !targetInside) {
      const closers = top.filter(e => safeToDismiss(e) && DISMISS_WORDS.test((e.name || '').trim()));
      const what = shown.modal ? `a ${shown.modal.role} "${clip(shown.modal.name, 60)}"` : 'a popup';
      out.onTop = `${what} is on top and the rest of the page waits behind it; ${closers.length ? `close it with click "${clip(closers[0].name, 30)}"${closers[1] ? ` (or click "${clip(closers[1].name, 30)}")` : ''}` : 'close it (its close control, or key Escape)'}, then run the step again (or start the plan with optional ${closers.length ? `click "${clip(closers[0].name, 30)}"` : 'key Escape'})`;
    }
    const roles = jev.candidatesFor(shown.elements, step.action === 'fill' ? 'fill' : 'click');
    const seen = new Set();
    out.controls = roles
      .map(e => `${e.role} "${(e.name || '').replace(/\s+/g, ' ').slice(0, 40)}"`)
      .filter(x => !x.endsWith('""') && !seen.has(x) && seen.add(x))
      .slice(0, 40);
  } catch {}
  return out;
}

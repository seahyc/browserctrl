// One step of a plan: ground it, ask Jev what it needs to know (the target, the previous
// step's expected result, a blocking overlay, on notes) in one request, act, and check what
// the action did once the page settles.
import * as ops from '../ops.mjs';
import * as jev from '../jev.mjs';
import * as show from '../show.mjs';
import { page } from '../page/index.mjs';
import { STEP, NAV, sleep } from '../timing.mjs';
import { TARGETED } from './parse.mjs';
import { settle, meetChallenge } from './wait.mjs';
import { clip, prob, describeEl, expectQuestion, AGAIN, AFRESH } from './context.mjs';
import { groundTarget, resolvePick, showPick } from './ground.mjs';
import { dateWanted as dateOf, findDate, dateBefore } from './dates.mjs';
import { setSlider, sliderForFill } from './sliders.mjs';
import { blockerQuestion, inOverlay, dismissOverlay } from './overlays.mjs';
import { pageNotes, askOnNotes, runOnNote, afterStep } from './notes.mjs';
import { commitGuard } from './commit.mjs';
import { beforeClick } from './toggles.mjs';
import { pickFromList } from './select.mjs';
import { outcome, errorState, newNotices, urlChange } from './outcome.mjs';
import { JUDGED, judgment, settleJudgment } from './judgments.mjs';

// What one pass of a step can end with besides a result: AGAIN, try again on the page as it
// is now (an on note ran, an overlay was closed, the control was redrawn), or AFRESH, start
// the tries afresh (the target was brought out of hiding: a reveal note ran, a section this
// plan opened was closed, or the collapsed section that holds it was opened).
// A step gets 3 tries; each of the three ways to bring its target out of hiding runs at most
// once per step (row.revealed, row.closedOpen, row.autoRevealed), so it can start the tries
// afresh at most 3 times: 4 rounds of 3 tries is the most a step can take. The pass cap
// says so outright, in case a new way to start afresh forgets its once-only mark.
const TRIES = 3, MAX_PASSES = TRIES * 4;

// Ground and do one step. `extra` questions ride along in the same request; `stopIf`
// ends the step before acting (the loop's until condition).
export async function perform(ctx, step, row, { extra = {}, stopIf, retryMs = STEP.RETRY, canSkip = step.optional, inNote = false } = {}) {
  const o = { extra, stopIf, retryMs, canSkip, inNote };
  let tries = 0;
  for (let pass = 0; pass < MAX_PASSES && tries < TRIES; pass++) {
    const r = await attempt(ctx, step, row, o);
    if (r === AGAIN) tries++;
    else if (r === AFRESH) tries = 0;
    else return r;
  }
  return { stop: { reason: 'Overlays kept appearing after dismissing them' } };
}

// One pass: a result, AGAIN or AFRESH.
async function attempt(ctx, step, row, o) {
  const { conn, tab } = ctx;
  const { canSkip, inNote } = o;
  // g: what grounding found so far: the snapshot, the element, Jev's question and pick.
  const g = { snap: null, el: null, tq: null, pick: null };
  // A date step, or a click that names a whole date: the day cell, paging months to it.
  const dateWanted = dateOf(step);
  if (dateWanted) {
    const d = await findDate(ctx, dateWanted);
    if (d.el) { g.el = d.el; row.how = d.how; }
    else if (step.action === 'date') { if (canSkip) { row.skipped = d.reason; return {}; } return { stop: { reason: d.reason } }; }
  }
  // A fill whose value is a number, on a slider of exactly that name, sets the slider.
  const sliderPlan = await sliderForFill(ctx, step);
  if (!g.el && TARGETED.has(step.action) && !sliderPlan) {
    const r = await groundTarget(ctx, step, row, g, o);
    if (r) return r;
  }

  // extract, pick and if: their question rides in this step's one Jev request.
  let j = null;
  if (JUDGED.has(step.action)) {
    j = await judgment(ctx, step);
    if (j.stop) { if (canSkip) { row.skipped = j.stop.reason; return {}; } return { stop: j.stop }; }
    o = { ...o, extra: { ...o.extra, [j.key]: j.question } };
  }
  const asked = await askJev(ctx, step, row, g, o);
  if (asked === AGAIN) return AGAIN;
  if (asked.result) return asked.result;
  const { answers, watchBlocker } = asked;
  if (step.action === 'expect') {
    row.p = prob(answers.expect);
    return row.p >= 0.5 ? {} : { stop: { reason: `The page does not show: ${step.target} (p=${row.p})` } };
  }
  if (j) {
    const s = settleJudgment(ctx, step, row, j, answers);
    if (s.result) return s.result;
    return attempt(ctx, s.then, row, { ...o, extra: {} });
  }
  if (g.tq?.question && answers.target) {
    try { g.pick = jev.readTarget(answers.target, g.tq.cands); } catch (e) { return { stop: { reason: e.message } }; }
    if (ctx.showOn) await showPick(ctx, g);
  }
  if (watchBlocker && prob(answers.blocker) >= 0.5) {
    const chosen = g.el || (g.pick?.p >= ctx.minP ? g.pick.pick : null);
    // The step works in the dialog itself (its OK, its stepper): nothing to dismiss.
    const inside = chosen ? await inOverlay(ctx, chosen, g.snap) : false;
    if (!inside) {
      const d = await dismissOverlay(ctx, row);
      if (d.stop) return d;
      return AGAIN; // re-ground on the cleared page
    }
  }

  // Steps with no element.
  if (ctx.showOn && ['key', 'type', 'scroll', 'nav'].includes(step.action)) {
    await show.act(conn, tab, { kind: step.action, label: step.action === 'key' ? `⌨ ${step.target === 'Enter' ? '⏎ Enter' : step.target}` : step.action === 'type' ? `type "${clip(step.target, 40)}"` : step.action === 'scroll' ? `scroll ${step.target}` : `go to ${clip(step.target, 60)}` });
  }
  if (step.action === 'key') {
    const errBefore = await errorState(ctx);
    await ops.key(conn, tab, step.target);
    return { acted: true, outcome: { errBefore } };
  }
  if (step.action === 'type') { await ops.type(conn, tab, step.target); return { acted: true }; }
  if (step.action === 'scroll') { await ops.scroll(conn, tab, { deltaY: /up/i.test(step.target) ? -700 : 700 }); return { acted: true }; }
  if (step.action === 'wait') { await sleep(Math.min(Number(step.target) || STEP.WAIT, STEP.WAIT_MAX)); return { acted: true }; }
  if (step.action === 'nav') { await ops.navigate(conn, tab, step.target, { timeoutMs: NAV.TIMEOUT }); return { acted: true }; }
  if (step.action === 'set' || sliderPlan) return setSlider(ctx, step, row, sliderPlan);

  if (!g.el) {
    const r = await resolvePick(ctx, step, row, g, o);
    if (r) return r; // AFRESH, or a result
  }
  const { el, snap } = g;
  const deliberate = Boolean(step.ref || step.item);
  const guard = await commitGuard(ctx, step, row, el, snap, deliberate);
  if (guard) return guard;
  const t = el.ref && snap ? { ref: el.ref, token: snap.token } : { selector: el.selector };
  row.target = describeEl(el);
  row.el = { role: el.role, name: clip(el.name, 80), ref: el.ref };
  if (ctx.showOn) await show.act(conn, tab, { ref: el.ref, kind: step.action, label: step.action === 'fill' ? `type "${clip(step.value, 40)}" into ${clip(el.name, 30) || el.role}` : step.action === 'select' ? `choose "${clip(step.value, 40)}"` : `${step.action} ${clip(el.name, 50) || el.role}` });
  // What to check once the page settles: a box that should have toggled, a section that
  // should open, a day the calendar should show chosen, and errors.
  const before = await beforeClick(ctx, step, row, el, deliberate);
  if (before.result) return before.result;
  const { toggle, disclosure } = before;
  const optionSel = step.action === 'click' ? (toggle?.selector || disclosure?.selector || await ctx.pin(el)) : null;
  const selection = optionSel ? await ops.evaluate(conn, tab, page('option-state', { selector: optionSel, key: `option-${Date.now()}` })).catch(() => null) : null;
  const errBefore = ['click', 'date', 'select'].includes(step.action) ? await errorState(ctx) : null;
  const dateCheck = dateWanted && el.selector ? await dateBefore(ctx, el, dateWanted) : null;
  try {
    if (step.action === 'click' || step.action === 'date') await ctx.timed('input', ctx.clickSel(t));
    else if (step.action === 'hover') await ctx.timed('input', ops.hover(conn, tab, t));
    else if (step.action === 'fill') { await ctx.timed('input', ops.fill(conn, tab, { ...t, value: step.value })); ctx.lastFilled = el; }
    else if (step.action === 'select') {
      try { await ops.selectOption(conn, tab, { ...t, label: step.value }); }
      catch (e) {
        if (e.code !== 'not_select') throw e;
        await pickFromList(ctx, step, row, el, t);
      }
    }
  } catch (e) {
    // The page redrew the control between the read and the input (Airbnb rebuilds its
    // guest panel after each stepper click), or the last step's navigation landed after
    // the read (a results page, a cookie choice that reloads): nothing was sent, so find
    // it again once on the page as it is now.
    if (['detached', 'no_snapshot', 'navigated', 'stale', 'unknown_ref', 'frame_replaced'].includes(e.code) && !step.ref && !row.regrounded) {
      row.regrounded = true;
      await settle(conn, tab, 'reground');
      return AGAIN;
    }
    throw e;
  }
  if (row.revealed) { row.how = `${row.how}, via note ${row.revealed}`; ctx.applied.set(row.revealed, ctx.applied.get(row.revealed) !== false); }
  if (row.closedOpen) row.how = `${row.how}, closed ${row.closedOpen} first`;
  if (row.autoRevealed) row.how = `${row.how}, opened "${clip(row.autoRevealed, 40)}" first: it was in that collapsed section`;
  return { acted: true, outcome: { toggle, disclosure, errBefore, dateCheck, selection: selection && { selector: optionSel, before: selection } } };
}

// The one Jev request a step makes: its target (when no exact match), the previous step's
// expected result, this step's expectation, a blocking overlay, on notes and the caller's
// extra questions. Hands off the previous expectation and runs an on note that matched.
// Returns { answers, watchBlocker }, { result }, or AGAIN after an on note.
async function askJev(ctx, step, row, g, { extra, stopIf, inNote }) {
  const { view } = ctx;
  const questions = { ...extra };
  if (g.tq?.question) questions.target = g.tq.question;
  if (ctx.pending) questions.prev_expect = expectQuestion(ctx.pending.expect);
  if (step.action === 'expect') questions.expect = expectQuestion(step.target);
  const watchBlocker = view.overlay?.trim() && !['nav', 'wait', 'expect', 'extract', 'if'].includes(step.action);
  if (watchBlocker) questions.blocker = blockerQuestion(row.do);
  const known = pageNotes(ctx, view.url);
  const onNotes = askOnNotes(ctx, known, questions, inNote);
  let answers = {};
  if (Object.keys(questions).length) {
    const essential = Object.keys(questions).some(k => k !== 'blocker');
    try {
      // On-screen text misses controls below the fold (a Next link at the page bottom),
      // so questions about what exists also see every control on the page.
      const controls = g.snap ? [...new Set(g.snap.elements.filter(e => e.name).map(e => `${e.role} "${e.name.slice(0, 40)}"`))].slice(0, 120) : undefined;
      const r = await ctx.ask({ page: jev.viewState(view), ...(controls ? { controls_on_page: controls } : {}), next_step: row.do, ...(TARGETED.has(step.action) ? { action: step.action, intent: step.target } : {}),
        ...(known.context.length ? { site_notes: known.context } : {}) }, questions);
      answers = r.answers;
      row.jev_ms = (row.jev_ms || 0) + r.ms;
    } catch (e) {
      if (essential) return { result: { stop: { reason: e.message } } };
    }
  }
  const { pending } = ctx;
  if (pending) {
    const p = prob(answers.prev_expect);
    pending.row.expect_p = p;
    if (!(p >= 0.5)) return { result: { expectFailed: true, stop: { step: pending.row.step, reason: `Step ${pending.row.step} expected "${pending.expect}", but the page does not show it (p=${p})` } } };
    ctx.pending = null;
  }
  if (stopIf?.(answers)) return { result: { met: true } };
  // A situation an on note handles: run its steps, then ground this step again.
  if (await runOnNote(ctx, onNotes, answers, row)) return AGAIN;
  return { answers, watchBlocker };
}

// Run one step with its bookkeeping: settle, challenge, notices, expectation hand-off.
export async function runOne(ctx, step, row, performOpts) {
  const { conn, tab } = ctx;
  const t0 = Date.now();
  row.url_before = ctx.view.url;
  let res;
  try {
    res = await perform(ctx, step, row, performOpts);
    if (res.acted) {
      if (ctx.showOn) await show.busy(conn, tab, true, 'waiting for the page to settle');
      // Search-as-you-type waits 250-500 ms after the last key before it fetches.
      row.settle_ms = await ctx.timed('settle', settle(conn, tab, ['type', 'fill'].includes(step.action) ? 'typing' : 'step'));
      row.settle_why = settle.why;
      const why = await meetChallenge(conn, tab, row, ctx);
      if (why) res = { stop: { reason: why } };
      const before = ctx.view;
      ctx.view = await ctx.look();
      for (const t of newNotices(before, ctx.view)) ctx.notice(row, t);
      if (!res.stop) { const bad = await outcome(ctx, res.outcome, row); if (bad) res = { stop: { reason: bad } }; }
    }
  } catch (e) {
    res = { stop: { reason: e.message } };
  }
  if (row.revealed && row.reveal_full && (res?.stop || row.autoRevealed)) ctx.applied.set(row.revealed, false);
  row.url_after = ctx.view.url;
  const change = urlChange(row.url_before, row.url_after);
  if (change) row.url_change = change;
  afterStep(ctx, row);
  row.ms = Date.now() - t0;
  if (!res.stop && !res.met && !row.skipped && step.expect) ctx.pending = { expect: step.expect, row };
  if (!row.skipped && !res.met) ctx.lastRow = row;
  return res;
}

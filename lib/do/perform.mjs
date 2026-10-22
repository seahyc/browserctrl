// One step of a plan: ground it, ask Jev what it needs to know (the target, the previous
// step's expected result, a blocking overlay, on notes) in one request, act, and check what
// the action did once the page settles.
import * as ops from '../ops.mjs';
import * as jev from '../jev.mjs';
import * as show from '../show.mjs';
import { page } from '../page/index.mjs';
import { STEP, NAV, PLAN, SETTLE, sleep } from '../timing.mjs';
import { TARGETED } from './parse.mjs';
import { settle, meetChallenge } from './wait.mjs';
import { clip, prob, describeEl, expectQuestion, AGAIN, AFRESH } from './context.mjs';
import { groundTarget, resolvePick, showPick } from './ground.mjs';
import { dateWanted as dateOf, findDate, dateBefore } from './dates.mjs';
import { setSlider, sliderForFill, matchSlider, verifySliderApplied } from './sliders.mjs';
import { blockerQuestion, inOverlay, dismissOverlay } from './overlays.mjs';
import { pageNotes, askOnNotes, runOnNote, afterStep } from './notes.mjs';
import { watchClick, clickChanged, childTabs } from './click-outcome.mjs';
import { commitGuard } from './commit.mjs';
import { beforeClick } from './toggles.mjs';
import { recoverCoveredClick } from './covered.mjs';
import { searchState, searchMismatch, waitSuggestions, detectSiteBlock, modalDialogs } from './search-outcome.mjs';
import { pickFromList } from './select.mjs';
import { outcome, errorState, newNotices, urlChange } from './outcome.mjs';
import { JUDGED, judgment, settleJudgment, retryExtract, retryContent } from './judgments.mjs';

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
export async function perform(ctx, step, row, { extra = {}, stopIf, retryMs = STEP.RETRY, canSkip = step.optional, inNote = false, beforeInput, noInputRecovery = false, pregrounded } = {}) {
  const o = { extra, stopIf, retryMs, canSkip, inNote, beforeInput, noInputRecovery, pregrounded };
  let tries = 0;
  for (let pass = 0; pass < MAX_PASSES && tries < TRIES; pass++) {
    if (Date.now() >= ctx.deadline) return { stop: { reason: 'Run deadline reached' } };
    const r = await attempt(ctx, step, row, o);
    if (r === AGAIN) tries++;
    else if (r === AFRESH) tries = 0;
    else return r;
  }
  return { stop: { reason: 'Overlays kept appearing after dismissing them' } };
}

// One pass: a result, AGAIN or AFRESH.
async function attempt(ctx, step, row, o) {
  if (!['branch', 'if'].includes(step.action) && !ctx.executedRows.has(row)) {
    if (ctx.report.executed_leaves >= PLAN.MAX_LEAVES) return { stop: { reason: `Executed leaf limit ${PLAN.MAX_LEAVES} reached` } };
  }
  step = { ...step };
  for (const [key, ref] of [['value', step.valueRef], ['target', step.targetRef]]) {
    if (!ref) continue;
    const b = ctx.bindings.get(ref);
    if (!b) return { stop: { reason: `Missing binding $${ref}` } };
    if (['record', 'array'].includes(b.type)) return { stop: { reason: 'A record cannot be used as an input value' } };
    step[key] = String(b.value);
  }
  const { conn, tab } = ctx;
  const { canSkip, inNote } = o;
  if (canSkip && (!ctx.lastRow || /^nav\s/.test(ctx.lastRow.do)) && !row.optional_load_waited) {
    row.optional_load_waited = true;
    const state = await ops.evaluate(conn, tab, page('recent-load'));
    if (state.age < 3000 && !state.overlay) {
      const until = Math.min(Date.now() + 1500, ctx.deadline);
      while (Date.now() < until) {
        await sleep(Math.min(100, until - Date.now()));
        if ((await ops.evaluate(conn, tab, page('recent-load'))).overlay) break;
      }
      ctx.view = await ctx.look();
    }
  }
  // g: what grounding found so far: the snapshot, the element, Jev's question and pick.
  const g = { snap: null, el: null, tq: null, pick: null, ...o.pregrounded };
  // A date step, or a click that names a whole date: the day cell, paging months to it.
  const dateWanted = dateOf(step);
  if (dateWanted) {
    const d = await findDate(ctx, dateWanted);
    if (d.el) { g.el = d.el; row.how = d.how; }
    else if (step.action === 'date') { if (canSkip) { row.skipped = d.reason; return {}; } return { stop: { reason: d.reason } }; }
  }
  // A fill whose value is a number, on a slider of exactly that name, sets the slider.
  const sliderPlan = step.action === 'set' ? await matchSlider(ctx, step) : await sliderForFill(ctx, step);
  if (sliderPlan?.stop) return sliderPlan;
  const knownSlider = sliderPlan?.group && (!sliderPlan.unsure || sliderPlan.exact || sliderPlan.direct);
  if (!g.el && (TARGETED.has(step.action) || step.action === 'set') && !knownSlider) {
    const r = await groundTarget(ctx, step, row, g, o);
    if (r?.retryReveal) return AFRESH;
    if (r) return r;
  }

  // extract, pick and if: their question rides in this step's one Jev request.
  let j = null;
  if (JUDGED.has(step.action)) {
    j = await judgment(ctx, step);
    if (j.stop) { if (canSkip && !step.binding) { row.skipped = j.stop.reason; return {}; } return { stop: j.stop }; }
    o = { ...o, extra: { ...o.extra, ...(j.questions || { [j.key]: j.question }) } };
  }
  const asked = await askJev(ctx, step, row, g, o);
  if (asked === AGAIN) return AGAIN;
  if (asked.result) return asked.result;
  if (!['branch', 'if'].includes(step.action) && !ctx.executedRows.has(row)) {
    ctx.executedRows.add(row);
    ctx.report.executed_leaves++;
  }
  const { answers, watchBlocker } = asked;
  if (Date.now() >= ctx.deadline) return { stop: { reason: 'Run deadline reached' } };
  if (step.action === 'expect') {
    row.p = prob(answers.expect);
    return row.p >= 0.5 ? {} : { stop: { reason: `The page does not show: ${step.target} (p=${row.p.toFixed(2)})` } };
  }
  if (g.tq?.question && answers.target) {
    try { g.pick = jev.readTarget(answers.target, g.tq.cands); } catch (e) { return { stop: { reason: e.message } }; }
    if (ctx.showOn) await showPick(ctx, g);
  }
  if (watchBlocker && prob(answers.blocker) >= 0.5) {
    if (o.noInputRecovery) return { stop: { reason: 'A blocking overlay interrupted the action' } };
    const chosen = g.el || (g.pick?.p >= ctx.minP ? g.pick.pick : null);
    // The step works in the dialog itself (its OK, its stepper): nothing to dismiss.
    const inside = chosen ? await inOverlay(ctx, chosen, g.snap) : false;
    if (!inside) {
      const d = await dismissOverlay(ctx, row);
      if (d.stop) return d;
      return AGAIN; // re-ground on the cleared page
    }
  }

  if (j) {
    await retryExtract(ctx, step, row, j, answers);
    await retryContent(ctx, step, row, j, answers);
    const s = await settleJudgment(ctx, step, row, j, answers);
    if (s.result) return s.result;
    if (step.action !== 'if') return attempt(ctx, s.then, row, { ...o, extra: {} });
    const parent = ctx.bindings;
    ctx.bindings = new Map(parent);
    try { return await attempt(ctx, s.then, row, { ...o, extra: {} }); } finally { ctx.bindings = parent; }
  }

  // Steps with no element.
  if (ctx.showOn && ['key', 'type', 'scroll', 'nav'].includes(step.action)) {
    await show.act(conn, tab, { kind: step.action, label: step.action === 'key' ? `⌨ ${step.target === 'Enter' ? '⏎ Enter' : step.target}` : step.action === 'type' ? `type "${clip(step.target, 40)}"` : step.action === 'scroll' ? `scroll ${step.target}` : `go to ${clip(step.target, 60)}` });
  }
  if (Date.now() >= ctx.deadline) return { stop: { reason: 'Run deadline reached' } };
  if (step.action === 'key') {
    const errBefore = await errorState(ctx);
    if (Date.now() >= ctx.deadline) return { stop: { reason: 'Run deadline reached' } };
    if (step.target === 'Enter' && ctx.filledSearch) await waitSuggestions(ctx, ctx.filledSearch);
    await ops.key(conn, tab, step.target);
    return { acted: true, outcome: { errBefore } };
  }
  if (step.action === 'type') { await ops.type(conn, tab, step.target); return { acted: true }; }
  if (step.action === 'scroll') { await ops.scroll(conn, tab, { deltaY: /up/i.test(step.target) ? -700 : 700 }); return { acted: true }; }
  if (step.action === 'wait') {
    await sleep(Math.min(Number(step.target) || STEP.WAIT, STEP.WAIT_MAX, Math.max(0, ctx.deadline - Date.now())));
    return Date.now() >= ctx.deadline ? { stop: { reason: 'Run deadline reached' } } : { acted: true };
  }
  if (step.action === 'nav') {
    const timeoutMs = Math.max(1, Math.min(NAV.TIMEOUT, ctx.deadline - Date.now()));
    if (o.noInputRecovery) {
      await conn.send(tab, 'Page.navigate', { url: step.target }, timeoutMs);
      await ops.waitForReady(conn, tab, { timeoutMs: Math.max(1, Math.min(timeoutMs, ctx.deadline - Date.now())) });
    } else await ops.navigate(conn, tab, step.target, { timeoutMs });
    return { acted: true };
  }
  if (knownSlider || (sliderPlan && step.action !== 'set')) return setSlider(ctx, step, row, sliderPlan);

  if (!g.el) {
    const r = await resolvePick(ctx, step, row, g, o);
    if (r) return r; // AFRESH, or a result
  }
  if (Date.now() >= ctx.deadline) return { stop: { reason: 'Run deadline reached' } };
  if (step.action === 'set') {
    const pinned = g.el?.selector || await ctx.pin(g.el);
    if (!pinned) return { stop: { reason: 'The slider could not be pinned' } };
    if (Date.now() >= ctx.deadline) return { stop: { reason: 'Run deadline reached' } };
    return setSlider(ctx, { ...step, ref: null, item: null, selector: pinned }, row);
  }
  const { el, snap } = g;
  if (step.action === 'click') ctx.beforeControlNames = new Set(await ops.evaluate(conn, tab, page('control-names')));
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
  if (step.action === 'click' && ctx.filledSearch) {
    const selector = el.selector || await ctx.pin(el);
    row.searchSubmit = Boolean(el.submit) || (selector && await ops.evaluate(conn, tab, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return Boolean(el?.form && (el.type === 'submit' || el.type === 'image')); })()`).catch(() => false));
  }
  const optionSel = step.action === 'click' ? (toggle?.selector || disclosure?.selector || await ctx.pin(el)) : null;
  const selection = optionSel ? await ops.evaluate(conn, tab, page('option-state', { selector: optionSel, key: `option-${Date.now()}` })).catch(() => null) : null;
  const errBefore = ['click', 'date', 'select'].includes(step.action) ? await errorState(ctx) : null;
  const dateCheck = dateWanted && el.selector ? await dateBefore(ctx, el, dateWanted) : null;
  const click = async () => {
    const selector = optionSel || el.selector || await ctx.pin(el);
    const href = step.action === 'click' && selector ? await ops.evaluate(conn, tab, page('plan-link', { selector })) : null;
    if (!href) return ctx.clickSel({ ...t, strictDelivery: o.noInputRecovery });
    const point = await ops.pointFor(conn, tab, t);
    await ops.navigate(conn, tab, href, { timeoutMs: Math.max(1, Math.min(NAV.TIMEOUT, ctx.deadline - Date.now())) });
    row.how = `${row.how ? row.how + ', ' : ''}opened here instead of a new tab`;
    return point;
  };
  try {
    if (Date.now() >= ctx.deadline) return { stop: { reason: 'Run deadline reached' } };
    if (o.beforeInput) await o.beforeInput();
    if (step.action === 'click' || step.action === 'date') {
      const clicked = await ctx.timed('input', click());
      if (clicked.scrolledClear) row.how = `${row.how ? row.how + ', ' : ''}scrolled clear of the covering element; retried once`;
    }
    else if (step.action === 'hover') await ctx.timed('input', ops.hover(conn, tab, t));
    else if (step.action === 'fill') {
      await ctx.timed('input', ops.fill(conn, tab, { ...t, value: step.value, strictDelivery: o.noInputRecovery }));
      ctx.lastFilled = { ...el, selector: el.selector || await ctx.pin(el) };
      ctx.filledSearch = { selector: ctx.lastFilled.selector, value: step.value };
      ctx.searchBefore = await searchState(ctx);
    }
    else if (step.action === 'select') {
      try { await ops.selectOption(conn, tab, { ...t, label: step.value }); }
      catch (e) {
        if (e.code !== 'not_select') throw e;
        await pickFromList(ctx, step, row, el, t);
      }
    }
  } catch (e) {
    if (!o.noInputRecovery && e.code === 'covered' && await recoverCoveredClick(ctx, step, row, el, t)) {
      await ctx.timed('input', click());
    } else {
      // The page redrew the control between the read and the input (Airbnb rebuilds its
      // guest panel after each stepper click), or the last step's navigation landed after
      // the read (a results page, a cookie choice that reloads): nothing was sent, so find
      // it again once on the page as it is now.
      if (!o.noInputRecovery && ['detached', 'no_snapshot', 'navigated', 'stale', 'unknown_ref', 'frame_replaced'].includes(e.code) && !step.ref && !row.regrounded) {
        row.regrounded = true;
        await settle(conn, tab, 'reground');
        return AGAIN;
      }
      throw e;
    }
  }
  if (row.dismissed?.length && !/dismissed/.test(row.how || '')) row.how = `${row.how || ''}, dismissed ${row.dismissed.map(d => d.category).join(', ')} before retrying`;
  if (row.revealed) { row.how = `${row.how}, via note ${row.revealed}`; ctx.applied.set(row.revealed, ctx.applied.get(row.revealed) !== false); }
  if (row.closedOpen) row.how = `${row.how}, closed ${row.closedOpen} first`;
  if (row.autoRevealed) row.how = `${row.how}, opened "${clip(row.autoRevealed, 40)}" first: it was in that collapsed section`;
  return { acted: true, outcome: { toggle, disclosure, errBefore, dateCheck, selection: selection && { selector: optionSel, before: selection } } };
}

// The one Jev request a step makes: its target (when no exact match), the previous step's
// expected result, this step's expectation, a blocking overlay, on notes and the caller's
// extra questions. Hands off the previous expectation and runs an on note that matched.
// Returns { answers, watchBlocker }, { result }, or AGAIN after an on note.
export async function askJev(ctx, step, row, g, { extra, stopIf, inNote }) {
  const { view } = ctx;
  if (ctx.pending && !ctx.hasJevKey()) ctx.uncheckedExpectation();
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
    if (!(p >= 0.5)) return { result: { expectFailed: true, stop: { step: pending.row.step, reason: `Step ${pending.row.step} expected "${pending.expect}", but the page does not show it (p=${p.toFixed(2)})` } } };
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
  ctx.lastOpenedDialog = [];
  const dialogsBefore = await modalDialogs(ctx);
  const submitted = ctx.filledSearch && ((step.action === 'key' && step.target === 'Enter') || (step.action === 'click' && /^(search|submit|find|go)(?:\b|$)/i.test(step.target || '')));
  row.url_before = ctx.view.url;
  const filterBefore = step.action === 'set' ? await searchState(ctx) : null;
  let res;
  ctx.beforeControlNames = null;
  const clickWatch = step.action === 'click' ? await watchClick(ctx) : null;
  const tabsBefore = step.action === 'click' ? new Set((await conn.browser('Target.getTargets')).targetInfos.map(t => t.targetId)) : null;
  const guardEscape = step.action === 'key' && step.target === 'Escape';
  try {
    if (guardEscape) await ops.evaluate(conn, tab, page('dirty-dialogs', { capture: true }));
    res = await perform(ctx, step, row, performOpts);
    if (res.acted) {
      row.acted = true;
      if (ctx.showOn) await show.busy(conn, tab, true, 'waiting for the page to settle');
      // Search-as-you-type waits 250-500 ms after the last key before it fetches.
      const preset = SETTLE[['type', 'fill'].includes(step.action) ? 'typing' : 'step'];
      row.settle_ms = await ctx.timed('settle', settle(conn, tab, { ...preset, maxMs: Math.max(0, Math.min(preset.maxMs, ctx.deadline - Date.now())) }));
      row.settle_why = settle.why;
      if (guardEscape) {
        const closed = await ops.evaluate(conn, tab, page('dirty-dialogs'));
        for (const name of closed) (row.hints ||= []).push(`Escape closed the dialog "${name}"; staged edits were lost`);
      }
      const block = await detectSiteBlock(ctx);
      const why = block ? null : await meetChallenge(conn, tab, row, performOpts?.noInputRecovery ? { handoff: false, handoffMs: 0, stopOnChallenge: true } : ctx);
      if (block) res = { stop: block };
      if (why) res = { stop: { reason: why } };
      const before = ctx.view;
      ctx.view = await ctx.look();
      for (const t of newNotices(before, ctx.view, { navigation: step.action === 'nav' })) ctx.notice(row, t);
      ctx.previousNewControlNames = [];
      ctx.previousControlNames = null;
      if (ctx.beforeControlNames) {
        ctx.previousControlNames = ctx.beforeControlNames;
        const names = await ops.evaluate(conn, tab, page('control-names'));
        ctx.previousNewControlNames = names.filter(name => !ctx.beforeControlNames.has(name));
      }
      const dialogsAfter = await modalDialogs(ctx);
      ctx.lastOpenedDialog = dialogsAfter.filter(id => !dialogsBefore.includes(id));
      if (row.slider !== undefined) await verifySliderApplied(ctx, row);
      if (row.slider !== undefined && filterBefore) {
        const after = await searchState(ctx);
        if (!row.unchecked && filterBefore.hasResults && filterBefore.results && filterBefore.url === after.url && filterBefore.results === after.results) {
          row.unsure = true;
          row.unchecked = 'slider value changed, but neither the URL nor the results changed; check whether the filter applied';
        }
      }
      if (!res.stop && (submitted || row.searchSubmit)) {
        const mismatch = searchMismatch(ctx.filledSearch.value, ctx.searchBefore, await searchState(ctx));
        ctx.filledSearch = null;
        if (mismatch) { row.unsure = true; row.unchecked = mismatch; ctx.report.unsure = true; res = { stop: { reason: mismatch } }; }
      }
      if (!res.stop) { const bad = await outcome(ctx, res.outcome, row); if (bad) res = { stop: { reason: bad } }; }
    }
  } catch (e) {
    res = { stop: { reason: e.message, ...(e.code ? { code: e.code } : {}) } };
  }
  if (clickWatch) {
    const beforeChecked = res.outcome?.toggle?.before;
    const toggleChanged = typeof beforeChecked === 'boolean' && typeof row.checked === 'boolean' && row.checked !== beforeChecked;
    const changed = await clickChanged(ctx, clickWatch) || toggleChanged;
    if (!res.stop && step.expect && row.url_before === ctx.view.url && !changed) {
      row.unsure = true;
      row.unchecked = 'nothing changed after the click';
      row.expect_unchanged = true;
    }
    const opened = await childTabs(ctx, tabsBefore);
    if (opened.length) {
      row.opened_tabs = opened;
      row.how = `${row.how ? row.how + ', ' : ''}opened a new tab ${opened.join(', ')}`;
      if (performOpts?.laterSteps) {
        row.unsure = true;
        row.unchecked = `the click opened a new tab ${opened.join(', ')}; the rest of the plan ran here`;
      }
    }
  }
  if (!row.acted && !row.already && (TARGETED.has(step.action) || step.action === 'set') && (res.stop || row.skipped) && ctx.executedRows.has(row)) {
    ctx.executedRows.delete(row);
    ctx.report.executed_leaves--;
  }
  if (row.revealed && row.reveal_full && (res?.stop || row.autoRevealed)) ctx.applied.set(row.revealed, false);
  row.url_after = ctx.view.url;
  const change = urlChange(row.url_before, row.url_after);
  if (change) row.url_change = change;
  afterStep(ctx, row);
  row.ms = Date.now() - t0;
  if (!res.stop && !res.met && !row.skipped && step.expect && !row.expect_unchanged) {
    ctx.pending = { expect: step.expect, row };
    if (!ctx.hasJevKey()) ctx.uncheckedExpectation();
  }
  if (!row.skipped && !res.met) ctx.lastRow = row;
  return res;
}

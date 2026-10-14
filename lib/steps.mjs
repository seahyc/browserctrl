// Run a short plan of steps in one call: the agent plans, browserctrl finds each target
// (an exact name match first, else one Jev choice) and stops at the first step it cannot
// do with confidence, returning the page so the agent can re-plan.
//
// v2: a step may carry an expected result (`click Apply => "results are filtered"`). It is
// checked in the same Jev request that grounds the next step, together with "is an overlay
// blocking the page?", so expectations cost no extra round trip. Listed overlay kinds are
// dismissed, new notices are recorded, a step can repeat until a page condition holds,
// and every run is traced per tab.
import * as ops from './ops.mjs';
import * as jev from './jev.mjs';
import * as show from './show.mjs';
import { itemsExpression, formatItems } from './items.mjs';
import * as captcha from './captcha.mjs';
import * as cooldown from './cooldown.mjs';
import * as trace from './trace.mjs';

const ACTIONS = new Set(['click', 'fill', 'select', 'hover', 'key', 'scroll', 'nav', 'expect', 'wait']);
const TARGETED = new Set(['click', 'fill', 'select', 'hover']);
const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/s, '$2');

// The last `=>` outside quotes splits off the expected result. A quote opens only after a
// space, `=` or the start, so "Men's shoes" is not a quoted string.
function splitExpect(s) {
  let q = null, at = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if ((c === '"' || c === "'") && (i === 0 || /[\s=]/.test(s[i - 1]))) { q = c; continue; }
    if (c === '=' && s[i + 1] === '>') at = i;
  }
  if (at < 0) return { core: s };
  const expect = unquote(s.slice(at + 2));
  if (!expect) throw new Error(`"${s}": write the expected result after =>`);
  return { core: s.slice(0, at).trim(), expect };
}

// `click "More filters"`, `fill "the search box" = "aeron"`, `select Sort = Price`,
// `key Enter`, `scroll down`, `nav https://…`, `expect "results are filtered"`, `wait 1500`.
// Any step may start with `optional` and end with `=> "<expected result>"`.
export function parseStep(line) {
  let s = String(line).trim();
  const opt = s.match(/^optional\s+(.*)$/s);
  if (opt) s = opt[1];
  const { core, expect } = splitExpect(s);
  const extra = { ...(opt ? { optional: true } : {}), ...(expect ? { expect } : {}) };
  // `click! "Submit"` marks a step the plan means to commit (see the guard in perform).
  const m = core.match(/^(\w+)(!?)\s*(.*)$/s);
  if (!m || !ACTIONS.has(m[1])) throw new Error(`Unknown step "${line}". Steps: ${[...ACTIONS].join(', ')}`);
  const action = m[1];
  if (m[2] && !['click', 'select'].includes(action)) throw new Error(`"${line}": only click! and select! can commit`);
  if (m[2]) extra.commit = true;
  const rest = m[3].trim();
  if (action === 'fill' || action === 'select') {
    const eq = rest.match(/^(".*?"|'.*?'|[^=]+?)\s*=\s*(.*)$/s);
    if (!eq) throw new Error(`"${line}": write ${action} <target> = <value>`);
    return { action, target: unquote(eq[1]), value: unquote(eq[2]), ...extra };
  }
  if (['click', 'hover', 'expect'].includes(action) && !rest) throw new Error(`"${line}": name the ${action === 'expect' ? 'expected state' : 'element'}`);
  return { action, target: unquote(rest), ...extra };
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const prob = (a) => (a && typeof a.noul === 'number' ? Math.round(a.noul * 100) / 100 : NaN);
const noul = (instructions) => ({ type: 'noul', instructions });
const describeEl = (e) => `${e.role} "${clip(e.name, 60)}"`;

// An element whose name is exactly the target needs no model: "Apply", "More filters".
export function exactMatch(snap, step) {
  const want = norm(step.target);
  const hits = jev.candidatesFor(snap.elements, step.action).filter(e => norm(e.name) === want);
  return hits.length === 1 ? hits[0] : null;
}

// Wait until the DOM has been quiet for a moment, so the next step sees the result.
const SETTLE = (quietMs, maxMs) => `new Promise(resolve => {
  let last = Date.now(); const start = last;
  const mo = new MutationObserver(() => { last = Date.now(); });
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  // A filter or search usually fetches before it re-renders: new requests count as activity.
  let seen = performance.getEntriesByType('resource').length;
  const tick = () => {
    const n = performance.getEntriesByType('resource').length;
    if (n !== seen) { seen = n; last = Date.now(); }
    const now = Date.now();
    if (document.readyState === 'complete' && now - last >= ${quietMs} || now - start >= ${maxMs}) { mo.disconnect(); resolve(now - start); }
    else setTimeout(tick, 50);
  };
  tick();
})`;

// What is on screen (jev.VIEW_TEXT) plus short notices outside overlays: alerts, status and
// live regions, toasts and banners. Bounded: at most 20 notices of 200 characters.
const PAGE_STATE = `(() => {
  const v = ${jev.VIEW_TEXT};
  ${jev.IN_OVERLAY}
  const sel = '[role=alert],[role=status],[aria-live]:not([aria-live=off]),[class*=toast i],[class*=snackbar i],[class*=notice i],[class*=notification i],[class*=alert i],[class*=banner i],[class*=flash i]';
  const taken = [], notices = [];
  const nodes = document.querySelectorAll(sel);
  for (let i = 0; i < nodes.length && i < 300 && notices.length < 20; i++) {
    const el = nodes[i];
    if (taken.some(t => t.contains(el)) || el.closest('[data-cdp]')) continue;
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity || '1') < 0.05) continue;
    if (inOverlay(el)) continue;
    const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!t || t.length > 300) continue;
    taken.push(el);
    if (!notices.includes(t.slice(0, 200))) notices.push(t.slice(0, 200));
  }
  v.notices = notices;
  return v;
})()`;

// Inline messages a step can cause without any notice container.
const NOTICE_WORDS = /\b(out of stock|sold out|unavailable|no longer available|price (has )?changed|did you mean|showing results for|voucher|coupon|added to (cart|bag|basket)|only \d+ left|limited stock|something went wrong|try again|failed)\b/i;

function newNotices(before, after) {
  const had = new Set([...(before.notices || []), ...lines(before)]);
  const out = [];
  for (const t of after.notices || []) if (!had.has(t)) out.push(t);
  for (const l of lines(after)) if (!had.has(l) && l.length <= 200 && NOTICE_WORDS.test(l) && !out.some(o => o.includes(l) || l.includes(o))) out.push(l);
  return out.slice(0, 5);
}
const lines = (v) => `${v.overlay || ''}\n${v.view || ''}`.split('\n').map(s => s.trim()).filter(Boolean);

// Controls that are fine for closing an overlay. Anything that commits, signs up, installs
// or buys is never offered; links only when they read as "close" or "not now".
const DISMISS_UNSAFE = /\b(subscribe|sign ?up|register|join|upgrade|start (a |your )?(free )?trial|get (the )?app|open (in )?(the )?app|install|download|allow|enable|continue|buy|pay|order|add to (cart|bag|basket)|claim|redeem|shop now|learn more|settings|preferences|customi[sz]e|manage)\b/i;
const CLOSE_WORDS = /^(close|dismiss|no,? thanks|not now|maybe later|later|skip|×|✕|x)$/i;
const NOT_CLICKY = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'select', 'listbox', 'checkbox', 'radio', 'file', 'switch', 'option']);
const safeToDismiss = (e) => !e.disabled && !e.hidden && !NOT_CLICKY.has(e.role) && (e.name || '').trim() &&
  !jev.commits(e.name) && !DISMISS_UNSAFE.test(e.name) && (e.role !== 'link' || CLOSE_WORDS.test(e.name.trim()));

const blockerQuestion = (next) => noul(
  `Is a dialog, overlay or popup (for example a cookie banner, sign-up or newsletter prompt, app-install prompt) covering the page and blocking it? ` +
  `Answer no when the dialog or panel is what the next step${next ? ` ("${next}")` : ''} works in, and no for small toasts or banners that leave the page usable.`);
const expectQuestion = (what) => noul(`Does the page show this: ${what}?`);

// When a step finds nothing, say what is there instead: a hidden element with that name
// (often opened by another control) and the controls on screen, so the caller can
// re-plan from this report rather than probing the page.
async function whatIsThere(conn, tab, step) {
  const out = {};
  try {
    const all = await ops.readPage(conn, tab, { maxText: 0, max: 600, includeHidden: true });
    const want = norm(step.target).split(' ').filter(w => w.length > 2);
    const hidden = all.elements.filter(e => e.hidden && want.some(w => norm(e.name).includes(w))).slice(0, 5);
    if (hidden.length) out.hidden = hidden.map(e => `${e.role} "${(e.name || '').slice(0, 50)}" (hidden or zero-size)`);
    const shown = await ops.readPage(conn, tab, { maxText: 0, max: 400 });
    const roles = jev.candidatesFor(shown.elements, step.action === 'fill' ? 'fill' : 'click');
    const seen = new Set();
    out.controls = roles
      .map(e => `${e.role} "${(e.name || '').replace(/\s+/g, ' ').slice(0, 40)}"`)
      .filter(x => !x.endsWith('""') && !seen.has(x) && seen.add(x))
      .slice(0, 40);
  } catch {}
  return out;
}

// A click or Enter often starts a navigation a moment later; waiting on the old page's
// quiet DOM would hand the next step a page in transition. Give the navigation time to
// start, then wait for the current document to load and go quiet.
async function settle(conn, tab, { quietMs = 300, maxMs = 4000 } = {}) {
  const t0 = Date.now();
  await new Promise(r => setTimeout(r, 150));
  for (let i = 0; i < 3; i++) {
    await ops.waitForReady(conn, tab, { timeoutMs: 8000 }).catch(() => {});
    const ok = await ops.evaluate(conn, tab, SETTLE(quietMs, maxMs), { timeoutMs: maxMs + 3000 }).then(() => true, () => false);
    if (ok) break; // the document was replaced mid-wait otherwise: wait on the new one
  }
  return Date.now() - t0;
}

// A challenge that appears mid-plan goes to the human (bounded wait) instead of
// failing the plan; with handoff: false the plan stops there. Returns null to
// carry on, or the reason to stop.
async function meetChallenge(conn, tab, row, { handoff, handoffMs }) {
  const found = await captcha.detect(conn, tab).catch(() => null);
  if (!found) return null;
  try {
    row.challenge = await captcha.solve(conn, tab, { timeoutMs: handoffMs, handoff });
    return null;
  } catch (e) {
    row.challenge = { captcha: found.kind, cleared: false };
    return e.message;
  }
}

export function parseCategories(dismiss) {
  if (!dismiss || dismiss === true) return [];
  return (Array.isArray(dismiss) ? dismiss : String(dismiss).split(',')).map(s => String(s).trim()).filter(Boolean);
}

// Merge `items` reads across pages: ids reset on navigation and a re-rendered list can
// reuse nodes, so an item is the same when its link and text are.
// --show: the step list so far in the corner panel (lib/show.mjs).
async function hud(conn, tab, report, started, stopped) {
  const lines = report.steps.map(r => `${r.stopped ? '✗' : r.skipped ? '–' : '✓'} ${r.step}. ${clip(r.do, 60)}${r.how ? `  (${r.how})` : ''}  ${r.ms != null ? `${(r.ms / 1000).toFixed(1)}s` : ''}`);
  await show.panel(conn, tab, { title: `browserctrl do  ${((Date.now() - started) / 1000).toFixed(1)}s${stopped ? '  — stopped' : ''}`, lines });
}

// Pagination collects the list being paged: on each page, the largest content group.
function mergeItems(acc, r, page) {
  const g = (r.groups || []).filter(x => !x.chrome).sort((a, b) => b.count - a.count)[0];
  if (!g) return;
  let into = acc.groups[0];
  if (!into) acc.groups.push(into = { id: 'g1', region: g.region, heading: g.heading, label: g.label, items: [] });
  for (const it of g.items) {
    const k = `${(it.link || '').split('?')[0]}|${it.text}`;
    if (acc.seen.has(k)) { acc.duplicates++; continue; }
    acc.seen.add(k);
    into.items.push({ ...it, page });
  }
}

export async function runSteps(conn, tab, lines, opts = {}) {
  const {
    then, minP = 0.6, key: cfgIn, handoff = true, handoffMs = 300000, force = false,
    dismiss, repeat, until, max = 10, collect, jev: jevOpts = {}, traceRun = true, show: showOn = false,
  } = opts;
  const steps = lines.map(parseStep);
  const repeatStep = repeat ? parseStep(repeat) : null;
  if (repeatStep && !until) throw new Error('--repeat needs --until "<page condition>"');
  const categories = parseCategories(dismiss);
  // A plan that would navigate to a site that is cooling down is refused whole.
  for (const s of [...steps, repeatStep].filter(Boolean)) if (s.action === 'nav') cooldown.guard(s.target, { force, action: 'navigate to' });
  let cfg = cfgIn || jevOpts.cfg;
  const getCfg = () => (cfg ||= jev.jevKey());
  const fetchOpts = jevOpts.fetchImpl ? { fetchImpl: jevOpts.fetchImpl } : undefined;
  const report = { steps: [], events: [], ms: 0, jev_calls: 0 };
  const ask = async (state, questions) => {
    const r = await jev.systemOne(getCfg(), state, questions, fetchOpts);
    report.jev_calls++;
    return r;
  };
  const started = Date.now();
  const look = () => ops.evaluate(conn, tab, PAGE_STATE);
  // A background tab that does not render routes input by its last painted frame, so a
  // click can land on what used to be there. Keep it rendering without focusing it.
  await ops.wake(conn, tab).catch(() => {});
  if (showOn) await show.bringToFront(conn, tab); // --show: let the user watch
  let stopped = null;
  const opening = await meetChallenge(conn, tab, report, { handoff, handoffMs });
  if (opening) stopped = { step: 0, reason: opening };
  let view = await look();
  let pending = null; // the previous step's expected result, checked with the next request
  let lastRow = null; // the row that ran before the current one, for event attribution

  // A blocking overlay: dismiss it when its kind is listed, else stop with its text and
  // controls. One Jev request picks the kind and the closing control together.
  async function dismissOverlay(row) {
    const snap = await ops.readPage(conn, tab, { maxText: 0, max: 400 });
    const inside = new Set(await ops.evaluate(conn, tab, jev.OVERLAY_REFS).catch(() => []));
    const controls = snap.elements.filter(e => inside.has(e.ref) && !e.hidden);
    const safe = controls.filter(safeToDismiss);
    const text = clip(view.overlay, 400);
    const blocked = (reason, extra = {}) => ({
      reason, overlay: text, controls: controls.map(describeEl).slice(0, 15), ...extra,
    });
    if (!categories.length) return { stop: blocked('A dialog or popup is blocking the page; dismiss it (or pass --dismiss "<kinds>") and re-plan') };
    const criteria = Object.fromEntries(categories.map((c, i) => [`c${i + 1}`, c]));
    criteria.other = 'Something else: none of the listed kinds';
    const questions = { category: { type: 'choice', instructions: 'Which kind of overlay is covering the page?', criteria } };
    const cq = safe.length ? jev.targetQuestion({ elements: safe }, { intent: 'close or dismiss this overlay without agreeing to buy, subscribe, sign up or install anything', action: 'click' }) : null;
    if (cq?.question) questions.control = cq.question;
    let r;
    try { r = await ask({ page: jev.viewState(view), task: 'close a popup that blocks the page' }, questions); }
    catch (e) { return { stop: blocked(e.message) }; }
    const cat = r.answers.category;
    const kind = cat?.choice && cat.choice !== 'other' && cat.choice in criteria ? criteria[cat.choice] : null;
    const kindP = cat?.probabilities?.[cat?.choice];
    if (!kind || (kindP ?? 0) < 0.5) return { stop: blocked(`An overlay that is not one of the listed kinds (${categories.join(', ')}) is blocking the page`) };
    const pick = cq?.question ? jev.readTarget(r.answers.control, cq.cands) : { pick: null };
    if (!pick.pick || (pick.p ?? 0) < minP) return { stop: blocked(`A ${kind} is blocking the page and no safe control closes it`, { category: kind }) };
    await ops.click(conn, tab, { ref: pick.pick.ref, token: snap.token });
    await settle(conn, tab, { maxMs: 2500 });
    const ev = { type: 'dismissed', after_step: lastRow?.step ?? 0, category: kind, text: clip(text, 200), control: describeEl(pick.pick), p: pick.p };
    (row.dismissed ||= []).push(ev);
    report.events.push(ev);
    const before = view;
    view = await look();
    if (clip(view.overlay, 400) && clip(view.overlay, 400) === text) return { stop: blocked(`The ${kind} stayed after clicking ${describeEl(pick.pick)}`) };
    for (const t of newNotices(before, view)) { const n = { type: 'notice', after_step: row.step, text: t }; (row.events ||= []).push(n); report.events.push(n); }
    return {};
  }

  // Ground and do one step. `extra` questions ride along in the same request; `stopIf`
  // ends the step before acting (the loop's until condition).
  async function perform(step, row, { extra = {}, stopIf, retryMs = 2500, canSkip = step.optional } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let snap = null, el = null, tq = null;
      if (TARGETED.has(step.action)) {
        snap = await ops.readPage(conn, tab, { maxText: 0, max: 400 });
        el = exactMatch(snap, step);
        if (el) row.how = 'exact';
        else tq = jev.targetQuestion(snap, { intent: step.target, action: step.action });
      }
      const questions = { ...extra };
      if (tq?.question) questions.target = tq.question;
      if (pending) questions.prev_expect = expectQuestion(pending.expect);
      if (step.action === 'expect') questions.expect = expectQuestion(step.target);
      const watchBlocker = view.overlay?.trim() && !['nav', 'wait', 'expect'].includes(step.action);
      if (watchBlocker) questions.blocker = blockerQuestion(row.do);
      let answers = {};
      if (Object.keys(questions).length) {
        const essential = Object.keys(questions).some(k => k !== 'blocker');
        try {
          // On-screen text misses controls below the fold (a Next link at the page bottom),
          // so questions about what exists also see every control on the page.
          const controls = snap ? [...new Set(snap.elements.filter(e => e.name).map(e => `${e.role} "${e.name.slice(0, 40)}"`))].slice(0, 120) : undefined;
          const r = await ask({ page: jev.viewState(view), ...(controls ? { controls_on_page: controls } : {}), next_step: row.do, ...(TARGETED.has(step.action) ? { action: step.action, intent: step.target } : {}) }, questions);
          answers = r.answers;
          row.jev_ms = (row.jev_ms || 0) + r.ms;
        } catch (e) {
          if (essential) return { stop: { reason: e.message } };
        }
      }
      if (pending) {
        const p = prob(answers.prev_expect);
        pending.row.expect_p = p;
        if (!(p >= 0.5)) return { expectFailed: true, stop: { step: pending.row.step, reason: `Step ${pending.row.step} expected "${pending.expect}", but the page does not show it (p=${p})` } };
        pending = null;
      }
      if (stopIf?.(answers)) return { met: true };
      if (step.action === 'expect') {
        row.p = prob(answers.expect);
        return row.p >= 0.5 ? {} : { stop: { reason: `The page does not show: ${step.target} (p=${row.p})` } };
      }
      let pick = null;
      if (tq?.question && answers.target) {
        try { pick = jev.readTarget(answers.target, tq.cands); } catch (e) { return { stop: { reason: e.message } }; }
      }
      if (watchBlocker && prob(answers.blocker) >= 0.5) {
        const chosen = el || (pick?.p >= minP ? pick.pick : null);
        const inside = chosen ? (await ops.evaluate(conn, tab, jev.OVERLAY_REFS).catch(() => [])).includes(chosen.ref) : false;
        if (!inside) {
          const d = await dismissOverlay(row);
          if (d.stop) return d;
          continue; // re-ground on the cleared page
        }
      }
      if (step.action === 'key') { await ops.key(conn, tab, step.target); return { acted: true }; }
      if (step.action === 'scroll') { await ops.scroll(conn, tab, { deltaY: /up/i.test(step.target) ? -700 : 700 }); return { acted: true }; }
      if (step.action === 'wait') { await new Promise(r => setTimeout(r, Math.min(Number(step.target) || 1000, 10000))); return { acted: true }; }
      if (step.action === 'nav') { await ops.navigate(conn, tab, step.target, { timeoutMs: 30000 }); return { acted: true }; }
      if (!el) {
        if (!tq?.question) pick = { pick: null, ranked: [], reason: `No ${step.action}able elements on the page` };
        if (!pick.pick) {
          // Often the page is still rendering what the step needs: settle once more and retry.
          row.retried = true;
          await settle(conn, tab, { maxMs: retryMs });
          snap = await ops.readPage(conn, tab, { maxText: 0, max: 400 });
          el = exactMatch(snap, step);
          if (el) { row.how = 'exact'; pick = null; }
          else {
            view = await look();
            try { pick = await jev.pickTarget(getCfg(), snap, { intent: step.target, action: step.action, view }, fetchOpts); report.jev_calls++; }
            catch (e) { return { stop: { reason: e.message } }; }
          }
        }
        if (!el) {
          const why = jev.refusal(pick, minP);
          if (why) {
            const committing = pick.pick && jev.commits(pick.pick.name);
            if (committing && step.commit) return { stop: { reason: `A committing step needs the control's exact name; Jev guessed "${clip(pick.pick.name, 60)}". Re-plan with ${step.action}! "<its exact name>"`, candidates: (pick.ranked || []).filter(c => c.ref !== 'none') } };
            if (canSkip && !committing) { row.skipped = why; return {}; }
            return { stop: { reason: why, candidates: (pick.ranked || []).filter(c => c.ref !== 'none'), ...(await whatIsThere(conn, tab, step)) } };
          }
          el = pick.pick;
          row.how = `jev p=${pick.p}`;
        }
      }
      // A control that can commit (Buy, Send, Submit…) is clicked only when the plan marks
      // the step with ! and names it exactly; a Jev pick never commits.
      if (row.how === 'exact' && jev.commits(el.name)) {
        if (!step.commit) return { stop: { reason: `"${clip(el.name, 60)}" can commit something; to click it, mark the step: ${step.action}! "${clip(el.name, 60)}" (only after the user authorized it)` } };
        row.committed = true;
      }
      const t = { ref: el.ref, token: snap.token };
      row.target = describeEl(el);
      row.el = { role: el.role, name: clip(el.name, 80), ref: el.ref };
      if (showOn) await show.flash(conn, tab, el.ref);
      if (step.action === 'click') await ops.click(conn, tab, t);
      else if (step.action === 'hover') await ops.hover(conn, tab, t);
      else if (step.action === 'fill') await ops.fill(conn, tab, { ...t, value: step.value });
      else if (step.action === 'select') await ops.selectOption(conn, tab, { ...t, label: step.value });
      return { acted: true };
    }
    return { stop: { reason: 'Overlays kept appearing after dismissing them' } };
  }

  // Run one step with its bookkeeping: settle, challenge, notices, expectation hand-off.
  async function runOne(step, row, performOpts) {
    const t0 = Date.now();
    row.url_before = view.url;
    let res;
    try {
      res = await perform(step, row, performOpts);
      if (res.acted) {
        row.settle_ms = await settle(conn, tab);
        const why = await meetChallenge(conn, tab, row, { handoff, handoffMs });
        if (why) res = { stop: { reason: why } };
        const before = view;
        view = await look();
        for (const t of newNotices(before, view)) { const n = { type: 'notice', after_step: row.step, text: t }; (row.events ||= []).push(n); report.events.push(n); }
      }
    } catch (e) {
      res = { stop: { reason: e.message } };
    }
    row.url_after = view.url;
    row.ms = Date.now() - t0;
    if (!res.stop && !res.met && !row.skipped && step.expect) pending = { expect: step.expect, row };
    if (!row.skipped && !res.met) lastRow = row;
    return res;
  }

  for (const [i, step] of (stopped ? [] : steps.entries())) {
    const row = { step: i + 1, do: lines[i] };
    const res = await runOne(step, row);
    if (res.expectFailed) { stopped = res.stop; pending = null; break; } // the step itself never ran
    report.steps.push(row);
    if (res.stop) { stopped = { step: i + 1, ...res.stop }; row.stopped = true; }
    if (showOn) await hud(conn, tab, report, started, stopped);
    if (stopped) break;
  }

  // Repeat a step (usually "click Next") until the page condition holds, the step cannot
  // be done, or max is reached, collecting each page on the way.
  if (repeatStep && !stopped) {
    const loop = { pages: 0, ended: null };
    const acc = { groups: [], seen: new Set(), duplicates: 0 };
    const texts = [];
    const untilQ = expectQuestion(until);
    for (let k = 0; ; k++) {
      loop.pages++;
      if (collect === 'items') mergeItems(acc, await ops.evaluate(conn, tab, itemsExpression({ all: true, maxItems: 200, maxGroups: 12 })), loop.pages);
      else if (collect === 'text') texts.push(`--- page ${loop.pages}: ${view.url}\n${(view.view || '').slice(0, 6000)}`);
      if (k >= max) { loop.ended = `max ${max} repeats`; break; }
      const row = { step: `r${k + 1}`, do: repeat, repeat: k + 1 };
      const res = await runOne(repeatStep, row, { extra: { until: untilQ }, stopIf: a => prob(a.until) >= 0.5, retryMs: 1200, canSkip: true });
      if (res.expectFailed) { stopped = res.stop; break; }
      if (res.met) { loop.ended = `until: ${until}`; loop.pages_checked = k + 1; break; }
      report.steps.push(row);
      if (showOn) await hud(conn, tab, report, started, null);
      if (row.skipped) { loop.ended = `the step could not be done: ${row.skipped}`; break; }
      if (res.stop) {
        // Overlays, challenges and errors stop the plan; a missing Next button ends the loop.
        if (res.stop.overlay || row.challenge || !res.stop.candidates) { stopped = { step: row.step, ...res.stop }; row.stopped = true; }
        else loop.ended = `the step could not be done: ${res.stop.reason}`;
        break;
      }
    }
    report.loop = loop;
    if (collect === 'items') {
      report.collected = { pages: loop.pages, duplicates: acc.duplicates, groups: acc.groups.map(({ key, ...g }) => ({ ...g, count: g.items.length })) };
      loop.items = report.collected.groups.reduce((n, g) => n + g.count, 0);
    } else if (collect === 'text') report.collected = { pages: loop.pages, text: texts.join('\n\n').slice(0, 20000) };
  }

  // One last request: the last step's expected result, a blocking overlay, and the page
  // flags (a challenge or login wall after the plan is the most common reason a run
  // "worked" but shows nothing useful).
  if (!stopped) {
    const questions = {};
    for (const [id, q] of Object.entries(jev.CHECKS)) questions[id] = noul(q);
    if (pending) questions.prev_expect = expectQuestion(pending.expect);
    if (view.overlay?.trim()) questions.blocker = blockerQuestion();
    try {
      const r = await ask({ page: jev.viewState(view) }, questions);
      const checks = Object.fromEntries(Object.keys(jev.CHECKS).map(id => [id, prob(r.answers[id])]));
      const flags = Object.keys(jev.CHECKS).filter(id => checks[id] >= 0.5);
      if (flags.length) report.flags = flags;
      if (flags.includes('challenge')) report.cooldown = cooldown.record(view.url, { kind: 'challenge (Jev)' });
      if (pending) {
        const p = prob(r.answers.prev_expect);
        pending.row.expect_p = p;
        if (!(p >= 0.5)) stopped = { step: pending.row.step, reason: `Step ${pending.row.step} expected "${pending.expect}", but the page does not show it (p=${p})` };
        pending = null;
      }
      if (prob(r.answers.blocker) >= 0.5 && !stopped) {
        const row = { step: 'end', do: '(after the plan)' };
        const d = categories.length ? await dismissOverlay(row) : { stop: { overlay: clip(view.overlay, 400) } };
        if (row.dismissed) report.steps.push(row);
        if (d.stop) report.overlay = d.stop.overlay; // the plan is done; say what still covers the page
      }
    } catch (e) {
      if (pending) stopped = { step: pending.row.step, reason: e.message };
    }
  }

  report.ms = Date.now() - started;
  if (stopped) {
    report.stopped = stopped;
    const row = report.steps.find(s => s.step === stopped.step);
    if (row) row.stopped = true;
  }
  report.done = !stopped;
  view = await look().catch(() => view);
  report.page = { url: view.url, title: view.title };
  if (then === 'items') report.items = await ops.evaluate(conn, tab, itemsExpression({}));
  else if (then === 'text') report.text = `${view.overlay ? `${view.overlay}\n` : ''}${view.view}`.slice(0, 6000);
  if (traceRun) report.trace = writeTrace(tab, lines, steps, report, { repeat, until });
  return report;
}

function writeTrace(tab, lines, steps, report, { repeat, until }) {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const at = new Date().toISOString();
  const parsed = (row) => (typeof row.step === 'number' ? steps[row.step - 1] : row.repeat ? parseStep(repeat) : null);
  const records = report.steps.map(row => {
    const s = parsed(row);
    return {
      run, at, tab, step: row.step, do: row.do, action: s?.action,
      ...(row.el ? { target: row.el } : {}), ...(row.how ? { how: row.how } : {}),
      url_before: row.url_before, url_after: row.url_after,
      ...(s?.expect ? { expect: s.expect, expect_p: row.expect_p ?? null } : {}),
      ...(row.p !== undefined ? { expect: s?.target, expect_p: row.p } : {}),
      ...(row.dismissed ? { dismissed: row.dismissed.map(({ category, text, control }) => ({ category, text, control })) } : {}),
      ...(row.events ? { events: row.events.map(({ text }) => ({ text })) } : {}),
      ...(row.settle_ms != null ? { settle_ms: row.settle_ms } : {}),
      ...(row.skipped ? { skipped: row.skipped } : {}),
      ...(report.stopped && report.stopped.step === row.step ? { stop: report.stopped.reason } : {}),
      ms: row.ms,
    };
  });
  records.push({
    run, at, tab, kind: 'run', plan: lines, ...(repeat ? { repeat, until } : {}),
    done: report.done, ...(report.stopped ? { stopped: report.stopped.reason, stopped_step: report.stopped.step } : {}),
    ms: report.ms, jev_calls: report.jev_calls, events: report.events.length,
    ...(report.loop ? { loop: report.loop } : {}), url: report.page.url, ...(report.flags ? { flags: report.flags } : {}),
  });
  return trace.append(tab, records);
}

const met = c => c ? (c.solvedBy ? `  [${c.captcha} cleared by ${c.solvedBy}${c.waitedMs ? ` after ${Math.round(c.waitedMs / 1000)} s` : ''}]` : `  [${c.captcha} not cleared]`) : '';

export function formatEvents(events) {
  return events.map(e => e.type === 'dismissed'
    ? `  dismissed ${e.category} after step ${e.after_step}: "${clip(e.text, 80)}" → ${e.control}`
    : `  notice after step ${e.after_step}: "${clip(e.text, 120)}"`);
}

export function formatSteps(r) {
  const lines = r.challenge ? [`challenge before step 1:${met(r.challenge)}`] : [];
  for (const s of r.steps) {
    const mark = s.stopped ? '✗' : s.skipped ? '–' : '✓';
    const p = s.p !== undefined ? ` (p=${s.p})` : s.expect_p !== undefined ? ` (expected p=${s.expect_p})` : '';
    lines.push(`${mark} ${s.step}. ${s.do}${s.target ? `  → ${s.target}` : ''}${s.how ? ` (${s.how})` : ''}${p}${s.skipped ? `  skipped: ${s.skipped}` : ''}  ${s.ms ?? 0} ms${met(s.challenge)}`);
  }
  if (r.events?.length) lines.push('\nevents:', ...formatEvents(r.events));
  if (r.loop) lines.push(`\nrepeated over ${r.loop.pages} pages, ended by ${r.loop.ended}`);
  if (r.stopped) {
    lines.push(`\nStopped ${r.stopped.step ? `at step ${r.stopped.step}` : 'before step 1'}: ${r.stopped.reason}`);
    for (const c of r.stopped.candidates || []) lines.push(`  ${String(Math.round(c.p * 100)).padStart(3)}%  ${c.ref}${c.name ? ` ${c.role} "${c.name.slice(0, 60)}"` : ''}`);
    if (r.stopped.hidden) lines.push(`Present but hidden: ${r.stopped.hidden.join('; ')}`);
    if (r.stopped.overlay) lines.push(`Overlay: "${clip(r.stopped.overlay, 300)}"`);
    if (r.stopped.controls) lines.push(`${r.stopped.overlay ? 'Overlay controls' : 'On screen'}: ${r.stopped.controls.join(', ')}`);
  }
  if (r.overlay) lines.push(`\nStill covering the page: "${clip(r.overlay, 300)}"`);
  lines.push(`\n${r.page.title}\n${r.page.url}${r.flags ? `\nflags: ${r.flags.join(', ')}` : ''}${r.cooldown ? `\ncool-down: ${cooldown.describe(r.cooldown)}` : ''}   total ${r.ms} ms, ${r.jev_calls} Jev calls`);
  if (r.collected?.groups) {
    lines.push(`\ncollected ${r.collected.groups.reduce((n, g) => n + g.count, 0)} items over ${r.collected.pages} pages (${r.collected.duplicates} duplicates dropped)`);
    for (const g of r.collected.groups) {
      lines.push(`${g.id}  ${[g.region, g.heading && `"${g.heading}"`, g.label && `[${g.label}]`].filter(Boolean).join(' · ') || '(no region)'}  · ${g.count} items`);
      for (const it of g.items) lines.push(`  p${it.page} ${clip(it.text, 160) || '(no text)'}${it.link ? `  → ${it.link.slice(0, 80)}` : ''}`);
    }
  } else if (r.collected?.text) lines.push(`\n${r.collected.text}`);
  if (r.items) lines.push(`\n${formatItems(r.items)}`);
  if (r.text) lines.push(`\n${r.text}`);
  return lines.join('\n');
}

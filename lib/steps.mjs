// Run a short plan of steps in one call: the agent plans, browserctrl finds each target
// (an exact name match first, else one Jev choice) and stops at the first step it cannot
// do with confidence, returning the page so the agent can re-plan.
//
// v2: a step may carry an expected result (`click Apply => "results are filtered"`). It is
// checked in the same Jev request that grounds the next step, together with "is an overlay
// blocking the page?", so expectations cost no extra round trip. Listed overlay kinds are
// dismissed, new notices are recorded, a step can repeat until a page condition holds,
// and every run is traced per tab.
//
// Flow notes take part (lib/notes.mjs): the current page's notes ride along in each Jev
// request as context, a reveal note runs when a step's target cannot be found, an on note
// runs when Jev sees its situation, and a URL note that covers a planned click is suggested.
// Notes that ran are confirmed or contradicted at the end of the run.
//
// The parts live in lib/do: parsing (parse.mjs), the run's shared state (context.mjs),
// grounding (ground.mjs), the commit guard (commit.mjs), toggles and disclosures
// (toggles.mjs), overlays (overlays.mjs), dates (dates.mjs), sliders (sliders.mjs), custom
// selects (select.mjs), notes (notes.mjs), what a step did (outcome.mjs), one step
// (perform.mjs) and waiting (wait.mjs). This file runs the plan and formats its report.
import * as ops from './ops.mjs';
import * as jev from './jev.mjs';
import * as show from './show.mjs';
import { itemsExpression, formatItems, mainGroup } from './items.mjs';
import { visit, formatVisits } from './visit.mjs';
import * as prefetch from './prefetch.mjs';
import * as cooldown from './cooldown.mjs';
import * as finder from './find.mjs';
import * as trace from './trace.mjs';
import * as notes from './notes.mjs';
import { page } from './page/index.mjs';
import { QUIET, CONTENT, STEP, PLAN } from './timing.mjs';
import { parseStep } from './do/parse.mjs';
import { parsePlan, walkPlan } from './do/plan.mjs';
import { parseExtractValue } from './judge.mjs';
import { RunContext, clip, prob, noul, expectQuestion, pinKey } from './do/context.mjs';
import { waitForContent, meetChallenge } from './do/wait.mjs';
import { perform, runOne } from './do/perform.mjs';
import { blockerQuestion, dismissOverlay } from './do/overlays.mjs';
import { suggestUrlNotes, settleNotes } from './do/notes.mjs';

export { parseStep, looksLikeSelector, sliderValues } from './do/parse.mjs';
export { parseDateText, isoDate } from './page/shared.mjs';
export { exactMatch, sameWords, missingFromPick } from './do/ground.mjs';
export { newError, urlChange } from './do/outcome.mjs';
export { parseCategories } from './do/context.mjs';
export { settle, waitForContent } from './do/wait.mjs';

// The address parameters this page uses (lib/page/page-params.js), read from the page
// itself: a filter the page keeps in its address can then be set with one nav step.
export const PAGE_PARAMS = page('page-params');

// --show: the step list so far in the corner panel (lib/show.mjs).
async function hud(ctx, stopped) {
  const lines = ctx.report.steps.map(r => `${r.stopped ? '✗' : r.skipped ? '–' : r.unsure ? '⚠' : '✓'} ${r.step}. ${clip(r.do, 60)}${r.how ? `  (${r.how})` : ''}  ${r.ms != null ? `${(r.ms / 1000).toFixed(1)}s` : ''}`);
  await show.panel(ctx.conn, ctx.tab, { title: `browserctrl do  ${((Date.now() - ctx.started) / 1000).toFixed(1)}s${stopped ? '  — stopped' : ''}`, lines });
}

// Merge `items` reads across pages: ids reset on navigation and a re-rendered list can
// reuse nodes, so an item is the same when its link and text are. Pagination collects the
// list being paged: on each page, the largest content group.
function mergeItems(acc, r, pageNo) {
  const g = mainGroup(r);
  if (!g) return;
  let into = acc.groups[0];
  if (!into) acc.groups.push(into = { id: 'g1', region: g.region, heading: g.heading, label: g.label, items: [] });
  for (const it of g.items) {
    const k = `${(it.link || '').split('?')[0]}|${it.text}`;
    if (acc.seen.has(k)) { acc.duplicates++; continue; }
    acc.seen.add(k);
    into.items.push({ ...it, page: pageNo });
  }
}

export async function runSteps(conn, tab, lines, opts = {}) {
  const { then, force = false, repeat, until, max = 10, collect, traceRun = true, open: openN = 0, grep, context = 1, onStep } = opts;
  const steps = parsePlan(lines);
  const allSteps = walkPlan(steps);
  const repeatStep = repeat ? parseStep(repeat) : null;
  if (repeatStep && (!Number.isInteger(Number(max)) || Number(max) < 1)) throw new Error('step repeat, line 1, column 1: --max must be a positive integer');
  if (repeatStep && !until) throw new Error('--repeat needs --until "<page condition>"');
  const ctx = new RunContext(conn, tab, steps, opts);
  ctx.perform = (step, row, o) => perform(ctx, step, row, o);
  ctx.strictPlan = allSteps.some(s => s.action === 'branch' || s.action === 'answer' || s.binding);
  // A plan that would navigate to a site that is cooling down is refused whole.
  for (const s of [...allSteps, repeatStep].filter(Boolean)) if (s.action === 'nav') cooldown.guard(s.target, { force, action: 'navigate to' });
  const { report, showOn } = ctx;
  // A background tab that does not render routes input by its last painted frame, so a
  // click can land on what used to be there. Keep it rendering without focusing it.
  await ctx.timed('setup', (async () => {
    await ops.wake(conn, tab).catch(() => {});
    await ops.evaluate(conn, tab, page('net-watch', { longPoll: QUIET.LONG_POLL })).catch(() => {}); // so the first step's requests count
    await waitForContent(conn, tab, { timeoutMs: CONTENT.PLAN_WAIT, stable: false }); // a page still on its loading shell
  })());
  // The page as the plan found it, to report what the plan changed (opts.diff false skips it).
  const pageBefore = opts.diff === false ? null : await ctx.timed('diff', ops.evaluate(conn, tab, finder.PAGE_STATE_FOR_DIFF)).catch(() => null);
  // Refs name elements of the caller's last read; pin them before this plan reads the page.
  const refSteps = allSteps.filter(s => s.ref);
  if (refSteps.length) {
    for (const s of refSteps) s.pin = pinKey();
    const st = await ops.evaluate(conn, tab, page('pin-refs', { pins: refSteps.map(s => [s.ref, s.pin]), token: opts.refToken || null })).catch(() => []);
    refSteps.forEach((s, i) => { if (st?.[i] !== 'ok') s.pinError = st?.[i] || 'unknown'; });
  }

  if (showOn) await show.bringToFront(conn, tab); // --show: let the user watch
  let stopped = null;
  const opening = await meetChallenge(conn, tab, report, ctx);
  if (opening) stopped = { step: 0, reason: opening };
  ctx.view = await ctx.look();
  suggestUrlNotes(ctx);

  report.planned_leaves = allSteps.filter(s => !['branch', 'if'].includes(s.action)).length;
  report.executed_leaves = 0;
  if (!stopped) stopped = await runPlan(ctx, steps, { onStep });
  if (repeatStep && !stopped) stopped = await repeatUntil(ctx, repeatStep, { repeat, until, max, collect, onStep });
  if (!stopped) stopped = await lastCheck(ctx);
  else if (ctx.pending) {
    report.pending_check = { step: ctx.pending.row.step, expect: ctx.pending.expect };
  }
  settleNotes(ctx);
  await finish(ctx, stopped, pageBefore, { then, openN, grep, context });
  if (traceRun) report.trace = writeTrace(tab, lines, steps, report, { repeat, until });
  return report;
}

// A boundary consumes a pending check before local decisions or returned values.
async function drain(ctx) {
  return ctx.pending ? lastCheck(ctx) : null;
}

function operand(ctx, part) {
  if (!part.ref) return part;
  const binding = ctx.bindings.get(part.ref);
  if (!binding) throw new Error(`Missing binding $${part.ref}`);
  return binding;
}

function compare(ctx, comparison, row) {
  let left = operand(ctx, comparison.left), right = operand(ctx, comparison.right);
  if (left.type === 'date' && !comparison.right.ref && right.type === 'text') right = { ...right, type: 'date', value: parseExtractValue(right.value, { type: 'date' }) };
  if (right.type === 'date' && !comparison.left.ref && left.type === 'text') left = { ...left, type: 'date', value: parseExtractValue(left.value, { type: 'date' }) };
  const { op } = comparison;
  const literal = !comparison.left.ref || !comparison.right.ref;
  if (!literal && [left.currency, right.currency].some(c => ['dollar', 'JPY/CNY'].includes(c))) throw new Error('Comparison needs explicit currencies');
  if (left.type !== right.type || left.type === 'record' || (!literal && (left.currency !== right.currency || left.unit !== right.unit))) throw new Error('Comparison needs compatible types and currencies');
  if (!['==', '!='].includes(op) && !['number', 'date'].includes(left.type)) throw new Error('Ordering requires typed numbers or dates');
  const a = left.value, b = right.value;
  const result = op === '==' ? a === b : op === '!=' ? a !== b : op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
  row.comparison = { left, right, op, result };
  return result;
}

function render(ctx, template, sources) {
  return template.replace(/(\\)?\$\{([A-Za-z_]\w*)\}/g, (all, escape, name) => {
    if (escape) return '${' + name + '}';
    const b = ctx.bindings.get(name);
    if (!b) throw new Error(`Missing binding $${name}`);
    sources.push({ name, ...b });
    return typeof b.value === 'object' ? JSON.stringify(b.value) : String(b.value);
  });
}

async function runPlan(ctx, nodes, { onStep }) {
  for (const node of nodes) {
    const stepId = /^\d+$/.test(node.path) ? Number(node.path) : node.path;
    const row = { step: stepId, path: node.path, do: node.source };
    if (Date.now() >= ctx.deadline) return { step: stepId, reason: 'Run deadline reached' };
    let res = {};
    try {
      if (node.action === 'branch') {
        if (node.comparison) {
          const stopped = await drain(ctx);
          if (stopped) return stopped;
          row.branch = compare(ctx, node.comparison, row) ? 'then' : 'else';
          row.skipped_branch = row.branch === 'then' ? 'else' : 'then';
        } else res = await runOne(ctx, node, row);
      } else {
        if (node.action === 'answer') {
          if (ctx.report.executed_leaves >= PLAN.MAX_LEAVES) return { step: stepId, reason: `Executed leaf limit ${PLAN.MAX_LEAVES} reached` };
          const stopped = await drain(ctx);
          if (stopped) return stopped;
          const sources = [];
          ctx.report.answer = row.answer = render(ctx, node.target, sources);
          ctx.report.answer_sources = sources;
          ctx.report.executed_leaves++;
        } else {
          res = await runOne(ctx, node, row);
        }
      }
    } catch (e) { res = { stop: { reason: e.message } }; }
    if (res.expectFailed) { ctx.pending = null; return res.stop; }
    if (res.stop) row.stopped = true;
    ctx.report.steps.push(row);
    if (onStep) await onStep(row).catch(() => {});
    if (ctx.showOn) await hud(ctx, res.stop);
    if (res.stop) return { step: stepId, ...res.stop };
    if (node.action === 'branch') {
      const parent = ctx.bindings;
      ctx.bindings = new Map(parent);
      let stopped;
      try {
        stopped = await runPlan(ctx, node[row.branch], { onStep });
        if (!stopped) stopped = await drain(ctx);
      } finally { ctx.bindings = parent; }
      if (stopped) return stopped;
    }
  }
  return null;
}

// Repeat a step (usually "click Next") until the page condition holds, the step cannot
// be done, or max is reached, collecting each page on the way. Returns a stop, or null.
async function repeatUntil(ctx, repeatStep, { repeat, until, max, collect, onStep }) {
  const { conn, tab, report } = ctx;
  let stopped = null;
  const loop = { pages: 0, ended: null };
  const acc = { groups: [], seen: new Set(), duplicates: 0 };
  const texts = [];
  const untilQ = expectQuestion(until);
  for (let k = 0; ; k++) {
    loop.pages++;
    if (collect === 'items') mergeItems(acc, await ops.evaluate(conn, tab, itemsExpression({ all: true, maxItems: 200, maxGroups: 12 })), loop.pages);
    else if (collect === 'text') texts.push(`--- page ${loop.pages}: ${ctx.view.url}\n${(ctx.view.view || '').slice(0, 6000)}`);
    if (k >= max) { loop.ended = `max ${max} repeats`; break; }
    const row = { step: `r${k + 1}`, do: repeat, repeat: k + 1 };
    const res = await runOne(ctx, repeatStep, row, { extra: { until: untilQ }, stopIf: a => prob(a.until) >= 0.5, retryMs: STEP.RETRY_REPEAT, canSkip: true });
    if (res.expectFailed) { stopped = res.stop; break; }
    if (res.met) { loop.ended = `until: ${until}`; loop.pages_checked = k + 1; break; }
    report.steps.push(row);
    if (onStep) await onStep(row).catch(() => {});
    if (ctx.showOn) await hud(ctx, null);
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
  return stopped;
}

// One last request: the last step's expected result, a blocking overlay, and the page
// flags (a challenge or login wall after the plan is the most common reason a run
// "worked" but shows nothing useful). Returns a stop, or null.
async function lastCheck(ctx) {
  const { report, view } = ctx;
  let stopped = null;
  const questions = {};
  for (const [id, q] of Object.entries(jev.CHECKS)) questions[id] = noul(q);
  if (ctx.pending) questions.prev_expect = expectQuestion(ctx.pending.expect);
  if (view.overlay?.trim()) questions.blocker = blockerQuestion();
  try {
    const r = await ctx.ask({ page: jev.viewState(view) }, questions);
    const checks = Object.fromEntries(Object.keys(jev.CHECKS).map(id => [id, prob(r.answers[id])]));
    const flags = Object.keys(jev.CHECKS).filter(id => checks[id] >= 0.5);
    if (flags.length) {
      report.flags = flags;
      if (ctx.strictPlan) stopped = { step: 'end', reason: `Final page check: ${flags.join(', ')}` };
    }
    if (flags.includes('challenge')) report.cooldown = cooldown.record(view.url, { kind: 'challenge (Jev)' });
    const { pending } = ctx;
    if (pending) {
      const p = prob(r.answers.prev_expect);
      pending.row.expect_p = p;
      if (!(p >= 0.5)) stopped = { step: pending.row.step, reason: `Step ${pending.row.step} expected "${pending.expect}", but the page does not show it (p=${p.toFixed(2)})` };
      ctx.pending = null;
    }
    if (prob(r.answers.blocker) >= 0.5 && !stopped) {
      const row = { step: 'end', do: '(after the plan)' };
      const d = ctx.categories.length ? await dismissOverlay(ctx, row) : { stop: { overlay: clip(view.overlay, 400) } };
      if (row.dismissed) report.steps.push(row);
      if (d.stop) {
        report.overlay = d.stop.overlay;
        if (ctx.strictPlan) stopped ||= { step: 'end', reason: 'A blocking overlay remains after the plan' };
      }
    }
  } catch (e) {
    if (ctx.pending || report.answer !== undefined) stopped = { step: ctx.pending?.row.step || 'end', reason: e.message };
  }
  if (!stopped && Date.now() >= ctx.deadline) stopped = { step: 'end', reason: 'Run deadline reached' };
  return stopped;
}

// The report's ending: the stop, the page now, what the plan changed, the address
// parameters, and --then items or text (with --open, the first items opened).
async function finish(ctx, stopped, pageBefore, { then, openN, grep, context }) {
  const { conn, tab, report, opts, showOn } = ctx;
  report.ms = Date.now() - ctx.started;
  report.current_tab = tab;
  report.settle_ms = ctx.phases.settle || 0;
  if (stopped) {
    report.stopped = { ...stopped, path: String(stopped.step) };
    report.stop_path = String(stopped.step);
    const row = report.steps.find(s => s.step === stopped.step);
    if (row) row.stopped = true;
  }
  report.done = !stopped;
  if (report.answer !== undefined && stopped) report.answer_provisional = true;
  // A stop that lists refs (candidates, twins) names them from this plan's own snapshot: the
  // caller's next ref means that snapshot from now on.
  if (stopped && (stopped.candidates?.length || /\bref_\d+/.test(stopped.reason || ''))) report.refsToken = await ops.evaluate(conn, tab, 'window.__cdp && window.__cdp.token').catch(() => null);
  ctx.view = await ctx.look().catch(() => ctx.view);
  const { view } = ctx;
  report.page = { url: view.url, title: view.title };
  if (pageBefore) report.changes = finder.diffPage(pageBefore, await ctx.timed('diff', ops.evaluate(conn, tab, finder.PAGE_STATE_FOR_DIFF)).catch(() => null));
  report.params = await ctx.timed('read', ops.evaluate(conn, tab, PAGE_PARAMS)).catch(() => []);
  if (then === 'items' || openN) report.items = await ctx.timed('then', ops.evaluate(conn, tab, itemsExpression({})));
  // A plan that ends with its results out of view (scrolled to the foot of a filter sidebar,
  // or back to the top above a tall header): bring the main list's first item into view, so
  // the page shows the results the report lists, as a person checking them would.
  if (report.items && !stopped) {
    const main = mainGroup(report.items);
    if (main?.items?.length && main.items.every(it => it.below || it.above)) {
      const moved = await ops.evaluate(conn, tab, page('scroll-to-item', { id: main.items[0].id })).catch(() => false);
      if (moved) {
        report.scrolled = main.heading ? `"${clip(main.heading, 50)}"` : 'the results';
        report.items = await ctx.timed('then', ops.evaluate(conn, tab, itemsExpression({}))).catch(() => report.items);
      }
    }
  }
  // --open N: open the first N items of the main list (not ads) and return what --grep finds
  // on each, so a list and its drill-down take one call.
  if (openN && report.items) {
    const links = mainLinks(report.items, Number(openN), view.url);
    if (links.length) report.opened = await ctx.timed('open', visit(conn, links, { grep, context, show: showOn }));
  } else if (report.items && opts.prefetch !== false) {
    // The agent often opens the first items next: start loading them while it decides.
    report.prefetched = await ctx.timed('prefetch', prefetch.start(conn, mainLinks(report.items, 3, view.url))).catch(() => []);
  }
  else if (then === 'text') report.text = `${view.overlay ? `${view.overlay}\n` : ''}${view.view}`.slice(0, 6000);
  if (showOn) await show.busy(conn, tab, false);
}

function writeTrace(tab, lines, steps, report, { repeat, until }) {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const at = new Date().toISOString();
  const parsed = (row) => walkPlan(steps).find(s => s.path === String(row.step)) || (row.repeat ? parseStep(repeat) : null);
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
      ...(row.settle_ms != null ? { settle_ms: row.settle_ms, settle_why: row.settle_why } : {}),
      ...(row.skipped ? { skipped: row.skipped } : {}),
      ...(row.unsure ? { unsure: true } : {}), ...(row.checked !== undefined ? { checked: row.checked } : {}), ...(row.expanded !== undefined ? { expanded: row.expanded } : {}), ...(row.error ? { error: row.error } : {}),
      ...(row.vision ? { vision: row.vision } : {}),
      ...(row.via_notes ? { via_notes: row.via_notes } : {}),
      ...(report.stopped && report.stopped.step === row.step ? { stop: report.stopped.reason } : {}),
      ms: row.ms,
    };
  });
  records.push({
    run, at, tab, kind: 'run', plan: lines, ...(repeat ? { repeat, until } : {}), phases: report.phases,
    done: report.done, ...(report.stopped ? { stopped: report.stopped.reason, stopped_step: report.stopped.step } : {}),
    ms: report.ms, jev_calls: report.jev_calls, events: report.events.length,
    ...(report.loop ? { loop: report.loop } : {}), url: report.page.url, ...(report.flags ? { flags: report.flags } : {}),
  });
  notes.learn(records);
  return trace.append(tab, records);
}

const met = c => c ? (c.solvedBy ? `  [${c.captcha} cleared by ${c.solvedBy}${c.waitedMs ? ` after ${Math.round(c.waitedMs / 1000)} s` : ''}]` : `  [${c.captcha} not cleared]`) : '';

export function formatEvents(events) {
  return events.map(e => e.type === 'note'
    ? `  note ${e.id} (${e.kind}) after step ${e.after_step}: "${clip(e.text, 80)}" ${e.ok ? 'handled' : 'failed'}`
    : e.type === 'dismissed'
    ? `  dismissed ${e.category} after step ${e.after_step}: "${clip(e.text, 80)}" → ${e.control}`
    : `  notice after step ${e.after_step}: "${clip(e.text, 120)}"`);
}

// The main list (mainGroup); badges such as Ad, Sponsored or Spotlight (in the text or
// class hints) mark items that are not part of it.
const AD = /(^|[\s·{,_-])(ad|ads|sponsored|promoted|spotlight|anzeige|werbung|gesponsert|annonce|sponsorisé|anuncio|patrocinado|annuncio|sponsorizzato|advertentie|gesponsord|реклама|iklan|quảng cáo|广告|赞助|広告|スポンサー|광고)([\s·},_-]|$)/iu;
export function mainLinks(items, n, base) {
  const g = mainGroup(items);
  if (!g) return [];
  const out = [];
  for (const it of g.items) {
    if (out.length >= n) break;
    if (!it.link || AD.test(it.text || '') || (it.hints || []).some(h => AD.test(` ${h} `))) continue;
    try { const u = new URL(it.link, base).href; if (!out.includes(u)) out.push(u); } catch {}
  }
  return out;
}

export function formatParams(params) {
  return params.map(p => `${p.name}${p.values.length ? ` (${p.values.join(', ')})` : ''}${p.from.includes('form') ? ' [form]' : ''}`).join(' · ');
}

export function formatSteps(r) {
  const lines = r.challenge ? [`challenge before step 1:${met(r.challenge)}`] : [];
  if (r.answer !== undefined) lines.push(`answer: ${r.answer}${r.answer_provisional ? ' (provisional)' : ''}`);
  for (const b of r.bindings || []) lines.push(`binding $${b.name}: ${JSON.stringify(b.value)} from ${JSON.stringify(b.raw)} (p=${b.p.toFixed(2)}, step ${b.step})`);
  for (const s of r.steps) {
    const mark = s.stopped ? '✗' : s.skipped ? '–' : s.unsure ? '⚠' : '✓';
    const p = s.p !== undefined ? ` (p=${s.p.toFixed(2)})` : s.expect_p !== undefined ? ` (expected p=${s.expect_p.toFixed(2)})` : '';
    lines.push(`${mark} ${s.step}. ${s.do}${s.target ? `  → ${s.target}` : ''}${s.how ? ` (${s.how})` : ''}${p}${s.unsure ? '  unsure: check the page' : ''}${s.checked !== undefined ? (s.already ? `  already ${s.pressed_kind ? 'pressed' : 'checked'}` : `  now ${s.pressed_kind ? (s.checked ? 'pressed' : 'not pressed') : s.checked ? 'checked' : 'unchecked'}`) : ''}${s.slider !== undefined ? `  now ${s.slider}` : ''}${s.expanded !== undefined ? `  ${s.already && s.checked === undefined ? 'already' : 'now'} ${s.expanded ? 'open' : 'closed'}` : ''}${s.skipped ? `  skipped: ${s.skipped}` : ''}  ${s.ms ?? 0} ms${met(s.challenge)}${s.url_change ? `\n     url: ${s.url_change}` : ''}`);
    if (s.branch) lines.push(`     branch: ${s.branch}; skipped: ${s.skipped_branch}`);
    // A reveal step that could not run was skipped (the page was already past it).
    for (const v of s.via_notes || []) lines.push(`     ${v.ok || (v.kind === 'reveal' && s.how?.includes(`via note ${v.id}`)) ? 'via' : 'tried'} note ${v.id} (${v.kind}): ${(s.note_steps || []).map(n => `${n.do}${n.stopped ? (v.kind === 'reveal' ? ' (skipped)' : ' ✗') : ''}`).join(' → ')}`);
    for (const h of s.hints || []) lines.push(`     hint: ${h}`);
    if (s.extract_verify) lines.push(`     extract verify p=${Number(s.extract_verify.p).toFixed(2)} (${s.extract_verify.ms} ms)`);
    if (s.content_wait_ms !== undefined) lines.push(`     waited ${s.content_wait_ms} ms for the page to fill in`);
    if (s.extracted?.source_attribute) lines.push(`     source attribute: ${s.extracted.source_attribute}`);
    if (s.extract_second_pass) lines.push('     extraction second pass over omitted lines');
    if (s.extracted?.value != null) lines.push(`     = ${JSON.stringify(s.extracted.value)}${s.extracted.members ? ` (group p=${s.extracted.p.toFixed(2)}; ${s.extracted.members.map(m => `${JSON.stringify(m.value)} p=${m.p.toFixed(2)}`).join('; ')})` : ''}${(s.extracted.alternatives || []).map(a => `  or ${JSON.stringify(a.value)} (p=${a.p.toFixed(2)})`).join('')}`);
    if (s.picked) lines.push(`     picked ${s.picked.id} "${s.picked.text}"${(s.picked.runnersUp || []).map(c => `  next: ${c.id} "${c.text}" (p=${c.p.toFixed(2)})`).join('')}`);
  }
  // The answers a plan extracted, together, so the caller can answer from them.
  if (r.extracted?.length) lines.push('\nextracted:', ...r.extracted.map(e => `  ${e.what}: ${e.value == null ? '(no line on the page answers this)' : JSON.stringify(e.value)}${e.value != null && e.p < 0.75 ? `  ⚠ p=${e.p.toFixed(2)}` : ''}`));
  for (const sg of r.suggestions || []) lines.push(`note ${sg.id}: ${sg.text}`);
  if (r.notes_applied?.length) lines.push(`notes: ${r.notes_applied.map(n => `${n.id} ${n.ok ? 'confirmed' : 'contradicted'}`).join(', ')}`);
  if (r.events?.length) lines.push('\nevents:', ...formatEvents(r.events));
  if (r.loop) lines.push(`\nrepeated over ${r.loop.pages} pages, ended by ${r.loop.ended}`);
  if (r.stopped) {
    lines.push(`\nStopped ${r.stopped.step ? `at step ${r.stopped.step}` : 'before step 1'}: ${r.stopped.reason}`);
    for (const c of r.stopped.candidates || []) lines.push(`  ${String(Math.round(c.p * 100)).padStart(3)}%  ${c.ref}${c.name ? ` ${c.role} "${c.name.slice(0, 60)}"` : ''}`);
    if (r.stopped.hidden) lines.push(`Present but hidden: ${r.stopped.hidden.join('; ')}`);
    if (r.stopped.covered) lines.push(`Covered: ${r.stopped.covered}`);
    if (r.stopped.onTop) lines.push(`On top: ${r.stopped.onTop}`);
    if (r.stopped.overlay) lines.push(`Overlay: "${clip(r.stopped.overlay, 300)}"`);
    if (r.stopped.controls) lines.push(`${r.stopped.overlay ? 'Overlay controls' : 'On screen'}: ${r.stopped.controls.join(', ')}`);
  }
  if (r.changes) lines.push(`\n${finder.formatDiff(r.changes)}`);
  if (r.overlay) lines.push(`\nStill covering the page: "${clip(r.overlay, 300)}"`);
  if (r.params?.length) lines.push(`\nurl params (set them with a nav step): ${formatParams(r.params)}`);
  lines.push(`\n${r.page.title}\n${r.page.url}${r.flags ? `\nflags: ${r.flags.join(', ')}` : ''}${r.cooldown ? `\ncool-down: ${cooldown.describe(r.cooldown)}` : ''}   total ${r.ms} ms, ${r.jev_calls} Jev calls${r.executed_leaves !== undefined ? `, ${r.executed_leaves}/${r.planned_leaves} planned leaves executed` : ''}`);
  if (r.collected?.groups) {
    lines.push(`\ncollected ${r.collected.groups.reduce((n, g) => n + g.count, 0)} items over ${r.collected.pages} pages (${r.collected.duplicates} duplicates dropped)`);
    for (const g of r.collected.groups) {
      lines.push(`${g.id}  ${[g.region, g.heading && `"${g.heading}"`, g.label && `[${g.label}]`].filter(Boolean).join(' · ') || '(no region)'}  · ${g.count} items`);
      for (const it of g.items) lines.push(`  p${it.page} ${clip(it.text, 160) || '(no text)'}${it.link ? `  → ${it.link.slice(0, 80)}` : ''}`);
    }
  } else if (r.collected?.text) lines.push(`\n${r.collected.text}`);
  if (r.scrolled) lines.push(`\nscrolled the results into view (${r.scrolled})`);
  if (r.items) lines.push(`\n${formatItems(r.items, { main: true })}`);
  if (r.opened) lines.push(`\nopened ${r.opened.length}:\n${formatVisits(r.opened)}`);
  if (r.text) lines.push(`\n${r.text}`);
  return lines.join('\n');
}

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
import { saysCommit } from './commit.mjs';
import * as jev from './jev.mjs';
import * as show from './show.mjs';
import { detectSiteBlock } from './do/search-outcome.mjs';
import { itemsExpression, formatItems, mainGroup } from './items.mjs';
import { collector, PAGE_SIGNATURE, COLLECT_MODES } from './collect.mjs';
import { visit, formatVisits } from './visit.mjs';
import * as prefetch from './prefetch.mjs';
import * as cooldown from './cooldown.mjs';
import * as finder from './find.mjs';
import * as trace from './trace.mjs';
import * as rec from './rec.mjs';
import { stepRecordingOptions } from './step-recording.mjs';
import { openOwnedTab, closeOwnedTab, stopOwnedRecordings } from './do/owned-tabs.mjs';
import * as notes from './notes.mjs';
import { page } from './page/index.mjs';
import { QUIET, CONTENT, STEP, PLAN, sleep } from './timing.mjs';
import { parseStep, TARGETED } from './do/parse.mjs';
import { exactMatch } from './do/ground.mjs';
import { parsePlan, walkPlan } from './do/plan.mjs';
import { parseExtractValue, membershipQuestion } from './judge.mjs';
import { RunContext, clip, prob, noul, expectQuestion, pinKey, AGAIN } from './do/context.mjs';
import { waitForContent, meetChallenge } from './do/wait.mjs';
import { freezeList, rankedPick } from './do/listing.mjs';
import { remainingSteps, replacements } from './do/resume.mjs';
import { ranking } from './do/rank-lines.mjs';
import { candidateSearch } from './do/try.mjs';
import { samePage } from './do/same-page.mjs';
import { judgment, settleJudgment } from './do/judgments.mjs';
import { perform, runOne, askJev } from './do/perform.mjs';
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

// Why a step needs Jev whatever the page shows, or null.
function needsJev(s) {
  if (s.action === 'extract') return 'extract reads the page with Jev';
  if (s.action === 'pick') return 'pick chooses an item with Jev';
  if (s.action === 'expect') return 'expect checks the page with Jev';
  if (s.action === 'if' || (s.action === 'branch' && !s.comparison)) return 'a page condition is judged by Jev';
  if (s.action === 'loop' && s.mode === 'each') return 'each judges every item with Jev';
  if (s.action === 'try') return 'try judges each attempt with Jev';
  if (s.action === 'rankedPick') {
    try { if (ranking(s.target).type === 'order') return null; } catch { return null; }
    return 'a ranked pick asks Jev which items qualify';
  }
  return null;
}

export async function runSteps(conn, tab, lines, opts = {}) {
  const { then, force = false, repeat, until, max = 10, collect, traceRun = true, open: openN = 0, grep, context = 1, onStep: callerOnStep } = opts;
  const onStep = callerOnStep || (row => rec.still(conn, row.tab || tab, `do: ${row.do}`, stepRecordingOptions(row)));
  const steps = parsePlan(lines);
  const allSteps = walkPlan(steps);
  const repeatStep = repeat ? parseStep(repeat) : null;
  if (repeatStep && (!Number.isInteger(Number(max)) || Number(max) < 1 || Number(max) > MAX_REPEATS)) throw new Error(`step repeat, line 1, column 1: --max must be a whole number from 1 to ${MAX_REPEATS}`);
  if (repeatStep && collect && !COLLECT_MODES.includes(collect)) throw new Error(`--collect must be one of: ${COLLECT_MODES.join(', ')}`);
  const ctx = new RunContext(conn, tab, steps, opts);
  ctx.perform = (step, row, o) => perform(ctx, step, row, o);
  ctx.strictChecks = allSteps.some(s => ['loop', 'rankedPick', 'try'].includes(s.action) || (s.action === 'samePage' && ctx.hasJevKey()));
  ctx.strictPlan = allSteps.some(s => ['branch', 'answer', 'loop', 'rankedPick', 'try', 'samePage'].includes(s.action) || s.binding);
  // A plan that would navigate to a site that is cooling down is refused whole.
  for (const s of [...allSteps, repeatStep].filter(Boolean)) if (s.action === 'nav') cooldown.guard(s.target, { force, action: 'navigate to' });
  const { report, showOn } = ctx;
  report.plan = steps.map(step => step.source);
  // A background tab that does not render routes input by its last painted frame, so a
  // click can land on what used to be there. Keep it rendering without focusing it.
  await ctx.timed('setup', (async () => {
    await ops.wake(conn, tab).catch(() => {});
    await ops.evaluate(conn, tab, page('net-watch', { longPoll: QUIET.LONG_POLL })).catch(() => {}); // so the first step's requests count
    if (steps[0]?.action !== 'nav') await waitForContent(conn, tab, { timeoutMs: CONTENT.PLAN_WAIT, stable: false }); // a page still on its loading shell
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
  const blocked = steps[0]?.action === 'nav' ? null : await detectSiteBlock(ctx);
  const opening = blocked || steps[0]?.action === 'nav' ? null : await meetChallenge(conn, tab, report, ctx);
  if (blocked) stopped = { step: 0, ...blocked };
  else if (opening) stopped = { step: 0, reason: opening };
  ctx.view = await ctx.look();
  if (!stopped) await dismissListed(ctx, 'start');
  if (!ctx.hasJevKey()) {
    const planned = [...allSteps, repeatStep].filter(Boolean);
    const named = planned.filter(s => TARGETED.has(s.action) && !s.ref && !s.selector && !s.item && !s.slots);
    const snap = named.length ? await ctx.readPage() : null;
    // A step that cannot run without Jev stops the plan before anything acts: the judgment
    // steps, and a first named step whose name the page as found does not have exactly.
    const first = named[0] && planned.find(s => s.action === 'nav' || s === named[0]);
    const needs = planned.find(needsJev) || (named[0] && first === named[0] && !exactMatch(snap, named[0]) ? named[0] : null);
    if (needs && !stopped) stopped = { step: 0, reason: `No TypeSafe API key, and step "${clip(needs.source || `${needs.action} ${needs.target}`, 80)}" needs one (${needsJev(needs) || 'its name is not an exact name on the page'}). Set TYPESAFE_API_KEY, or put TYPESAFE_API_KEY=... in ${jev.jevKeyFile()}; plans of exact names, refs and CSS selectors run without one`, noResume: true };
    if (planned.some(s => s.expect) || named.some(s => !exactMatch(snap, s))) {
      const warning = 'No TypeSafe key: exact names work; non-exact targets stop before acting, and post-action expectations are not checked.';
      report.warnings = [warning];
      if (opts.onWarning) await opts.onWarning(warning);
    }
  }
  suggestUrlNotes(ctx);

  const leaves = nodes => nodes.reduce((n, s) => n + (s.action === 'loop' ? s.limit * leaves(s.body) : s.action === 'try' ? s.limit : s.action === 'samePage' ? leaves(s.body) : s.action === 'branch' ? leaves(s.then) + leaves(s.else) : s.action === 'if' ? leaves([s.then]) : 1), 0);
  report.planned_leaves = leaves(steps);
  report.executed_leaves = 0;
  try {
    if (!stopped) stopped = await runPlan(ctx, steps, { onStep });
    if (repeatStep && !stopped) stopped = await repeatUntil(ctx, repeatStep, { repeat, until, max, collect, onStep, sink: opts.collectSink, out: opts.collectOut, pageCap: opts.pageCap, dedupe: opts.dedupe });
    if (!stopped) stopped = await lastCheck(ctx);
    else if (ctx.pending) {
      report.pending_check = { step: ctx.pending.row.step, expect: ctx.pending.expect };
    }
    settleNotes(ctx);
    await finish(ctx, stopped, pageBefore, { then, openN, grep, context });
    if (traceRun) report.trace = writeTrace(tab, lines, steps, report, { repeat, until });
    return report;
  } finally { await stopOwnedRecordings(ctx); }
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
  return template.replace(/(\\)?\$\{([A-Za-z_]\w*)(?:\.(title|link|key))?\}/g, (all, escape, name, field) => {
    if (escape) return '${' + name + (field ? `.${field}` : '') + '}';
    const b = ctx.bindings.get(name);
    if (!b) throw new Error(`Missing binding $${name}`);
    sources.push({ name, ...b });
    if (b.provisional) ctx.report.answer_provisional = true;
    if (!field) return renderValue(b.value);
    return renderField(b.value, field);
  });
}

// A step that uses a binding (nav ${x.link}, click "${x.title}") gets the bound value in the
// argument slots the parser recorded, as literal text: it is never parsed again, so page
// text cannot add steps, expectations or a commit mark. One value only: a step acts on one thing.
function fillSlots(node, bindings) {
  const sources = [];
  const fill = template => template.replace(/(\\)?\$\{([A-Za-z_]\w*)(?:\.(title|link|key))?\}/g, (all, escape, name, field) => {
    if (escape) return all.slice(1);
    const b = bindings.get(name);
    if (!b) throw new Error(`Missing binding $${name}`);
    if (Array.isArray(b.value) && b.value.length !== 1) throw new Error(`$${name} holds ${b.value.length} items; a step can use one, so pick top 1 or answer with all of them`);
    sources.push({ name, ...b });
    const value = field ? renderField(b.value, field) : renderValue(b.value);
    if (!value) throw new Error(`$${name} has no ${field || 'value'} to use in this step`);
    return value;
  });
  const { slots, ...step } = node;
  for (const slot of slots) step[slot] = fill(node[slot]);
  return { step, sources };
}

// open $x: the bound item's link (or a URL) in this tab, or in a new tab the rest of the
// plan then runs in. The link comes from the page, so it is checked like any address.
async function openStep(ctx, node, row, { laterSteps }) {
  let url;
  if (node.from) {
    const b = ctx.bindings.get(node.from);
    if (!b) throw new Error(`Missing binding $${node.from}`);
    if (Array.isArray(b.value) && b.value.length !== 1) throw new Error(`$${node.from} holds ${b.value.length} items; open one, so pick top 1`);
    const v = Array.isArray(b.value) ? b.value[0] : b.value;
    url = v && typeof v === 'object' ? v.link : typeof v === 'string' ? v : null;
    if (!url) throw new Error(`$${node.from} has no link to open`);
    if (b.provisional) row.from_provisional = true;
  } else if (node.slots) {
    const { step, sources } = fillSlots(node, ctx.bindings);
    url = step.target;
    if (sources.some(b => b.provisional)) row.from_provisional = true;
  } else url = node.target;
  try { url = new URL(url, ctx.view?.url).href; } catch { throw new Error(`Cannot open ${JSON.stringify(clip(url, 80))}: not an address`); }
  if (!/^https?:$/.test(new URL(url).protocol)) throw new Error(`Cannot open ${JSON.stringify(clip(url, 80))}: only http and https pages open`);
  row.rendered = { target: url };
  cooldown.guard(url, { force: ctx.opts.force, action: 'open' });
  const { from, slots, newTab, ...rest } = node;
  if (!newTab) return runOne(ctx, { ...rest, action: 'nav', target: url }, row, { laterSteps });
  const tab = (await ops.newTab(ctx.conn, url)).targetId;
  ctx.tab = tab;
  ctx.tabSwitched = true;
  ctx.report.tab_switched = true;
  ctx.openedHere = [];
  ctx.lastFilled = null;
  row.tab = tab;
  row.opened_tab = tab;
  row.acted = true;
  await ops.wake(ctx.conn, tab).catch(() => {});
  await ops.waitForReady(ctx.conn, tab).catch(() => {});
  await waitForContent(ctx.conn, tab, { timeoutMs: Math.max(0, Math.min(CONTENT.PLAN_WAIT, ctx.deadline - Date.now())) });
  ctx.view = await ctx.look();
  row.url_after = ctx.view.url;
  const why = await meetChallenge(ctx.conn, tab, row, ctx);
  if (why) return { stop: { reason: why } };
  if (node.expect) ctx.pending = { expect: node.expect, row };
  return {};
}

function renderStep(ctx, node, row) {
  const { step, sources } = fillSlots(node, ctx.bindings);
  row.rendered = Object.fromEntries(node.slots.map(slot => [slot, step[slot]]));
  if (sources.some(b => b.provisional)) row.from_provisional = true;
  if (step.action === 'nav') cooldown.guard(step.target, { force: ctx.opts.force, action: 'navigate to' });
  return step;
}

// A ranked pick binds records ({ text, key, evidence, ... }): an answer shows their text.
function renderValue(v) {
  if (Array.isArray(v)) return v.map(renderValue).join('; ');
  if (v && typeof v === 'object') return typeof v.text === 'string' ? v.text : JSON.stringify(v);
  return String(v);
}

function renderField(v, field) {
  if (Array.isArray(v)) return v.map(item => renderField(item, field)).join('; ');
  if (v && typeof v === 'object') {
    const value = field === 'title' ? (v.title || v.text?.split(' · ')[0] || '') : v[field];
    return value == null ? '' : String(value);
  }
  return '';
}

async function runPlan(ctx, nodes, { onStep, following = false }) {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (ctx.inItem && node.action === 'extract') {
      const batch = [node];
      while (nodes[index + 1]?.action === 'extract' && !batch.at(-1).expect) batch.push(nodes[++index]);
      let stopped;
      try { stopped = await extractBatch(ctx, batch, onStep); }
      catch (e) { stopped = { step: node.path, reason: e.message }; }
      if (stopped) return stopped;
      continue;
    }
    const stepId = /^\d+$/.test(node.path) ? Number(node.path) : node.path;
    const row = { step: stepId, path: node.path, tab: ctx.tab, do: node.source };
    if (ctx.startDismiss) { row.dismissed = ctx.startDismiss; ctx.startDismiss = null; }
    if (Date.now() >= ctx.deadline) return { step: stepId, reason: 'Run deadline reached' };
    let res = {};
    try {
      if (node.action === 'loop') {
        ctx.report.steps.push(row);
        const stopped = await itemLoop(ctx, node, row, { onStep, following: following || index < nodes.length - 1 });
        if (stopped) { row.stopped = true; row.stop = stopped.reason; if (onStep) await onStep(row).catch(() => {}); return stopped; }
        if (onStep) await onStep(row).catch(() => {});
        continue;
      } else if (node.action === 'try' || node.action === 'samePage') {
        const execute = node.action === 'try' ? candidateSearch : samePage;
        res = await execute(ctx, node, row, { runOne, drain, onStep });
        row.tab = ctx.tab;
      } else if (node.action === 'open') {
        if (node.newTab) {
          const stopped = await drain(ctx);
          if (stopped) return stopped;
        }
        res = await openStep(ctx, node, row, { laterSteps: following || index < nodes.length - 1 });
      } else if (node.action === 'rankedPick') {
        if (ctx.report.executed_leaves >= PLAN.MAX_LEAVES) res = { stop: { reason: `Executed leaf limit ${PLAN.MAX_LEAVES} reached` } };
        else { ctx.report.executed_leaves++; res = await rankedPick(ctx, node, row); }
      } else if (node.action === 'branch') {
        if (node.comparison) {
          const stopped = await drain(ctx);
          if (stopped) return stopped;
          row.branch = compare(ctx, node.comparison, row) ? 'then' : 'else';
          row.skipped_branch = row.branch === 'then' ? 'else' : 'then';
        } else res = await runOne(ctx, node, row, { laterSteps: following || index < nodes.length - 1 });
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
          const step = node.slots ? renderStep(ctx, node, row) : node;
          res = await runOne(ctx, step, row, { laterSteps: following || index < nodes.length - 1 });
        }
      }
    } catch (e) { res = { stop: { reason: e.message } }; }
    if (res.expectFailed) { ctx.pending = null; return res.stop; }
    if (res.stop) { row.stopped = true; row.stop = res.stop.reason; }
    if (!ctx.report.steps.includes(row)) ctx.report.steps.push(row);
    if (onStep) await onStep(row).catch(() => {});
    if (ctx.showOn) await hud(ctx, res.stop);
    if (res.stop) return { step: stepId, ...res.stop };
    if (node.action === 'branch') {
      const parent = ctx.bindings;
      ctx.bindings = new Map(parent);
      let stopped;
      try {
        stopped = await runPlan(ctx, node[row.branch], { onStep, following: following || index < nodes.length - 1 });
        if (!stopped) stopped = await drain(ctx);
      } finally { ctx.bindings = parent; }
      if (stopped) return stopped;
    }
  }
  return null;
}


async function extractBatch(ctx, nodes, onStep) {
  const parts = [], questions = {};
  for (const node of nodes) {
    const j = await judgment(ctx, node, parts[0]?.j.all);
    if (j.stop) return { step: node.path, ...j.stop };
    const entries = j.questions || { extract: j.question };
    const keys = {};
    for (const [key, question] of Object.entries(entries)) {
      const name = key === 'extract' ? node.target : key.slice(8);
      let id = `extract.${name}`;
      if (Object.hasOwn(questions, id)) id += `.${parts.length + 1}`;
      keys[key] = id;
      questions[id] = question;
    }
    parts.push({ node, j, keys });
  }
  if (ctx.view.overlay?.trim()) questions.blocker = blockerQuestion();
  const asked = await askJev(ctx, nodes[0], {}, {}, { extra: questions, inNote: true });
  if (asked === AGAIN) return { step: nodes[0].path, reason: 'Detail page changed during extraction' };
  if (asked.result) return asked.result.stop;
  if (prob(asked.answers.blocker) >= .5) return { step: nodes[0].path, reason: 'A blocking overlay covers the detail page' };
  for (const { node, j, keys } of parts) {
    const row = { step: node.path, path: node.path, tab: ctx.tab, do: node.source, source_item: ctx.inItem };
    let result;
    if (Date.now() >= ctx.deadline) result = { stop: { reason: 'Run deadline reached' } };
    else if (ctx.report.executed_leaves >= PLAN.MAX_LEAVES) result = { stop: { reason: `Executed leaf limit ${PLAN.MAX_LEAVES} reached` } };
    else {
      ctx.report.executed_leaves++;
      const answers = Object.fromEntries(Object.entries(keys).map(([key, id]) => [key, asked.answers[id]]));
      ctx.batchedExtraction = true;
      try { result = (await settleJudgment(ctx, node, row, j, answers)).result; }
      finally { ctx.batchedExtraction = false; }
      if (row.extracted) {
        row.extracted.source_item = ctx.inItem;
        for (const evidence of ctx.report.extracted || []) if (evidence.step === row.step) evidence.source_item = ctx.inItem;
      }
    }
    ctx.report.steps.push(row);
    if (result?.stop) { row.stopped = true; row.stop = result.stop.reason; }
    if (onStep) await onStep(row).catch(() => {});
    if (result?.stop) return { step: node.path, ...result.stop };
    if (node.expect) ctx.pending = { expect: node.expect, row };
  }
  return null;
}

function itemPaths(nodes, prefix, original) {
  return nodes.map(node => ({ ...node, path: node.path.replace(original + '.item[]', prefix),
    ...(node.body ? { body: itemPaths(node.body, prefix, original) } : {}),
    ...(node.attempt ? { attempt: { ...node.attempt, path: node.attempt.path?.replace(original + '.item[]', prefix) } } : {}),
    ...(node.action === 'branch' ? { then: itemPaths(node.then, prefix, original), else: itemPaths(node.else, prefix, original) } : {}),
    ...(node.action === 'if' ? { then: itemPaths([node.then], prefix, original)[0] } : {}) }));
}

async function itemLoop(ctx, node, row, options) {
  const frozen = await freezeList(ctx);
  const record = { step: node.path, requested: node.limit, completed: 0, items: [], ...frozen };
  record.items = [];
  (ctx.report.item_loops ||= []).push(record);
  ctx.report.items_requested = (ctx.report.items_requested || 0) + node.limit;
  ctx.report.items_completed ||= 0;
  const questions = {};
  if (node.mode === 'each') frozen.items.forEach((item, i) => {
    questions[`member.${i + 1}`] = membershipQuestion(node.target, item);
  });
  const asked = await askJev(ctx, node, row, {}, { extra: questions, inNote: true });
  if (asked === AGAIN) return { step: node.path, reason: 'Source page changed during selection' };
  if (asked.result) return asked.result.stop;
  if (asked.watchBlocker && prob(asked.answers.blocker) >= .5) return { step: node.path, reason: 'A blocking overlay covers the source list' };
  const selected = [];
  for (let i = 0; i < frozen.items.length && selected.length < node.limit; i++) {
    const item = frozen.items[i];
    if (node.mode === 'each') {
      const p = asked.answers[`member.${i + 1}`]?.noul;
      if (!Number.isFinite(p) || p < 0 || p > 1 || (p > .25 && p < .75)) return { step: node.path, reason: 'membership unresolved', item };
      if (p <= .25) continue;
      item.eligibility_p = p;
    }
    selected.push(item);
  }
  if (selected.length < node.limit) {
    record.source_exhausted = !frozen.truncated;
    if (frozen.truncated) return { step: node.path, reason: 'Selection requires unseen items; input truncated at 200 items' };
  }
  const sourceTab = ctx.tab, parent = ctx.bindings;
  const sourceState = { openedHere: ctx.openedHere, lastFilled: ctx.lastFilled, lastRow: ctx.lastRow, unverifiedSelection: ctx.unverifiedSelection };
  for (const [i, item] of selected.entries()) {
    const entry = { ...item, path: `${node.path}.item[${i + 1}]`, completed: false, bindings: [], extracted: [] };
    record.items.push(entry);
    if (Date.now() >= ctx.deadline) return { step: entry.path, reason: 'Run deadline reached' };
    if (!item.link) return { step: entry.path, reason: 'Item requires a detail link', item };
    let owned;
    const firstRow = ctx.report.steps.length, firstExtract = (ctx.report.extracted || []).length, firstBinding = (ctx.report.bindings || []).length;
    let stopped;
    try {
      cooldown.guard(item.link, { force: ctx.opts.force, action: 'open' });
      owned = await openOwnedTab(ctx, item.link, { path: entry.path, title: item.text, label: `item ${i + 1} of ${selected.length}` });
      ctx.tab = owned;
      ctx.bindings = new Map(parent);
      ctx.openedHere = [];
      ctx.lastFilled = null;
      ctx.inItem = { ...item, source_url: frozen.source_url };
      await ops.wake(ctx.conn, owned);
      await ops.waitForReady(ctx.conn, owned);
      await waitForContent(ctx.conn, owned, { timeoutMs: Math.max(0, Math.min(CONTENT.PLAN_WAIT, ctx.deadline - Date.now())) });
      ctx.view = await ctx.look();
      const why = await meetChallenge(ctx.conn, owned, entry, ctx);
      stopped = why ? { step: entry.path, reason: why } : await runPlan(ctx, itemPaths(node.body, entry.path, node.path), { ...options, following: options.following || i < selected.length - 1 });
      if (!stopped) stopped = await lastCheck(ctx);
      if (stopped?.step === 'end') stopped = { ...stopped, step: `${entry.path}.end` };
    } catch (e) { stopped = { step: entry.path, reason: e.message }; }
    finally {
      entry.steps = ctx.report.steps.slice(firstRow);
      entry.extracted = (ctx.report.extracted || []).slice(firstExtract).map(e => ({ ...e, source_item: item }));
      entry.bindings = (ctx.report.bindings || []).splice(firstBinding);
      ctx.pending = null;
      ctx.tab = sourceTab;
      ctx.bindings = parent;
      ctx.inItem = null;
      Object.assign(ctx, sourceState);
      if (owned) {
        try { await closeOwnedTab(ctx, owned); }
        catch (e) { stopped ||= { step: entry.path, reason: `Could not close owned tab: ${e.message}` }; }
      }
      ctx.view = await ctx.look();
    }
    if (stopped) { entry.stopped = stopped; return stopped; }
    entry.completed = true;
    record.completed++;
    ctx.report.items_completed++;
  }
  return null;
}

// Repeat a step (usually "click Next") until the page condition holds (when there is one),
// the step cannot be done (no Next, or only a disabled one), the page stops changing, or max
// is reached, collecting each page on the way (lib/collect.mjs). Returns a stop, or null.
export const MAX_REPEATS = 5000;
async function repeatUntil(ctx, repeatStep, { repeat, until, max, collect, onStep, sink, out, pageCap, dedupe }) {
  const { conn, tab, report } = ctx;
  let stopped = null;
  const loop = { pages: 0, ended: null };
  const pages = collect ? collector(collect, { conn, tab, sink, pageCap, dedupe }) : null;
  const untilQ = until ? expectQuestion(until) : null;
  const signature = () => ops.evaluate(conn, tab, PAGE_SIGNATURE).catch(() => null);
  let before = await signature();
  for (let k = 0; ; k++) {
    loop.pages++;
    if (pages) await pages.readPage(ctx.view, loop.pages);
    if (k >= max) { loop.ended = `max ${max} repeats`; break; }
    // The last page: the Next the step names is there but disabled.
    if (repeatStep.action === 'click' && repeatStep.target && !repeatStep.ref && !repeatStep.selector &&
      await ops.evaluate(conn, tab, page('named-disabled', { names: repeatStep.alts || [repeatStep.target] })).catch(() => false)) {
      loop.ended = `"${repeatStep.target}" is disabled (the last page)`;
      break;
    }
    // Each page gets the plan's time budget again: a long export is bounded by --max instead.
    ctx.deadline = Math.max(ctx.deadline, Date.now() + PLAN.DEADLINE);
    const row = { step: `r${k + 1}`, do: repeat, repeat: k + 1 };
    const res = await runOne(ctx, repeatStep, row, { extra: untilQ ? { until: untilQ } : {}, stopIf: untilQ ? a => prob(a.until) >= 0.5 : undefined, retryMs: STEP.RETRY_REPEAT, canSkip: true });
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
    // The last page: Next is still there but the page did not change. A page that fills in
    // late gets a few seconds before it counts as unchanged.
    let now = await signature(), waited = 0;
    for (; now && now === before && waited < 3000; waited += 300) { await sleep(300); now = await signature(); }
    if (now && now === before) { loop.ended = 'the page did not change (the last page)'; break; }
    // Then until it holds still (a "Loading…" row replaced by the rows), up to 3 s.
    for (let i = 0; now && i < 10; i++) { await sleep(300); const again = await signature(); if (again === now) break; now = again; waited++; }
    before = now;
    if (waited) ctx.view = await ctx.look().catch(() => ctx.view);
  }
  report.loop = loop;
  if (pages) {
    report.collected = pages.summary(out);
    if (collect === 'items' && !sink) loop.items = report.collected.groups.reduce((n, g) => n + g.count, 0);
    else loop.records = pages.records;
  }
  return stopped;
}

// One last request: the last step's expected result, a blocking overlay, and the page
// flags (a challenge or login wall after the plan is the most common reason a run
// "worked" but shows nothing useful). Returns a stop, or null.
async function dismissListed(ctx, position) {
  if (!ctx.categories.length || !ctx.view.overlay?.trim()) return;
  const key = `${position}|${ctx.view.url}|${ctx.view.overlay}`;
  ctx.dismissAttempts ||= new Set();
  if (ctx.dismissAttempts.has(key)) return;
  ctx.dismissAttempts.add(key);
  const row = { step: position, do: `(dismiss at ${position})` };
  const result = await dismissOverlay(ctx, row);
  if (result.stop) ctx.report.overlay = result.stop.overlay;
  if (row.dismissed) {
    if (!result.stop) delete ctx.report.overlay;
    if (position === 'start') ctx.startDismiss = row.dismissed;
    else ctx.report.steps.push(row);
  }
}

async function lastCheck(ctx) {
  await dismissListed(ctx, 'end');
  const { report, view } = ctx;
  if (report.steps.length && report.steps.every(row => row.skipped) && !ctx.pending) return null;
  // Without a key the closing page check cannot run: say so instead of stopping a plan
  // whose steps all ran without Jev.
  if (!ctx.hasJevKey()) {
    ctx.uncheckedExpectation();
    report.final_check = 'skipped (no TypeSafe key)';
    return Date.now() >= ctx.deadline ? { step: 'end', reason: 'Run deadline reached' } : null;
  }
  let stopped = null;
  const questions = {};
  for (const [id, q] of Object.entries(jev.CHECKS)) questions[id] = noul(q);
  if (ctx.pending) questions.prev_expect = expectQuestion(ctx.pending.expect);
  if (view.overlay?.trim()) questions.blocker = blockerQuestion();
  try {
    const r = await ctx.ask({ page: jev.viewState(view) }, questions);
    const checks = Object.fromEntries(Object.keys(jev.CHECKS).map(id => [id, prob(r.answers[id])]));
    if (ctx.strictChecks && Object.values(checks).some(p => !Number.isFinite(p) || p < 0 || p > 1)) stopped = { step: 'end', reason: 'Final page check unresolved' };
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
    if (ctx.strictChecks || ctx.pending || report.answer !== undefined) stopped = { step: ctx.pending?.row.step || 'end', reason: e.message };
  }
  if (!stopped && Date.now() >= ctx.deadline) stopped = { step: 'end', reason: 'Run deadline reached' };
  return stopped;
}

// The report's ending: the stop, the page now, what the plan changed, the address
// parameters, and --then items or text (with --open, the first items opened).
async function finish(ctx, stopped, pageBefore, { then, openN, grep, context }) {
  const { conn, tab, report, opts, showOn } = ctx;
  if (stopped) await dismissListed(ctx, 'end');
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
  const unanswered = (report.extracted || []).filter(e => e.value == null);
  if (unanswered.length) {
    report.unsure = true;
    report.unsure_reason = `nothing answered ${unanswered.map(e => JSON.stringify(e.what)).join(', ')}`;
    for (const row of report.steps) if (row.extracted?.value == null && row.extracted) row.unsure = true;
  }
  if (report.steps.some(s => s.unsure)) report.unsure = true;
  if (report.steps.some(s => s.provisional) && !report.unsure_reason) report.unsure_reason = 'a ranked pick is provisional';
  if (report.answer !== undefined && stopped) report.answer_provisional = true;
  // A stop that lists refs (candidates, twins) names them from this plan's own snapshot: the
  // caller's next ref means that snapshot from now on.
  if (stopped && (stopped.candidates?.length || /\bref_\d+/.test(stopped.reason || ''))) report.refsToken = await ops.evaluate(conn, tab, 'window.__cdp && window.__cdp.token').catch(() => null);
  ctx.view = await ctx.look().catch(() => ctx.view);
  const { view } = ctx;
  report.page = { url: view.url, title: view.title };
  if (view.overlay?.trim() || report.flags?.includes('dialog')) {
    const snap = await ctx.readPage();
    if (snap.modal) {
      report.flags = [...new Set([...(report.flags || []), 'dialog'])];
      report.dialog = { role: snap.modal.role, name: clip(snap.modal.name || view.overlay, 100) };
    }
  }
  if (pageBefore && !ctx.tabSwitched) report.changes = finder.diffPage(pageBefore, await ctx.timed('diff', ops.evaluate(conn, tab, finder.PAGE_STATE_FOR_DIFF)).catch(() => null));
  report.params = await ctx.timed('read', ops.evaluate(conn, tab, PAGE_PARAMS)).catch(() => []);
  if (then === 'items' || openN) report.items = await ctx.timed('then', ops.evaluate(conn, tab, itemsExpression({ openedDialog: ctx.lastOpenedDialog })));
  // A plan that ends with its results out of view (scrolled to the foot of a filter sidebar,
  // or back to the top above a tall header): bring the main list's first item into view, so
  // the page shows the results the report lists, as a person checking them would.
  if (report.items && !stopped) {
    const main = mainGroup(report.items);
    if (main?.items?.length && main.items.every(it => it.below || it.above)) {
      const moved = await ops.evaluate(conn, tab, page('scroll-to-item', { id: main.items[0].id })).catch(() => false);
      if (moved) {
        report.scrolled = main.heading ? `"${clip(main.heading, 50)}"` : 'the results';
        report.items = await ctx.timed('then', ops.evaluate(conn, tab, itemsExpression({ openedDialog: ctx.lastOpenedDialog }))).catch(() => report.items);
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
      url_before: row.url_before, url_after: row.url_after, ...(row.acted ? { acted: true } : {}),
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

// The resume line: do <tab> --resume runs the stopped plan again from its failed step (from
// the trace), and --replace swaps that step, here for the closest controls Jev ranked. Without
// a trace the remaining steps are spelled out. Replaying blocks or commits is never offered.
function resumeCommand(r) {
  if (!r.stopped || r.stopped.noResume || !r.plan?.length || !r.current_tab) return null;
  const row = r.steps.find(s => String(s.step) === String(r.stopped.step));
  const moved = Boolean(row?.acted && row.url_before !== row.url_after);
  if (/\bcommit(?:s|ting)?\b/i.test(r.stopped.reason || '')) return null;
  const base = remainingSteps({ plan: r.plan, step: r.stopped.step, acted: Boolean(row?.acted), moved });
  let failed = null;
  try { failed = parsePlan(r.plan)[Number(r.stopped.step) - 1]; } catch {}
  // A failed step that commits is never swapped for a guessed control.
  if (failed?.commit || (['click', 'select'].includes(failed?.action) && saysCommit(failed.target))) return null;
  const fixes = replacements(failed, r.stopped.candidates).filter(f => !remainingSteps({ plan: r.plan, step: r.stopped.step, replace: f.step }).why);
  if (base.why && !fixes.length) return null;
  const quote = value => "'" + String(value).replace(/'/g, "'\"'\"'").replace(/\n/g, () => "'$'\\n''").replace(/\r/g, () => "'$'\\r''") + "'";
  const tab = quote(r.current_tab);
  // The trace is kept under the tab the plan started on; after open … in new tab, spell it out.
  const traced = r.trace && !r.tab_switched;
  const withFix = f => traced ? `browserctrl do ${tab} --resume --replace ${quote(f.step)}`
    : `browserctrl do ${tab} ${remainingSteps({ plan: r.plan, step: r.stopped.step, replace: f.step }).lines.map(quote).join(' ')}`;
  const lines = [];
  if (fixes.length) {
    lines.push(`resume: ${withFix(fixes[0])}${fixes[0].p != null ? `   # closest control, p=${Number(fixes[0].p).toFixed(2)}` : ''}`);
    for (const f of fixes.slice(1)) lines.push(`    or: ${withFix(f)}${f.p != null ? `   # p=${Number(f.p).toFixed(2)}` : ''}`);
    if (!base.why) lines.push(`    or as planned: browserctrl do ${tab} ${traced ? '--resume' : base.lines.map(quote).join(' ')}`);
  } else if (!traced) lines.push(`resume: browserctrl do ${tab} ${base.lines.map(quote).join(' ')}`);
  else if (row?.acted) lines.push(`resume: browserctrl do ${tab} --resume   # step ${r.stopped.step} already ran; this runs ${base.lines.map(quote).join(' ')}`);
  else lines.push(`resume: browserctrl do ${tab} --resume   # add --replace '<step>' to fix step ${r.stopped.step}`);
  return lines.join('\n');
}

// Where an extracted value was read: its line on the page (when the value is only part of
// it) and the page's address, so a caller can trust it without reading the page again.
function sourceOf(e) {
  const line = e.raw != null && String(e.raw) !== String(e.value) ? ` from ${JSON.stringify(clip(String(e.raw), 120))}` : '';
  return `${line}${e.url ? ` on ${e.url}` : ''}`;
}

export function formatSteps(r) {
  const lines = (r.warnings || []).map(w => `⚠ ${w}`);
  if (r.challenge) lines.push(`challenge before step 1:${met(r.challenge)}`);
  if (r.answer !== undefined) lines.push(`answer: ${r.answer}${r.answer_provisional ? ' (provisional)' : ''}`);
  for (const b of r.bindings || []) lines.push(`binding $${b.name}: ${JSON.stringify(b.value)} from ${JSON.stringify(b.raw)} (p=${b.p.toFixed(2)}, step ${b.step})`);
  for (const s of r.steps) {
    const mark = s.unsure ? '⚠' : s.stopped ? '✗' : s.skipped ? '–' : '✓';
    const p = s.p !== undefined ? ` (p=${s.p.toFixed(2)})` : s.expect_p !== undefined ? ` (expected p=${s.expect_p.toFixed(2)})` : '';
    lines.push(`${mark} ${s.step}. ${s.do}${s.target ? `  → ${s.target}` : ''}${s.how ? ` (${s.how})` : ''}${p}${s.unchecked ? `  ${s.unchecked}` : s.unsure ? (s.ambiguity ? `  ⚠ ${s.ambiguity}` : '  unsure: check the page') : ''}${s.checked !== undefined ? (s.already ? `  already ${s.pressed_kind ? 'pressed' : 'checked'}` : `  now ${s.pressed_kind ? (s.checked ? 'pressed' : 'not pressed') : s.checked ? 'checked' : 'unchecked'}`) : ''}${s.slider !== undefined ? `  now ${s.slider}` : ''}${s.expanded !== undefined ? `  ${s.already && s.checked === undefined ? 'already' : 'now'} ${s.expanded ? 'open' : 'closed'}` : ''}${s.skipped ? `  skipped: ${s.skipped}` : ''}  ${s.ms ?? 0} ms${met(s.challenge)}${s.url_change ? `\n     url: ${s.url_change}` : ''}`);
    if (s.opened_tab) lines.push(`     opened in new tab ${s.opened_tab}; the steps after it ran there`);
    if (s.rendered) lines.push(`     with ${Object.entries(s.rendered).map(([slot, v]) => `${slot} ${JSON.stringify(v)}`).join(', ')}${s.from_provisional ? '  ⚠ from a provisional pick' : ''}`);
    if (s.items) {
      lines.push(`     ranked: ${s.completed}/${s.requested}; ties in ${s.tie_order}${s.source_exhausted ? '; source exhausted' : ''}; ${s.coverage.offered}/${s.coverage.total} items offered`);
      for (const item of s.items) lines.push(`       ${item.id} | ${clip(item.text, 80)} | key=${item.key} | eligible p=${item.eligibility_p.toFixed(2)}`);
      for (const note of s.rank_notes || []) lines.push(`     note: ${note}`);
      for (const why of s.excluded || []) lines.push(`     ${why}`);
      if (s.provisional) lines.push(`     ⚠ provisional: ${s.provisional}`);
    }
    if (s.attempts) for (const attempt of s.attempts) {
      lines.push(`     ${attempt.path} | candidate=${JSON.stringify(attempt.candidate)} | check p=${attempt.check_p ?? 'unchecked'} | restoration=${JSON.stringify(attempt.restoration ?? null)}${attempt.rejection_reason ? ` | rejected: ${attempt.rejection_reason}` : ''}`);
    }
    if (s.same_page?.requested !== undefined) lines.push(`     same page: ${s.same_page.completed}/${s.same_page.requested} fills; ${s.same_page.regrounds} re-groundings`);
    if (s.branch) lines.push(`     branch: ${s.branch}; skipped: ${s.skipped_branch}`);
    // A reveal step that could not run was skipped (the page was already past it).
    for (const v of s.via_notes || []) lines.push(`     ${v.ok || (v.kind === 'reveal' && s.how?.includes(`via note ${v.id}`)) ? 'via' : 'tried'} note ${v.id} (${v.kind}): ${(s.note_steps || []).map(n => `${n.do}${n.stopped ? (v.kind === 'reveal' ? ' (skipped)' : ' ✗') : ''}`).join(' → ')}`);
    for (const h of s.hints || []) lines.push(`     hint: ${h}`);
    if (s.extract_verify) lines.push(`     extract verify p=${Number(s.extract_verify.p).toFixed(2)} (${s.extract_verify.ms} ms)`);
    if (s.content_wait_ms !== undefined) lines.push(`     waited ${s.content_wait_ms} ms for the page to fill in`);
    if (s.extracted?.source_attribute) lines.push(`     source attribute: ${s.extracted.source_attribute}`);
    if (s.extract_second_pass) lines.push('     extraction second pass over omitted lines');
    if (s.extracted?.value != null) lines.push(`     = ${JSON.stringify(s.extracted.value)}${sourceOf(s.extracted)}${s.extracted.members ? ` (group p=${s.extracted.p.toFixed(2)}; ${s.extracted.members.map(m => `${JSON.stringify(m.value)} p=${m.p.toFixed(2)}`).join('; ')})` : ''}${(s.extracted.alternatives || []).map(a => `  or ${JSON.stringify(a.value)} (p=${a.p.toFixed(2)})`).join('')}`);
    if (s.picked) lines.push(`     picked ${s.picked.id} "${s.picked.text}"${(s.picked.runnersUp || []).map(c => `  next: ${c.id} "${c.text}" (p=${c.p.toFixed(2)})`).join('')}`);
  }
  // The answers a plan extracted, together, so the caller can answer from them.
  if (r.extracted?.length) lines.push('\nextracted:', ...r.extracted.map(e => `  ${e.what}: ${e.value == null ? '(no line on the page answers this)' : JSON.stringify(e.value)}${e.ambiguity ? `  ⚠ ${e.ambiguity}` : ''}`));
  for (const sg of r.suggestions || []) lines.push(`note ${sg.id}: ${sg.text}`);
  if (r.notes_applied?.length) lines.push(`notes: ${r.notes_applied.map(n => `${n.id} ${n.ok ? 'confirmed' : 'contradicted'}`).join(', ')}`);
  if (r.events?.length) lines.push('\nevents:', ...formatEvents(r.events));
  for (const loop of r.item_loops || []) {
    lines.push(`\nitems ${loop.step}: ${loop.completed}/${loop.requested}${loop.source_exhausted ? '; source exhausted' : ''}${loop.truncated ? '; truncated' : ''}`);
    for (const item of loop.items) lines.push(`  ${item.path} | ${item.completed ? 'done' : 'stopped'} | ${clip(item.text, 80)} | ${item.extracted.map(e => `${e.what}=${JSON.stringify(e.value)}`).join('; ')}`);
  }
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

  if (r.collected?.groups) {
    lines.push(`\ncollected ${r.collected.groups.reduce((n, g) => n + g.count, 0)} items over ${r.collected.pages} pages (${r.collected.duplicates} duplicates dropped)`);
    for (const g of r.collected.groups) {
      lines.push(`${g.id}  ${[g.region, g.heading && `"${g.heading}"`, g.label && `[${g.label}]`].filter(Boolean).join(' · ') || '(no region)'}  · ${g.count} items`);
      for (const it of g.items) lines.push(`  p${it.page} ${clip(it.text, 160) || '(no text)'}${it.link ? `  → ${it.link.slice(0, 80)}` : ''}`);
    }
  } else if (r.collected?.out) {
    lines.push(`\ncollected ${r.collected.records} ${r.collected.mode === 'text' ? `pages of text (${r.collected.chars} characters)` : r.collected.mode} over ${r.collected.pages} pages into ${r.collected.out === '-' ? 'stdout' : r.collected.out}${r.collected.mode === 'text' ? '' : ` (${r.collected.duplicates} duplicates dropped)`}${r.collected.truncated_pages ? `; ${r.collected.truncated_pages} pages cut at --page-cap ${r.collected.page_cap}` : ''}`);
  } else if (r.collected?.rows) {
    lines.push(`\ncollected ${r.collected.count} rows over ${r.collected.pages} pages (${r.collected.duplicates} duplicates dropped)${r.collected.truncated ? `; first ${r.collected.rows.length} shown, --out FILE keeps them all` : ''}`);
    if (r.collected.columns.length) lines.push(r.collected.columns.join(' | '));
    for (const row of r.collected.rows) lines.push(`  p${row._page} ${r.collected.columns.map(c => clip(row[c] ?? '', 60)).join(' | ')}`);
  } else if (r.collected?.text) lines.push(`\n${r.collected.text}${r.collected.truncated ? '\n[truncated; --out FILE keeps every page in full]' : ''}`);
  if (r.scrolled) lines.push(`\nscrolled the results into view (${r.scrolled})`);
  if (r.items) lines.push(`\n${formatItems(r.items, { main: true })}`);
  if (r.opened) lines.push(`\nopened ${r.opened.length}:\n${formatVisits(r.opened)}`);
  if (r.text) lines.push(`\n${r.text}`);
  lines.push(`\n${r.page.title}\n${r.page.url}${r.flags ? `\nflags: ${r.flags.map(f => f === 'dialog' && r.dialog ? `${r.dialog.role} ${JSON.stringify(r.dialog.name)}` : f).join(', ')}` : ''}${r.cooldown ? `\ncool-down: ${cooldown.describe(r.cooldown)}` : ''}   total ${r.ms} ms, ${r.jev_calls} Jev calls${r.items_requested !== undefined ? `, ${r.items_completed}/${r.items_requested} items completed/requested` : ''}${r.executed_leaves !== undefined ? `, ${r.executed_leaves}/${r.planned_leaves} planned leaves executed` : ''}${r.candidate_attempts !== undefined ? `, ${r.candidate_attempts} candidate attempts` : ''}`);
  if (r.final_check) lines.push(`final page check ${r.final_check}`);
  if (r.current_tab) lines.push(`current tab: ${r.current_tab}`);
  if (r.owned_tabs?.length) lines.push(`owned tabs left for inspection: ${r.owned_tabs.join(', ')}`);
  const total = r.planned_leaves ?? r.steps.length;
  const completed = r.executed_leaves ?? r.steps.filter(s => !s.stopped).length;
  lines.push(r.stopped
    ? `✗ stopped at step ${r.stopped.step}/${total}: ${clip(r.stopped.reason, 200)}`
    : `✓ done: ${completed}/${total} steps${completed === 0 ? ' (nothing ran)' : ''}${r.unsure ? ` (unsure${r.unsure_reason ? ': ' + r.unsure_reason : ''})` : ''}`);
  const resume = resumeCommand(r);
  if (resume) {
    const row = r.steps.find(s => String(s.step) === String(r.stopped.step));
    if (row?.acted) lines.push(`step ${row.step} already ran; the page is not what it expected, fix the page first`);
    lines.push(resume);
  }
  return lines.join('\n');
}

// Exported here, not at its definition: plan-use8-render evaluates the render section alone.
export { fillSlots };

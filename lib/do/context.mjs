// One run of a plan: what its steps share. runSteps makes a RunContext and hands it to every
// part (grounding, toggles, dates, sliders, notes, overlays, outcome), which read and update
// the shared state here instead of a closure's variables:
//   view        what the page shows now (page-state), read again after each step
//   pending     the previous step's expected result, checked with the next Jev request
//   lastRow     the row that ran before the current one, for event attribution
//   lastFilled  the field the last fill typed into: "Submit" right after a search runs it
//   openedHere  sections this plan opened, so one hiding a later target can be closed
//   fired       on note id -> times run, so a situation that stays cannot loop
//   applied     note id -> ok, for confirm/contradict at the end
import * as ops from '../ops.mjs';
import * as jev from '../jev.mjs';
import * as show from '../show.mjs';
import * as notes from '../notes.mjs';
import { page } from '../page/index.mjs';
import { STEP, PLAN } from '../timing.mjs';

// Icon-font glyphs (private-use characters: Google's "Sort by ") are not words a plan names.
export const norm = (s) => String(s || '').replace(/[-]/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();
export const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
export const prob = (a) => (a && typeof a.noul === 'number' ? Math.round(a.noul * 100) / 100 : NaN);
export const noul = (instructions) => ({ type: 'noul', instructions });
export const describeEl = (e) => `${e.role} "${clip(e.name, 60)}"`;
export const expectQuestion = (what) => noul(`Does the page show this: ${what}?`);

// A pass of a step that did not end it: try again on the page as it is now, or start the
// tries afresh (lib/do/perform.mjs).
export const AGAIN = 'again', AFRESH = 'afresh';

let pinSeq = 0;
export const pinKey = () => `bc${Date.now().toString(36)}${(++pinSeq).toString(36)}`;

export function parseCategories(dismiss) {
  if (!dismiss || dismiss === true) return [];
  return (Array.isArray(dismiss) ? dismiss : String(dismiss).split(',')).map(s => String(s).trim()).filter(Boolean);
}

export class RunContext {
  constructor(conn, tab, steps, opts = {}) {
    const { minP = 0.6, key: cfgIn, handoff = true, handoffMs = STEP.HANDOFF, dismiss, jev: jevOpts = {}, show: showOn = false } = opts;
    Object.assign(this, { conn, tab, steps, opts, minP, handoff, showOn });
    this.handoffBudgetMs = handoffMs;
    this.categories = parseCategories(dismiss);
    this.cfg = cfgIn || jevOpts.cfg;
    this.fetchOpts = jevOpts.fetchImpl ? { fetchImpl: jevOpts.fetchImpl } : undefined;
    this.report = { steps: [], events: [], ms: 0, jev_calls: 0 };
    // Recipes and flow notes for each kind of page a step lands on, once per run; the start
    // page was already hinted by the open, nav or read that came before.
    this.hinted = new Set();
    // The page's notes, read again only when the run reaches another kind of page.
    this.useNotes = !opts.noNotes && notes.hinting();
    this.noteCache = { kind: null, context: [], runnable: [] };
    this.applied = new Map();
    this.fired = new Map();
    this.started = Date.now();
    this.deadline = this.started + Math.min(opts.deadlineMs ?? PLAN.DEADLINE, PLAN.DEADLINE);
    this.bindings = new Map();
    this.inItem = null;
    this.batchedExtraction = false;
    this.executedRows = new WeakSet();
    this.report.executed_leaves = 0;
    // Where a run's time goes, by phase, for the trace (setup, reads, Jev, input, stop report, then).
    this.phases = this.report.phases = {};
    this.openedHere = [];
    this.view = null;
    this.pending = null;
    this.unverifiedSelection = false;
    this.lastRow = null;
    this.lastFilled = null;
    this.perform = null; // set by runSteps: notes run their steps through it
  }

  get handoffMs() { return Math.max(0, Math.min(this.handoffBudgetMs, this.deadline - Date.now())); }

  getCfg() { return (this.cfg ||= jev.jevKey()); }

  hasJevKey() {
    try { return Boolean(this.getCfg()?.key); } catch { return false; }
  }

  uncheckedExpectation() {
    if (!this.pending) return;
    const { row } = this.pending;
    row.unsure = true;
    row.unchecked = 'acted; expectation not checked (no TypeSafe key)';
    this.report.unsure = true;
    this.pending = null;
  }

  async timed(name, p) {
    const t = Date.now();
    try { return await p; } finally { this.phases[name] = (this.phases[name] || 0) + Date.now() - t; }
  }

  // What is on screen, and the short notices outside overlays.
  look() { return this.timed('read', ops.evaluate(this.conn, this.tab, page('page-state'))); }

  readPage() { return this.timed('read', ops.readPage(this.conn, this.tab, { maxText: 0, max: 1500, all: true })); }

  // Click by selector without scrolling when the element is already wholly in view.
  async clickSel(t) {
    const at = t.selector ? await ops.evaluate(this.conn, this.tab, page('in-view-point', { selector: t.selector })).catch(() => null) : null;
    return ops.click(this.conn, this.tab, { ...t, ...at });
  }

  async ask(state, questions) {
    if (this.showOn) await show.busy(this.conn, this.tab, true, 'Jev is choosing');
    const cfg = this.getCfg();
    if (!cfg.key) throw new Error('This judgment needs a TypeSafe API key. Exact names, refs and CSS selectors work without one.');
    if (Date.now() >= this.deadline) throw new Error('Run deadline reached');
    const r = await this.timed('jev', jev.systemOne(cfg, state, questions, { ...this.fetchOpts, timeoutMs: Math.max(1, Math.min(8000, this.deadline - Date.now())) }));
    this.report.jev_calls++;
    return r;
  }

  commitCtx(snap) {
    return { afterSearchFill: jev.searchField(this.lastFilled) || Boolean(snap?.elements?.some(e => e.role === 'searchbox' && e.value)) };
  }

  // A selector for the element to read its state by: its own, or a pin on the element behind
  // its ref (reading the page again renumbers the refs). null when it is gone.
  async pin(el) {
    return el.selector || await ops.evaluate(this.conn, this.tab, page('pin-ref', { ref: el.ref, key: pinKey() })).catch(() => null);
  }

  // A notice the page showed after a step (or after closing an overlay).
  notice(row, text) {
    const n = { type: 'notice', after_step: row.step, text };
    (row.events ||= []).push(n);
    this.report.events.push(n);
  }
}

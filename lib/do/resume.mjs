// Resuming a stopped plan: the steps from the failed one on, optionally with the failed step
// replaced, from a report (the printed resume line) or from the tab's trace (do --resume).
import * as trace from '../trace.mjs';
import { parsePlan } from './plan.mjs';
import { saysCommit } from '../commit.mjs';

// The plan's steps from the failed step on, or { why } when resuming is not safe: a step
// that acted and moved the page, blocks and loops, commits, or bindings made before the stop.
export function remainingSteps({ plan, step, acted = false, moved = false, replace = null }) {
  const index = Number(step) - 1;
  let nodes;
  try { nodes = parsePlan(plan); } catch (e) { return { why: `the plan no longer parses: ${e.message}` }; }
  if (!/^\d+$/.test(String(step)) || index < 0 || index >= nodes.length) return { why: 'the plan stopped inside a block or before its first step' };
  if (acted && moved && !replace) return { why: `step ${step} already acted and the page moved on` };
  const lines = [...(replace ? [replace] : []), ...nodes.slice(index + (replace || acted ? 1 : 0)).map(n => n.source)];
  if (!lines.length) return { why: 'no steps are left after the failed one' };
  let rest;
  try { rest = parsePlan(lines); } catch (e) {
    const unbound = /unknown variable \$(\w+)/.exec(e.message)?.[1];
    return { why: unbound ? `the rest uses $${unbound}, bound by an earlier step; run the whole plan again` : `the resumed steps do not parse: ${e.message}` };
  }
  if (rest.some(s => ['loop', 'branch', 'samePage', 'try', 'if'].includes(s.action))) return { why: 'the rest holds a block, loop or try; run the whole plan again' };
  // A replacement the caller typed may commit (it says so with !); the original rest may not.
  if (rest.slice(replace ? 1 : 0).some(s => s.commit || (['click', 'select'].includes(s.action) && saysCommit(s.target)))) return { why: 'the rest commits something; re-plan it explicitly' };
  return { lines };
}

// The failed step with another target: the closest controls Jev ranked, by exact name.
export function replacements(failed, candidates = []) {
  if (!failed || !['click', 'hover', 'fill', 'select', 'type'].includes(failed.action)) return [];
  const verb = `${failed.check ? 'check' : failed.action}${failed.commit ? '!' : ''}`;
  return candidates.filter(c => c.name && !/["\n]/.test(c.name)).slice(0, 2).map(c => ({
    step: `${verb} "${c.name}"${['fill', 'select'].includes(failed.action) ? ` = ${JSON.stringify(failed.value ?? '')}` : ''}${failed.expect ? ` => ${JSON.stringify(failed.expect)}` : ''}`,
    p: c.p,
  }));
}

// do <tab> --resume [--replace '<step>']: the last plan this tab ran, from its failed step.
export function resumeLines(tab, { replace = null } = {}) {
  const runs = trace.read(tab, { last: 20 }).filter(r => r.summary);
  const last = runs.at(-1);
  if (!last) throw new Error(`No finished do run in the trace of tab ${tab}`);
  if (last.summary.done) throw new Error(`The last plan on tab ${tab} finished; there is nothing to resume`);
  const step = last.summary.stopped_step;
  const row = last.steps.find(s => String(s.step) === String(step));
  const r = remainingSteps({ plan: last.summary.plan, step, acted: Boolean(row?.acted), moved: Boolean(row?.acted && row.url_before !== row.url_after), replace });
  if (r.why) throw new Error(`Cannot resume the plan that stopped at step ${step} ("${last.summary.stopped}"): ${r.why}`);
  return r.lines;
}

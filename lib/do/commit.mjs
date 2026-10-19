// The commit guard at the moment of a click: a control that can commit (Buy, Send, Place
// order…) is clicked only when the plan marks the step with ! and names it exactly; a Jev
// pick never commits. What counts as a commit is lib/commit.mjs: words in many languages, a
// checkout form's submit button, and a Jev yes/no for labels the words cannot judge.
import * as ops from '../ops.mjs';
import * as jev from '../jev.mjs';
import { commits, doubtful, commitQuestion, ORDER_ENTRY } from '../commit.mjs';
import { page } from '../page/index.mjs';
import { clip, prob } from './context.mjs';

const checkout = (ctx) => ops.evaluate(ctx.conn, ctx.tab, page('checkout-state')).catch(() => true);

// Does clicking el commit? Words first; a form's submit button asks whether the page is a
// checkout; a label in a script or page language the words do not cover asks Jev. Without
// Jev that doubt cannot be settled, so it counts as a commit (the plan can mark it or use
// its ref).
export async function committing(ctx, el, snap, row) {
  const c = { ...ctx.commitCtx(snap), lang: ctx.view?.lang };
  if (commits(el.name, el, c)) return true;
  if (el.submit && commits(el.name, el, { ...c, checkout: await checkout(ctx) })) return true;
  if (!doubtful(el.name, el, c)) return false;
  try {
    const r = await ctx.ask({ page: jev.viewState(ctx.view) }, { commits: commitQuestion(el) });
    row.commit_p = prob(r.answers.commits);
    return row.commit_p >= 0.5;
  } catch { row.commit_p = null; return true; }
}

// A ref or items id from the caller's own read is a deliberate choice, as the stop message
// below suggests; so is an entry button that only starts an order while the page holds no
// bag total or payment step. Returns a stop, or null to go on (row.committed when the plan
// marked the step and the control commits).
export async function commitGuard(ctx, step, row, el, snap, deliberate) {
  if (!['click', 'select', 'date'].includes(step.action) || deliberate) return null;
  const picked = /^jev/.test(row.how || '');
  // A Jev pick that the word lists flag was refused in grounding; one they cannot judge is
  // checked here, and a pick never commits.
  if (picked) {
    if (!doubtful(el.name, el, { ...ctx.commitCtx(snap), lang: ctx.view?.lang }) || !(await committing(ctx, el, snap, row))) return null;
    return { stop: { reason: `"${clip(el.name, 60)}" may commit something (p=${row.commit_p ?? '?'}); a committing step needs the control's exact name: re-plan with ${step.action}! "<its exact name>", or click it by ref` } };
  }
  if (!(await committing(ctx, el, snap, row))) return null;
  const entry = ORDER_ENTRY.test(el.name || '') && !(await checkout(ctx));
  if (entry) { row.how = `${row.how}, starts an order`; return null; }
  if (!step.commit) {
    const why = row.commit_p === null
      ? `browserctrl cannot tell whether "${clip(el.name, 60)}" commits something (labels in this language need a Jev check, and Jev is not set up or did not answer)`
      : `"${clip(el.name, 60)}" can commit something${row.commit_p != null ? ` (p=${row.commit_p})` : ''}`;
    return { stop: { reason: `${why}; to click it, mark the step: ${step.action}! "${clip(el.name, 60)}" (only after the user authorized it), or click it by ref` } };
  }
  row.committed = true;
  return null;
}

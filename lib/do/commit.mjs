// The commit guard: a control that can commit (Buy, Send, Place order…) is clicked only when
// the plan marks the step with ! and names it exactly; a Jev pick never commits. Typing,
// ticking a box and following a link commit nothing (jev.commits decides).
import * as ops from '../ops.mjs';
import * as jev from '../jev.mjs';
import { page } from '../page/index.mjs';
import { clip } from './context.mjs';

// A button that only opens an ordering or booking flow ("Order now", "Book now", "Reserve a
// table", "Start an order"): it commits nothing until the page is a checkout. The checkout is
// read from structure first (card fields, a payment provider's frame, an amount to pay), and
// from words only as a fallback (lib/page/checkout-state.js).
const ORDER_ENTRY = /^\s*((order|book|reserve|rent|hire)\s+(now|online|here|ahead|today|instantly|a table|a ride|a room|tickets?)|(start|begin|create|new)\s+(an?\s+|your\s+|a\s+new\s+|new\s+)*(order|booking|reservation|cart|basket))(\s+(at|from|for|with|in)\s.*)?\s*$/i;

// A ref or items id from the caller's own read is a deliberate choice, as the stop message
// below suggests; so is an entry button that only starts an order while the page holds no
// bag total or payment step. Returns a stop, or null to go on (row.committed when the plan
// marked the step and the control commits).
export async function commitGuard(ctx, step, row, el, snap, deliberate) {
  if (!['click', 'select', 'date'].includes(step.action) || deliberate || /^jev/.test(row.how || '') || !jev.commits(el.name, el, ctx.commitCtx(snap))) return null;
  const entry = ORDER_ENTRY.test(el.name || '') && !(await ops.evaluate(ctx.conn, ctx.tab, page('checkout-state')).catch(() => true));
  if (entry) { row.how = `${row.how}, starts an order`; return null; }
  if (!step.commit) return { stop: { reason: `"${clip(el.name, 60)}" can commit something; to click it, mark the step: ${step.action}! "${clip(el.name, 60)}" (only after the user authorized it), or click it by ref` } };
  row.committed = true;
  return null;
}

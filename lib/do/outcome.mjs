// What a step did: a box that should have toggled and did not, a section that did not open,
// a day the calendar does not show chosen, or a page that now shows an error stops the plan
// here instead of three steps later. Also the notices and address changes a step causes.
import * as ops from '../ops.mjs';
import { page } from '../page/index.mjs';
import { clip } from './context.mjs';
import { checkToggle, checkDisclosure } from './toggles.mjs';
import { checkDate } from './dates.mjs';

// Did the step do what it was for? Returns why not, or null.
export async function outcome(ctx, o, row) {
  if (!o) return null;
  if (o.toggle && o.toggle.before !== null) { const r = await checkToggle(ctx, o.toggle, row); if (r !== undefined) return r; }
  if (o.disclosure) { const r = await checkDisclosure(ctx, o.disclosure, row); if (r !== undefined) return r; }
  if (o.dateCheck) { const r = await checkDate(ctx, o.dateCheck, row); if (r) return r; }
  if (o.errBefore) {
    const err = newError(o.errBefore, await errorState(ctx));
    if (err) { row.error = err; return `The page shows an error after this step: ${err}`; }
  }
  return null;
}

// Signs that the page refused what the step sent: an "Error" title, an alert with error
// words, or a field marked invalid (lib/page/error-state.js).
export const errorState = (ctx) => ops.evaluate(ctx.conn, ctx.tab, page('error-state')).catch(() => null);

// An error the page shows after the step that it did not show before, said in one line, or
// null.
export function newError(before, after) {
  if (!after) return null;
  const was = before || { title: '', alerts: [], invalid: [] };
  const titled = /\berror\b/i.test(after.title) && !/\berror\b/i.test(was.title);
  const alerts = after.alerts.filter(a => !was.alerts.includes(a));
  const invalid = after.invalid.filter(f => !was.invalid.includes(f));
  if (!titled && !alerts.length && !invalid.length) return null;
  return [titled ? `title "${clip(after.title, 80)}"` : null, alerts.length ? `"${clip(alerts[0], 160)}"` : null, invalid.length ? `invalid field${invalid.length > 1 ? 's' : ''}: ${invalid.join(', ')}` : null].filter(Boolean).join('; ');
}

// How a step changed the address: "+state=closed -page". Path changes show the new path.
export function urlChange(before, after) {
  let a, b;
  try { a = new URL(before); b = new URL(after); } catch { return null; }
  if (a.href === b.href) return null;
  const out = [];
  const path = (u) => u.origin + u.pathname.replace(/\/+$/, '');
  if (path(a) !== path(b)) out.push(`→ ${b.origin === a.origin ? b.pathname : b.origin + b.pathname}`);
  for (const [k, v] of b.searchParams) if (a.searchParams.get(k) !== v) out.push(`+${k}=${v}`);
  for (const k of new Set(a.searchParams.keys())) if (!b.searchParams.has(k)) out.push(`-${k}`);
  return out.length ? out.join(' ').slice(0, 200) : null;
}

// Inline messages a step can cause without any notice container.
const NOTICE_WORDS = /\b(out of stock|sold out|unavailable|no longer available|price (has )?changed|did you mean|showing results for|voucher|coupon|added to (cart|bag|basket)|only \d+ left|limited stock|something went wrong|try again|failed)\b/i;

export function newNotices(before, after) {
  const had = new Set([...(before.notices || []), ...lines(before)]);
  const out = [];
  for (const t of after.notices || []) if (!had.has(t)) out.push(t);
  for (const l of lines(after)) if (!had.has(l) && l.length <= 200 && NOTICE_WORDS.test(l) && !out.some(o => o.includes(l) || l.includes(o))) out.push(l);
  return out.slice(0, 5);
}
const lines = (v) => `${v.overlay || ''}\n${v.view || ''}`.split('\n').map(s => s.trim()).filter(Boolean);

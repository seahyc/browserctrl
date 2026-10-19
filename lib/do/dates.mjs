// Date steps: the day cell for a date, paging the calendar's months toward it, and whether
// the page shows the day chosen after the click.
import * as ops from '../ops.mjs';
import { page } from '../page/index.mjs';
import { parseDateText, isoDate } from '../page/shared.mjs';
import { DATE, OUTCOME, sleep } from '../timing.mjs';
import { settle } from './wait.mjs';
import { clip, pinKey } from './context.mjs';

// A date step, or a click that names a whole date ("October 17, 2026"): the day it wants.
export const dateWanted = (step) => (step.action === 'date' ? step.target
  : step.action === 'click' && !step.ref && !step.item && !step.selector ? ((d) => (d ? isoDate(d) : null))(parseDateText(step.target)) : null);

// A calendar day: find the cell for the date, paging months (up to 12) toward it.
export async function findDate(ctx, iso) {
  const { conn, tab } = ctx;
  const pin = pinKey();
  let r, pages = 0, dir = null, waited = 0, opened = null;
  const tried = [];
  for (;;) {
    r = await ctx.timed('read', ops.evaluate(conn, tab, page('date-page', { iso, pin }))).catch(() => null);
    if (!r) return { reason: 'Could not read the calendar' };
    if (r.hit) break;
    if (!r.count && !pages && waited < DATE.DRAW) {
      // The picker the previous step opened may still be rendering: wait before giving up.
      await sleep(DATE.DRAW_POLL);
      waited += DATE.DRAW_POLL;
      continue;
    }
    if (!r.count && tried.length < 3) {
      // Still no calendar: open the likeliest date control (the previous click may have
      // closed a picker the page had already opened), then look again. The candidates are
      // ranked afresh on the current page each time (a click can redraw it), one that
      // showed no calendar is closed with Escape, and the next untried one is opened.
      if (tried.length) await ops.key(conn, tab, 'Escape').catch(() => {});
      const list = (await ops.evaluate(conn, tab, page('date-opener', { pin })).catch(() => null)) || [];
      const i = list.findIndex(o => !tried.includes(o.name));
      if (i >= 0) {
        tried.push(list[i].name);
        const ok = await ctx.timed('input', ctx.clickSel({ selector: `[data-bc-pin="${pin}-open-${i}"]` })).then(() => true, () => false);
        if (ok) await ctx.timed('settle', settle(conn, tab, 'picker'));
        opened = list[i].name;
        waited = DATE.DRAW - DATE.OPENED; // a short wait for the picker to draw
        continue;
      }
    }
    if (!r.count && tried.length && opened !== true) { await ops.key(conn, tab, 'Escape').catch(() => {}); opened = true; }
    if (!r.count) return { reason: `No calendar dates are on screen${tried.length ? ` (opening ${tried.map(n => `"${clip(n, 30)}"`).join(', ')} showed none)` : ''}; open the date picker first, then date ${iso}`, noCalendar: true };
    if (r.first && r.last && iso >= r.first && iso <= r.last) return { reason: `${iso} is between the dates shown (${r.first} to ${r.last}) but has no day cell of its own` };
    dir ||= r.first && iso < r.first ? 'prev' : 'next';
    if (pages >= DATE.MAX_MONTHS || !r.arrows[dir]) return { reason: `${iso} is not in the calendar (it shows ${r.first} to ${r.last}) and ${pages >= DATE.MAX_MONTHS ? `${DATE.MAX_MONTHS} months were paged` : `there is no ${dir === 'next' ? 'next' : 'previous'}-month control`}` };
    await ctx.timed('input', ctx.clickSel({ selector: `[data-bc-pin="${pin}-${dir}"]` }));
    pages++;
    await ctx.timed('settle', settle(conn, tab, 'picker'));
  }
  if (r.hit.disabled) return { reason: `${iso} is in the calendar but not available ("${clip(r.hit.label, 60)}")` };
  return { el: { ref: null, role: 'button', name: r.hit.label, selector: `[data-bc-pin="${pin}-day"]` }, how: `date${typeof opened === 'string' ? `, opened "${clip(opened, 40)}" first` : ''}${pages ? `, paged ${pages} month${pages > 1 ? 's' : ''}` : ''}` };
}

// Before the day is clicked: how it looks now, to tell afterwards whether the click took.
export async function dateBefore(ctx, el, iso) {
  return { selector: el.selector, iso, label: el.name, before: await ops.evaluate(ctx.conn, ctx.tab, page('date-look', { selector: el.selector, iso })).catch(() => null) };
}

// After: the calendar shows the day chosen, or a field or line of text shows the date.
// Returns why the step failed, or null.
export async function checkDate(ctx, c, row) {
  const shown = () => ops.evaluate(ctx.conn, ctx.tab, page('date-shown', { selector: c.selector, iso: c.iso, before: c.before || null })).catch(() => null);
  let r = await shown();
  // A picker that animates or fills its field a moment later: look once more.
  if (r && !r.shown) { await sleep(OUTCOME.DATE); r = await shown(); }
  if (r && !r.shown) return `Picked "${clip(c.label, 60)}" but the calendar doesn't show it selected and no date field shows ${c.iso}; the click did not take. Check the picker (it may need another control first), then re-plan`;
  if (r?.shown) row.date_shown = r.shown;
  return null;
}

// Toggles and disclosures: a click on a checkbox, radio, switch or pressed button should
// flip it, and a click on an accordion or expander should open or close it. Each state is
// read before the click (one already as the plan wants it is left alone) and after it. The
// sections this plan opened are remembered: a page that shows one at a time hides the
// others, so a later target may be behind one we opened ourselves.
import * as ops from '../ops.mjs';
import { page } from '../page/index.mjs';
import { OUTCOME, INPUT, sleep } from '../timing.mjs';
import { settle } from './wait.mjs';
import { norm, clip, describeEl } from './context.mjs';
import { urlChange } from './outcome.mjs';

const TOGGLE_ROLES = ['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'];
// After a late click, a failure says it was waited for: " after waiting 5 s for a click the page took late".
const lateNote = (row) => row.late_input ? ` after waiting ${INPUT.LATE_WAIT / 1000} s for a click the page ${row.late_input.unacknowledged ? 'never acknowledged' : 'took late'}` : '';

export const isToggle = (el) => TOGGLE_ROLES.includes(el.role) || (el.checked !== undefined && el.role !== 'option') || el.pressed !== undefined;

// Before a click: the toggle's or the disclosure's state, to check after it. Returns
// { toggle, disclosure } to check, or { result } when the click is left out because the
// control is already as the plan wants it.
export async function beforeClick(ctx, step, row, el, deliberate) {
  const { conn, tab } = ctx;
  const toggles = isToggle(el);
  if (step.check && !toggles) return { result: { stop: { reason: `check needs a checkbox, radio or switch; found ${describeEl(el)}` } } };
  let toggle = null, disclosure = null;
  if (toggles && step.action === 'click') {
    const sel = await ctx.pin(el);
    if (sel) toggle = { selector: sel, role: el.role, name: el.name, pressed: el.pressed !== undefined, before: await ops.evaluate(conn, tab, page('checked-state', { selector: sel })).catch(() => null) };
    // Pressed buttons can be filter chips whose click opens an editor. Only
    // check leaves those alone. Named checkbox/switch clicks keep the existing
    // idempotent guard (a repeated amenity choice should not remove it).
    if (toggle?.before === true && (step.check || (!deliberate && !toggle.pressed)) && !/radio/.test(el.role) && (step.check || !toggle.pressed || await ops.evaluate(conn, tab, page('disclosure-state', { selector: sel, visible: true })))) {
      Object.assign(row, { target: describeEl(el), el: { role: el.role, name: clip(el.name, 80), ref: el.ref }, checked: true, already: true, ...(toggle.pressed ? { pressed_kind: true } : {}) });
      row.how = `${row.how}, already on: not clicked`;
      return { result: {} };
    }
  }
  // A disclosure (accordion, expander) should change state; read it before the click.
  if (step.action === 'click' && !toggles) {
    const sel = await ctx.pin(el);
    const before = sel ? await ops.evaluate(conn, tab, page('disclosure-state', { selector: sel, visible: true })).catch(() => null) : null;
    if (before !== null) disclosure = { selector: sel, before };
    if (before === false) await ops.evaluate(conn, tab, page('disclosure-state', { selector: sel, watch: true })).catch(() => null);
    // A plan that clicks a section's heading and then something in it wants it open; one
    // already open would be shut by the click (a filter group left open by the last plan,
    // so its option vanished). Leave it, unless clicked by ref or it is the plan's last step.
    if (before === true && !deliberate && typeof row.step === 'number' && row.step < ctx.steps.length) {
      Object.assign(row, { target: describeEl(el), el: { role: el.role, name: clip(el.name, 80), ref: el.ref }, expanded: true, already: true });
      row.how = `${row.how}, not clicked: click it by ref to close it`;
      return { result: {} };
    }
  }
  return { toggle, disclosure };
}

// After the click: did the box take? Returns why it failed, null when the check ends without
// a failure, or undefined to go on with the other checks.
export async function checkToggle(ctx, t, row) {
  const { conn, tab } = ctx;
  // A filter's label carries a result count that changes when it applies ("Free
  // Breakfast (42)" redraws as "(38)"): match the control by its name without counts.
  const bare = (s) => norm(String(s || '').replace(/\(\s*[\d,.]+\s*\)|\b\d[\d,.]*\b/g, ' '));
  const state = async () => {
    let a = await ops.evaluate(conn, tab, page('checked-state', { selector: t.selector })).catch(() => null);
    if (a === null) { // re-rendered: the same control by role and name
      const snap = await ctx.readPage().catch(() => null);
      const same = (e) => e.role === t.role;
      // A page can draw the control twice (a desktop form and a drawer's copy, one hidden
      // or behind the drawer): judge by the copies a person can use, and any of those that
      // shows the choice.
      const usable = (e) => !e.hidden && !e.inert;
      const named = (snap?.elements || []).filter(e => same(e) && norm(e.name) === norm(t.name));
      const loose = named.length ? named : (snap?.elements || []).filter(e => same(e) && bare(e.name) && bare(e.name) === bare(t.name));
      const copies = loose.filter(usable).length ? loose.filter(usable) : loose;
      if (copies.length) a = copies.some(e => t.pressed ? e.pressed : e.checked);
    }
    return a;
  };
  const radio = /radio/.test(t.role);
  // Failed: a radio that is not chosen, or a box that was and stays unticked. A box that
  // was already ticked and stays ticked is the state the step asked for (a single-choice
  // group drawn as checkboxes keeps its choice when clicked again).
  const failed = (a) => a !== null && !a && (radio || !t.before);
  let after = await state();
  // Not yet: web components (ion-radio) set aria-checked a moment later, and a filter
  // list is often redrawn unticked until its results arrive (Booking). Let the page
  // settle, then read again for up to 2 s before calling the click a failure; up to 5 s when
  // the page took the click late (row.late_input: it is busy, and the click may still be landing).
  for (const t0 = Date.now(), wait = row.late_input ? INPUT.LATE_WAIT : OUTCOME.TOGGLE; failed(after) && Date.now() - t0 < wait;) {
    await ctx.timed('settle', settle(conn, tab, 'reground'));
    await sleep(OUTCOME.TOGGLE_POLL);
    after = await state();
  }
  // The page took the choice into its address (a sort or filter that reloads its results
  // from the server and redraws the form unticked until they arrive): the click did
  // something, so it is not "did not take", only not readable yet.
  const moved = failed(after) && (await ops.evaluate(conn, tab, 'location.href').catch(() => null)) !== row.url_before && urlChange(row.url_before, await ops.evaluate(conn, tab, 'location.href').catch(() => row.url_before));
  // The check ends there, not failed.
  if (moved) { row.checked = undefined; row.how = `${row.how}, the page put the choice in its address (not shown ticked yet)`; return null; }
  if (after !== null) {
    row.checked = after;
    if (t.pressed) row.pressed_kind = true;
    if (!radio && t.before && after) row.already = true;
    if (failed(after)) return `Clicked ${row.target}, but it is still ${t.pressed ? 'not pressed' : 'unchecked'}${lateNote(row)}; the click did not take. Try its label or a nearby control, then re-plan`;
  }
}

// After the click: did the section open (or close)? Same returns as checkToggle.
export async function checkDisclosure(ctx, d, row) {
  const { conn, tab } = ctx;
  const now = (o = {}) => ops.evaluate(conn, tab, page('disclosure-state', { selector: d.selector, visible: true, ...o })).catch(() => null);
  // Read again until it shows open or the time is up; bounded by the clock, not by reads.
  const until = async (ms) => {
    let v = await now();
    for (const t0 = Date.now(); v === false && Date.now() - t0 < ms;) { await sleep(OUTCOME.TOGGLE_POLL / 2); v = await now(); }
    return v;
  };
  let after = await now();
  // Did it open at some moment since before the click, and is it shut again now? (A flyout
  // that opens under the pointer and shuts on the click that follows: IMDb's language menu.)
  const seen = d.before ? null : await now({ seen: true });
  const shutAgain = after === false && seen && await now({ visible: false }) === false;
  if (shutAgain) {
    // Open it the way a person does, by resting the pointer on it: off the page, then back.
    const at = await ops.evaluate(conn, tab, page('in-view-point', { selector: d.selector })).catch(() => null);
    await ops.hover(conn, tab, { x: -1, y: -1 }).catch(() => {});
    await ops.hover(conn, tab, at?.x != null ? at : { selector: d.selector }).catch(() => {});
    after = await until(OUTCOME.DISCLOSURE * 2);
    if (after) row.how = `${row.how}, it opens on hover and the click shut it: left the pointer over it`;
  } else if (after === false && !d.before) {
    // A panel can be drawn a moment after the click (Carnival's filter modal, rendered into
    // a portal): keep looking for a short while before calling it shut; longer when the page
    // took the click late.
    after = await until(row.late_input ? INPUT.LATE_WAIT : OUTCOME.DISCLOSURE * 3);
  }
  // Some components ignore a pointer click on their control (a design-system accordion
  // whose heading is drawn over it); activating the control itself does what a person's
  // click does. Done once, and reported. Never on a control that already says it is open:
  // its panel is somewhere this check does not see, and a second click would shut it.
  const says = after === d.before ? await now({ visible: false }) : null;
  if (after === d.before && says === d.before && !seen) {
    await ops.evaluate(conn, tab, page('disclosure-state', { selector: d.selector, activate: true })).catch(() => null);
    await ctx.timed('settle', settle(conn, tab, 'section'));
    after = await now();
    if (after !== null && after !== d.before) row.how = `${row.how}, activated directly: the page ignored the pointer click`;
  }
  if (after !== null) {
    row.expanded = after;
    // Open before and still open (a flyout held open by the pointer): plans click headings
    // to open them, so that is the state they want; say so rather than stop.
    if (after === d.before && d.before) { row.how = `${row.how}, it stays open`; return null; }
    if (after === d.before) {
      const why = says && !d.before ? 'it says it is open (aria-expanded) but no panel showed'
        : seen ? 'it opened under the pointer and closed again, also when hovered'
        : 'it stayed collapsed, also when activated directly';
      return `Clicked ${row.target}, but it did not open: ${why}${lateNote(row)}; re-plan (hover it, its heading, a nearby control, or a nav step)`;
    }
    if (after) ctx.openedHere.push({ selector: d.selector, target: row.target });
    else for (let i = ctx.openedHere.length - 1; i >= 0; i--) if (ctx.openedHere[i].selector === d.selector) ctx.openedHere.splice(i, 1);
  }
}

// Not found, and this plan opened a section earlier: pages that show one section at a time
// (filter drawers) hide the rest while it is open. Close it, which only undoes our own step,
// and look again, once. true when it was closed (ground the step again).
export async function closeOpenedSection(ctx, step, row) {
  if (row.closedOpen || !ctx.openedHere.length || step.action !== 'click') return false;
  const last = ctx.openedHere.pop();
  row.closedOpen = last.target;
  await ctx.timed('input', ctx.clickSel({ selector: last.selector })).catch(() => {});
  await ctx.timed('settle', settle(ctx.conn, ctx.tab, 'section'));
  return true;
}

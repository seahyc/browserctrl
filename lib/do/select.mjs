// select on a custom combobox or listbox with no native <select>: do what a person does, open
// it and click the option with that name (the list may render anywhere: a portal, a shadow
// root), then check the control shows it, and use the keyboard when the click missed.
import * as ops from '../ops.mjs';
import { page } from '../page/index.mjs';
import { STEP, sleep } from '../timing.mjs';
import { settle } from './wait.mjs';
import { norm, clip, describeEl } from './context.mjs';

// The keyboard walks a list at most this many options down.
const WALK_MAX = 80;

// t: the control as ops takes it (ref and token, or selector). Throws when no option of that
// name opens, or the control does not show it afterwards.
export async function pickFromList(ctx, step, row, el, t) {
  const { conn, tab } = ctx;
  // Pin the control first: reading the open list renumbers the page's refs.
  const ctlSel = await ctx.pin(el);
  await ctx.timed('input', ctx.clickSel(t));
  await ctx.timed('settle', settle(conn, tab, 'section'));
  const opts = await ctx.readPage();
  const want = norm(step.value);
  const roles = /^(option|menuitem|menuitemradio|treeitem|listitem|radio|checkbox|button|link|clickable)$/;
  // Visible options only, and those that appeared when the control opened first: a page
  // can keep other lists' options in the DOM (a "Max" list beside the "Min" one).
  const shown = opts.elements.filter(x => roles.test(x.role) && x.ref !== el.ref && !x.hidden && !x.inert);
  const cands = shown.filter(x => x.new).concat(shown.filter(x => !x.new));
  const opt = cands.find(x => /^(option|menuitem|menuitemradio|treeitem)$/.test(x.role) && norm(x.name) === want)
    || cands.find(x => norm(x.name) === want)
    || cands.find(x => /^(option|menuitem|menuitemradio|treeitem)$/.test(x.role) && norm(x.name).startsWith(want));
  if (!opt) {
    const seen = cands.filter(x => /^(option|menuitem|menuitemradio|treeitem)$/.test(x.role)).map(x => x.name).slice(0, 15);
    throw new Error(`Opened ${describeEl(el)}, but it lists no option "${step.value}"${seen.length ? `; options: ${seen.join(' | ')}` : ''}`);
  }
  await ctx.timed('input', ops.click(conn, tab, { ref: opt.ref, token: opts.token }));
  row.how = `${row.how}, opened it and picked ${describeEl(opt)}`;
  await ctx.timed('settle', settle(conn, tab, 'section'));
  // The control should now show the choice (its text, value or a shadow-root display).
  // A click on an option can miss when the list moves as it opens; the keyboard is
  // the combobox pattern's own way in: open it, type to jump, or walk with ArrowDown,
  // then Enter. Checked the same way.
  const showsNow = async () => (!ctlSel ? null : ops.evaluate(conn, tab, page('control-shows', { selector: ctlSel })).catch(() => null));
  const shows = await showsNow();
  let seen = shows;
  if (seen !== null && !norm(seen).includes(want) && ctlSel) {
    const active = page('active-option', { selector: ctlSel });
    const open = async () => { await ctx.clickSel({ selector: ctlSel }).catch(() => {}); await sleep(STEP.LIST_OPEN); };
    await open();
    await ops.type(conn, tab, String(step.value)).catch(() => {});
    // Enter only if typing highlighted the option; otherwise close the list unchanged.
    const typed = await ops.evaluate(conn, tab, active).catch(() => null);
    await ops.key(conn, tab, typed !== null && norm(typed) === want ? 'Enter' : 'Escape').catch(() => {});
    await ctx.timed('settle', settle(conn, tab, 'keyed'));
    seen = await showsNow();
    if (seen !== null && !norm(seen).includes(want)) {
      await open();
      // Walk only a list whose highlight can be read: blind ArrowDowns change the value
      // without knowing to what (a Min. Year list walked to its last year, 1950).
      let found = false;
      for (let k = 0; k < WALK_MAX; k++) {
        await ops.key(conn, tab, 'ArrowDown').catch(() => {});
        const a = await ops.evaluate(conn, tab, active).catch(() => null);
        if (a === null) break;
        if (norm(a) === want) { found = true; break; }
      }
      await ops.key(conn, tab, found ? 'Enter' : 'Escape').catch(() => {});
      await ctx.timed('settle', settle(conn, tab, 'keyed'));
      seen = await showsNow();
    }
    if (seen !== null && norm(seen).includes(want)) row.how = `${row.how}; the click missed, picked with the keyboard`;
  }
  if (seen !== null && !norm(seen).includes(want)) throw new Error(`Picked ${describeEl(opt)} in ${describeEl(el)}, but the control does not show it (it shows "${clip(seen, 60)}"); re-plan`);
}

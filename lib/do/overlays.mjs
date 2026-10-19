// Overlays during a plan: is a dialog or popup blocking the page, is the step's target inside
// it, and closing it when the plan listed its kind (--dismiss).
import * as ops from '../ops.mjs';
import * as jev from '../jev.mjs';
import { page } from '../page/index.mjs';
import { settle } from './wait.mjs';
import { clip, noul, describeEl } from './context.mjs';
import { newNotices } from './outcome.mjs';

// Controls that are fine for closing an overlay. Anything that commits, signs up, installs
// or buys is never offered; links only when they read as "close" or "not now".
const DISMISS_UNSAFE = /\b(subscribe|sign ?up|register|join|upgrade|start (a |your )?(free )?trial|get (the )?app|open (in )?(the )?app|install|download|allow|enable|continue|buy|pay|order|add to (cart|bag|basket)|claim|redeem|shop now|learn more|settings|preferences|customi[sz]e|manage)\b/i;
const CLOSE_WORDS = /^(close|dismiss|no,? thanks|not now|maybe later|later|skip|×|✕|x)$/i;
// What closes a notice or coachmark without choosing anything.
export const DISMISS_WORDS = /^(got it|ok|okay|close|dismiss|done|no,? thanks|not now|maybe later|later|skip|understood|×|✕|x)$/i;
const NOT_CLICKY = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'select', 'listbox', 'checkbox', 'radio', 'file', 'switch', 'option']);
export const safeToDismiss = (e) => !e.disabled && !e.hidden && !NOT_CLICKY.has(e.role) && (e.name || '').trim() &&
  !jev.commits(e.name, e) && !DISMISS_UNSAFE.test(e.name) && (e.role !== 'link' || CLOSE_WORDS.test(e.name.trim()));

export const blockerQuestion = (next) => noul(
  `Is a dialog, overlay or popup (for example a cookie banner, sign-up or newsletter prompt, app-install prompt) covering the page and blocking it? ` +
  `Answer no when the dialog or panel is what the next step${next ? ` ("${next}")` : ''} works in, and no for small toasts or banners that leave the page usable.`);

// Is the element inside the open dialog or overlay (so acting on it is not blocked by it)?
export async function inOverlay(ctx, el, snap) {
  if (snap?.modal && el.ref && !el.inert) return true;
  if (el.ref) return (await ops.evaluate(ctx.conn, ctx.tab, page('overlay-refs')).catch(() => [])).includes(el.ref);
  if (!el.selector) return false;
  return ops.evaluate(ctx.conn, ctx.tab, page('in-overlay', { selector: el.selector })).catch(() => false);
}

// A blocking overlay: dismiss it when its kind is listed, else stop with its text and
// controls. One Jev request picks the kind and the closing control together.
export async function dismissOverlay(ctx, row) {
  const { conn, tab, categories, report } = ctx;
  const snap = await ctx.readPage();
  const inside = new Set(await ops.evaluate(conn, tab, page('overlay-refs')).catch(() => []));
  const controls = snap.elements.filter(e => inside.has(e.ref) && !e.hidden);
  const safe = controls.filter(safeToDismiss);
  const text = clip(ctx.view.overlay, 400);
  const blocked = (reason, extra = {}) => ({
    reason, overlay: text, controls: controls.map(describeEl).slice(0, 15), ...extra,
  });
  if (!categories.length) return { stop: blocked('A dialog or popup is blocking the page; dismiss it (or pass --dismiss "<kinds>") and re-plan') };
  const criteria = Object.fromEntries(categories.map((c, i) => [`c${i + 1}`, c]));
  criteria.other = 'Something else: none of the listed kinds';
  const questions = { category: { type: 'choice', instructions: 'Which kind of overlay is covering the page?', criteria } };
  const cq = safe.length ? jev.targetQuestion({ elements: safe }, { intent: 'close or dismiss this overlay without agreeing to buy, subscribe, sign up or install anything', action: 'click' }) : null;
  if (cq?.question) questions.control = cq.question;
  let r;
  try { r = await ctx.ask({ page: jev.viewState(ctx.view), task: 'close a popup that blocks the page' }, questions); }
  catch (e) { return { stop: blocked(e.message) }; }
  const cat = r.answers.category;
  const kind = cat?.choice && cat.choice !== 'other' && cat.choice in criteria ? criteria[cat.choice] : null;
  const kindP = cat?.probabilities?.[cat?.choice];
  if (!kind || (kindP ?? 0) < 0.5) return { stop: blocked(`An overlay that is not one of the listed kinds (${categories.join(', ')}) is blocking the page`) };
  const pick = cq?.question ? jev.readTarget(r.answers.control, cq.cands) : { pick: null };
  if (!pick.pick || (pick.p ?? 0) < ctx.minP) return { stop: blocked(`A ${kind} is blocking the page and no safe control closes it`, { category: kind }) };
  await ops.click(conn, tab, { ref: pick.pick.ref, token: snap.token });
  await settle(conn, tab, 'dismiss');
  const ev = { type: 'dismissed', after_step: ctx.lastRow?.step ?? 0, category: kind, text: clip(text, 200), control: describeEl(pick.pick), p: pick.p };
  (row.dismissed ||= []).push(ev);
  report.events.push(ev);
  const before = ctx.view;
  ctx.view = await ctx.look();
  if (clip(ctx.view.overlay, 400) && clip(ctx.view.overlay, 400) === text) return { stop: blocked(`The ${kind} stayed after clicking ${describeEl(pick.pick)}`) };
  for (const t of newNotices(before, ctx.view)) ctx.notice(row, t);
  return {};
}

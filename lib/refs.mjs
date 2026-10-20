// read_page: a compact snapshot of what a page offers, with stable refs.
//
// This is the single biggest usability difference between raw CDP and the
// Claude-in-Chrome style of driving a browser. Instead of guessing CSS
// selectors or pixel coordinates, you read the page once, get ref_1..ref_N for
// the interactive elements, and act on those refs. Refs live on the page in
// window.__cdp and are invalidated by navigation, which we detect rather than
// silently clicking the wrong thing.

// The snapshot runs in the page (lib/page/snapshot.js). Keep it dependency-free and
// defensive: it runs on arbitrary sites.
//
// Beyond listing controls, the snapshot applies the page-reading techniques of Browser
// Use's serializer, adapted to a live-DOM read:
// - a card that is one big link is one row: descendants that sit inside a link or
//   button and carry no action of their own are folded into it;
// - elements another element covers are marked (not dropped), and when a modal is open
//   everything outside it is inert and its controls come first;
// - every element keeps a stable id across reads of the same document, and rows not seen
//   by an earlier read are marked new;
// - page stats, loading signals and how much page lies above and below;
// - same-origin iframes are read in (with offsets so refs click the right point);
// - by default only elements within about one screen of the viewport are listed.
import { page } from './page/index.mjs';

// The page's text as a person reads it, shadow roots included (lib/page/shared.mjs deepText).
export function deepTextExpression() {
  return page('deep-text');
}

// A cheap look at whether the page is still loading, for settle() (lib/page/loading.js).
export const LOADING_EXPR = page('loading');

export function snapshotExpression(opts = {}) {
  return page('snapshot', opts);
}

// A JS expression for the element behind a ref (ref_N, or a stable eN id) in the
// snapshot with this token (the latest snapshot without one), or an error code string.
export function refLookupExpression(ref, token) {
  return page('ref-lookup', { ref: String(ref || ''), token: token || null });
}

// A page-side lookup by CSS selector that also searches open shadow roots, for elements
// browserctrl pinned (data-bc-pin) or a caller named inside web components:
// document.querySelector stops at every shadow boundary.
export function deepQuery(selector) {
  return page('find-deep', { selector });
}

// Resolve a ref back to its element and return what an action needs: the
// center point in CSS pixels, plus whether it is still on the same page.
export function resolveRefExpression(ref, token) {
  return page('resolve-element', { ref: String(ref || ''), token: token || null });
}

// The same for a CSS selector (open shadow roots are searched; a pinned data-bc-pin works).
// A selector click gets the same checks as a ref click: scroll only when out of view, and
// refuse a point that something else covers (a panel's footer over the last list row).
export function resolveSelectorExpression(selector) {
  return page('resolve-element', { selector });
}

// The `read` text view: header with scroll position, page stats and loading or modal
// notes, then one line per element. `*` marks elements new since the previous read.
export function formatRead(snap) {
  const s = snap.stats || {};
  const sc = snap.scroll || {};
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const head = [
    snap.title,
    snap.url,
    `token: ${snap.token}   scroll ${sc.y}/${sc.h}` + (sc.above !== undefined ? ` · ${sc.above} screens above, ${sc.below} below` : ''),
  ];
  if (snap.stats) {
    const bits = [`${s.interactive} interactive`, plural(s.links, 'link')];
    if (s.iframes) bits.push(plural(s.iframes, 'iframe') + (s.crossOrigin?.length ? ` (cross-origin: ${[...new Set(s.crossOrigin)].join(', ')})` : ''));
    if (s.shadowRoots) bits.push(plural(s.shadowRoots, 'shadow root'));
    bits.push(`${s.total} elements`);
    if (s.folded) bits.push(`${s.folded} folded into their card`);
    head.push(`stats: ${bits.join(' · ')}`);
  }
  if (snap.waitNote) head.push(`wait: ${snap.waitNote}`);
  if (snap.loading) head.push(`loading: ${snap.loading}`);
  if (snap.modal) head.push(`modal open: ${snap.modal.role}${snap.modal.name ? ` "${snap.modal.name}"` : ''}; its controls come first, everything else is inert`);
  const lines = snap.elements.map(e => {
    const flags = [];
    if (e.testid) flags.push(`[${e.testid}]`);
    if (e.disabled) flags.push('(disabled)');
    if (e.expanded !== undefined) flags.push(e.expanded ? '(expanded)' : '(collapsed)');
    if (e.checked) flags.push('(checked)');
    if (e.pressed !== undefined) flags.push(e.pressed ? '(pressed)' : '(not pressed)');
    if (e.nameFrom === 'context') flags.push('(named from its row)');
    if (e.popup) flags.push('(open list)');
    if (e.covered) flags.push(`(covered by ${e.covered}${e.coverPinned ? ', a pinned bar: a click scrolls it clear' : ''})`);
    if (e.inert && !e.covered) flags.push('(inert)');
    if (e.offscreen) flags.push(`(${e.offscreen})`);
    if (e.frame) flags.push('(in frame)');
    const ref = `${e.new ? '*' : ' '}${e.ref}`;
    return `${ref.padEnd(9)} ${(e.id || '').padEnd(5)} ${e.role.padEnd(10)} ${(e.name || '').slice(0, 60).padEnd(60)}${flags.length ? ` ${flags.join(' ')}` : ''}`.trimEnd();
  });
  const o = snap.omitted;
  if (o?.total) {
    const where = [o.above ? `${o.above} above` : '', o.below ? `${o.below} below` : '', o.overLimit ? `${o.overLimit} over --max` : ''].filter(Boolean).join(', ');
    const how = [o.above || o.below ? '--all lists the whole page' : '', o.overLimit ? '--max raises the limit' : ''].filter(Boolean).join(', ');
    lines.push(`(${plural(o.total, 'more element')} not listed: ${where}; ${how})`);
  }
  return `${head.join('\n')}\n\n${lines.join('\n')}\n\n--- text${snap.textTruncated ? ` (truncated from ${snap.textLength})` : ''} ---\n${snap.text}`;
}

export const REF_ERRORS = {
  no_snapshot: 'No snapshot on this page. Run `browserctrl read <tab>` first, then use the refs it prints.',
  stale: 'The refs you are using are from an older snapshot of this page that it no longer keeps (it was re-read many times or reloaded). Re-run `browserctrl read <tab>` and use the new refs.',
  navigated: 'The page navigated since the snapshot was taken and that element is gone. Re-run `browserctrl read <tab>`.',
  unknown_ref: 'No such ref in the current snapshot. Re-run `browserctrl read <tab>` to see valid refs.',
  detached: 'That element has been removed from the page since the snapshot. Re-run `browserctrl read <tab>`.',
  frame_replaced: 'That element was in a frame that has loaded a new page since the snapshot. Re-run `browserctrl read <tab>` and use the new refs.',
  internal: 'That element belongs to Chrome CDP’s annotation UI, not the web page. Re-run `browserctrl read <tab>` and choose a page ref.',
  covered: 'Another element covers that one, so a click would land on it instead. Click the picker’s own Close/Done control if present, or use `browserctrl key <tab> Escape` (warning: Escape may close an enclosing dialog). Re-run `browserctrl read <tab>` to inspect it.',
};


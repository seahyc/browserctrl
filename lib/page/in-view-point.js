// The centre of an element that is wholly in view, or null. A click by selector scrolls the
// element to the middle of the screen first, and some pages close an open panel on any
// scroll (Airbnb's date picker shut, unchanged, when a day cell was clicked that way).
({ selector }) => {
  const el = findDeep(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect(), visible = visibleRect(el);
  if (visible.width < r.width || visible.height < r.height) return null;
  if (r.width < 1 || r.height < 1 || r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) return null;
  const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  // In view but under a pinned bar (a dialog's sticky footer): not a point to click.
  const root = el.getRootNode && el.getRootNode().elementFromPoint ? el.getRootNode() : document;
  const hit = root.elementFromPoint(x, y);
  if (!hit || !el.contains(hit)) return null;
  return { x, y };
}

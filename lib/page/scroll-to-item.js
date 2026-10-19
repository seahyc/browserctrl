// Scroll an items id's element to near the top of the screen (under any sticky header).
({ id }) => {
  const ids = window.__bcItems && window.__bcItems.ids;
  if (!ids) return false;
  let el = null;
  for (const n of document.querySelectorAll('body *')) if (ids.get(n) === id) { el = n; break; }
  if (!el) return false;
  el.scrollIntoView({ block: 'start', behavior: 'instant' });
  scrollBy(0, -Math.min(160, innerHeight * 0.2));
  return true;
}

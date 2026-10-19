// How long the page has been quiet, how old the watch is, its load state, whether a request
// that started since the watch began (or just before it) is still open, and whether the page
// has started to navigate away (how long ago, or null).
({ beforeStep }) => {
  const st = window.__bcSettle; if (!st) return null;
  const now = Date.now();
  return { quiet: now - st.last, age: now - st.start, ready: document.readyState, busy: !!(window.__bcNet && window.__bcNet.busy(st.start - beforeStep)), leaving: window.__bcLeaving && window.__bcLeaving.at ? now - window.__bcLeaving.at : null };
}

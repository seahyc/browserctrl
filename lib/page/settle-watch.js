// The page records when it last changed; the polling happens from the CLI, because timers
// inside a background tab are throttled (to once a second or once a minute).
({ longPoll }) => {
  bcNetWatch(longPoll);
  const old = window.__bcSettle; if (old && old.mo) old.mo.disconnect();
  const st = window.__bcSettle = { last: Date.now(), start: Date.now() };
  // Changes to browserctrl's own overlay (--show cursor, labels, ticking panel) are not the page.
  const ours = (n) => { const e = n && (n.nodeType === 1 ? n : n.parentElement); return !!(e && e.closest && e.closest('[data-cdp]')); };
  // A style-only change is an animation or a transition (carousels, tickers rewrite it many times a
  // second); results arriving add or remove nodes, change text, or change classes.
  // A node that keeps changing (a carousel's slides trading an "active" class, a countdown, a
  // ticker) is animating, not loading: after its third change it no longer holds the wait.
  const seen = new WeakMap();
  const repeating = (n) => { const c = (seen.get(n) || 0) + 1; seen.set(n, c); return c > 3; };
  st.mo = new MutationObserver((recs) => {
    if (recs.some(r => !(r.type === 'attributes' && r.attributeName === 'style') && !ours(r.target) && !(r.addedNodes.length && [...r.addedNodes].every(ours)) && !(r.removedNodes.length && [...r.removedNodes].every(x => x.nodeType === 1 && x.hasAttribute && x.hasAttribute('data-cdp'))) && !repeating(r.target))) st.last = Date.now();
  });
  st.mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  return true;
}

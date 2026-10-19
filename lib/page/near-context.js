// The heading or label of the row each element sits in: two "Edit" buttons differ by
// whether they sit under "Start time" or "End time".
({ refs }) => {
  const els = (window.__cdp && window.__cdp.els) || [];
  const out = {};
  for (const ref of refs) {
    const el = els[parseInt(ref.replace('ref_', ''), 10) - 1];
    if (!el || !el.isConnected) continue;
    const own = (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    for (let n = el.parentElement, i = 0; n && n !== document.body && i < 5; n = n.parentElement, i++) {
      const line = (n.innerText || '').split(/\n+/).map(t => t.replace(/\s+/g, ' ').trim()).find(t => t && t !== own && /[A-Za-z]{2}/.test(t) && t.length <= 60);
      if (line) { out[ref] = line; break; }
    }
  }
  return out;
}

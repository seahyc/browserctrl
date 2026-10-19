// Which refs of the last snapshot sit inside an overlay (same rule as viewText's overlay).
() => {
  const els = (window.__cdp && window.__cdp.els) || [];
  return els.map((el, i) => el && el.isConnected && inOverlay(el) ? 'ref_' + (i + 1) : null).filter(Boolean);
}

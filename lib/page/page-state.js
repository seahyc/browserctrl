// What is on screen (viewText) plus short notices outside overlays: alerts, status and
// live regions, toasts and banners. Bounded: at most 20 notices of 200 characters.
() => {
  const v = viewText();
  const sel = '[role=alert],[role=status],[aria-live]:not([aria-live=off]),[class*=toast i],[class*=snackbar i],[class*=notice i],[class*=notification i],[class*=alert i],[class*=banner i],[class*=flash i]';
  const taken = [], notices = [];
  const nodes = document.querySelectorAll(sel);
  for (let i = 0; i < nodes.length && i < 300 && notices.length < 20; i++) {
    const el = nodes[i];
    if (taken.some(t => t.contains(el)) || el.closest('[data-cdp]')) continue;
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity || '1') < 0.05) continue;
    if (inOverlay(el)) continue;
    const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 300) continue;
    taken.push(el);
    if (!notices.includes(t.slice(0, 200))) notices.push(t.slice(0, 200));
  }
  v.notices = notices;
  return v;
}

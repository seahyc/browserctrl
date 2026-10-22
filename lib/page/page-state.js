// What is on screen (viewText) plus short notices outside overlays: alerts, status and
// live regions and messages that changed in place. Bounded: at most 20 notices of 200 characters.
() => {
  const v = viewText();
  const sel = '[role=alert],[role=status],[aria-live]:not([aria-live=off]),[class*=toast i],[class*=snackbar i],[class*=notice i],[class*=notification i],[class*=alert i],[class*=banner i],[class*=flash i]';
  const semantic = '[role=alert],[role=status],[aria-live]:not([aria-live=off])';
  const taken = [], notices = [], liveNotices = [];
  const nodes = document.querySelectorAll(sel);
  for (let i = 0; i < nodes.length && i < 300 && notices.length < 20; i++) {
    const el = nodes[i];
    if ((taken.some(t => t.contains(el)) && !el.matches(semantic)) || el.closest('[data-cdp]') || el.matches('button,input,select,textarea,a[href],[role=button],[role=link]')) continue;
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity || '1') < 0.05) continue;
    if (inOverlay(el)) continue;
    const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 300) continue;
    const controls = Array.from(el.querySelectorAll('button,input,select,textarea,[role=button]'));
    if (controls.some(c => (c.innerText || '').replace(/\s+/g, ' ').trim() === t)) continue;
    // Live regions also announce player controls and cart counters. They are not
    // outcomes of the plan; keep short complete messages such as 'Added to bag'.
    if (t.length < 4 || !/[\p{L}]/u.test(t)) continue;
    if (/^(?:volume(?:\s|:)|(?:loading|playing|skip|close)\s+(?:an?\s+)?ad(?:vertisement)?\b|advertisement$|\d+(?:\.\d+)?\s*(?:seconds?|minutes?)\s+(?:of|remaining)\b|(?:play|pause|mute|unmute|buffering)(?:\s+video)?$)/i.test(t)) continue;
    taken.push(el);
    if (!notices.includes(t.slice(0, 200))) notices.push(t.slice(0, 200));
    if (el.matches(semantic)) liveNotices.push(t.slice(0, 200));
  }
  v.notices = notices;
  v.liveNotices = liveNotices;
  return v;
}

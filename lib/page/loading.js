// A cheap look at whether the page is still loading, for settle(): the document's ready
// state and the marked placeholders the snapshot counts (aria-busy, skeleton, shimmer,
// spinner and loading classes, a visible progressbar), plus a signature that changes
// while the page is still filling in.
() => {
  var vh = innerHeight, marked = 0, bars = 0, busy = 0, buttons = 0, why = [];
  var els = document.body ? document.body.getElementsByTagName('*') : [];
  for (var i = 0; i < els.length && i < 20000; i++) {
    var n = els[i];
    if (n.closest && n.closest('[data-cdp],[data-cdp-internal]')) continue;
    var cls = typeof n.className === 'string' ? n.className : (n.getAttribute('class') || '');
    var bar = n.getAttribute('role') === 'progressbar' || n.tagName === 'PROGRESS';
    if (!(n.getAttribute('aria-busy') === 'true' || bar || /skeleton|shimmer|placeholder|loading|loader|spinner/i.test(cls))) continue;
    if (n.parentElement && n.parentElement.closest('[aria-busy=true],[class*=skeleton],[class*=shimmer],[role=progressbar],[class*=--loading],[class*=is-loading]')) continue;
    // A button in its loading state (a BEM "--loading" or "is-loading" class, or aria-busy)
    // means the action it started has not answered yet; one is enough.
    var btn = /^(BUTTON|A)$/.test(n.tagName) || n.getAttribute('role') === 'button';
    var r = n.getBoundingClientRect();
    // Only placeholders on screen count: lazy content below the fold may never load in a
    // background tab, and is not what the next step reads.
    if (r.width < 4 || r.height < 4 || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= innerWidth) continue;
    var s = getComputedStyle(n);
    if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity || '1') < 0.05) continue;
    // ...and only ones a person can see: sites leave loaded cards' skeletons in the page
    // under the real content.
    var hx = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), hy = Math.min(vh - 1, Math.max(0, r.top + Math.min(r.height / 2, vh / 2)));
    var hit = document.elementFromPoint(hx, hy);
    if (hit && hit !== n && !n.contains(hit) && !hit.contains(n)) continue;
    if (bar) bars++; else if (n.getAttribute('aria-busy') === 'true') busy++; else if (btn && /(^|[-_\s])(is-)?loading\b|--loading/i.test(cls)) buttons++; else marked++;
  }
  if (document.readyState !== 'complete') why.push('readyState ' + document.readyState);
  if (busy) why.push(busy + ' section' + (busy > 1 ? 's' : '') + ' marked busy');
  if (marked >= 2) why.push(marked + ' skeleton or spinner placeholders');
  if (bars) why.push(bars + ' progress indicator' + (bars > 1 ? 's' : ''));
  if (buttons) why.push(buttons + ' button' + (buttons > 1 ? 's' : '') + ' still loading');
  var len = document.body ? (document.body.innerText || '').length : 0;
  // visual: something a person would see as still loading; readyState alone is not (a
  // tracking pixel that never answers keeps some pages "interactive" forever).
  return { ready: document.readyState, marked: marked, bars: bars, busy: busy, visual: marked >= 2 || bars > 0 || busy > 0 || buttons > 0, href: location.href, loading: why.length > 0, why: why.join(', '), sig: marked + ':' + bars + ':' + busy + ':' + buttons + ':' + Math.round(len / 40) };
}

// find: where is the control that says X (a regex), even if a collapsed section hides it,
// and where does it link? Open shadow roots included; each hit named by a ref from the last
// read, else by a pinned selector. pin: name every hit by a pinned selector.
({ pattern, limit = 25, pin = false }) => {
  var kit = findKit(), all = kit.all, ours = kit.ours, clip = kit.clip, hiddenWhy = kit.hiddenWhy, opener = kit.opener, handle = kit.handle;
  if (pin) kit.forgetRefs();
  var re = new RegExp(pattern, 'i');
  var ACT = 'a[href],button,input,select,textarea,summary,option,label,[onclick],[tabindex]:not([tabindex="-1"]),[role=button],[role=link],[role=tab],[role=option],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=treeitem],[role=gridcell]';
  var hits = [], texts = [];
  all(document).forEach(function (el) {
    if (ours(el) || el.closest && el.closest('script,style,noscript,template')) return;
    var own = el.matches(ACT);
    var name = own ? clip(accName(el) || el.innerText || el.textContent || el.value, 120) : '';
    if (own && name && re.test(name)) {
      // The innermost control: a label's input, not every wrapper that also matches.
      if (hits.some(function (h) { return el.contains(h.el); })) return;
      hits = hits.filter(function (h) { return !h.el.contains(el); });
      hits.push({ el: el, name: name });
    } else if (!own && el.children.length === 0 && re.test(clip(el.textContent, 200))) texts.push(el);
  });
  var rows = hits.slice(0, limit).map(function (h) {
    var el = h.el, why = hiddenWhy(el), o = why ? opener(el) : null;
    var href = el.getAttribute('href');
    return { handle: handle(el), role: accRole(el), name: h.name, hidden: why || undefined,
      opens_with: o ? { handle: handle(o), role: accRole(o), name: clip(accName(o) || o.innerText || o.textContent, 60) } : undefined,
      href: href && !/^(#|javascript:)/i.test(href) ? el.href : undefined,
      // A link that only runs script: what it runs often names the address parameter it sets
      // (AddCriteria('saltyp=2')), which a nav step can set directly.
      runs: (!href || /^(#|javascript:)/i.test(href)) && el.getAttribute('onclick') ? clip(el.getAttribute('onclick'), 100) : undefined,
      value: el.matches('input,select,textarea') ? (el.type === 'checkbox' || el.type === 'radio' ? (el.checked ? 'checked' : 'unchecked') : el.value) : undefined,
      disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' || undefined };
  });
  // Plain text that matches but sits in no control: where it is, so a read or scroll-to finds it.
  var plain = hits.length ? [] : texts.slice(0, 8).map(function (el) {
    return { handle: handle(el), role: 'text', name: clip(el.textContent, 120), hidden: hiddenWhy(el) || undefined };
  });
  return { matches: hits.length, rows: rows.concat(plain), more: Math.max(0, hits.length - limit) };
}

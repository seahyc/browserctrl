// Result blocks a ranked pick can fall back to when no group of same-size siblings holds the
// results: cards that repeat one class but sit in different parents (a grid built row by
// row), and blocks led by one heading each. Ids are shared with items, so `click i12` works.
(function (opts) {
  var maxItems = opts.maxItems || 201;
  var state = window.__bcItems;
  if (!state) state = window.__bcItems = { ids: new WeakMap(), n: 0, seen: {}, calls: 0 };
  function idOf(el) { var id = state.ids.get(el); if (!id) { id = 'i' + (++state.n); state.ids.set(el, id); } return id; }
  function shown(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    var s = getComputedStyle(el);
    return s.display === 'none' || s.visibility === 'hidden' ? null : r;
  }
  var CHROME = 'header,nav,footer,aside,dialog,[role=banner],[role=navigation],[role=contentinfo],[role=complementary],[role=dialog],[data-cdp],[data-cdp-internal]';
  function text(el) { return (el.innerText || '').replace(/[ \t]+/g, ' ').split(/\n+/).map(function (x) { return x.trim(); }).filter(Boolean).join(' · ').slice(0, 600); }
  function link(el) {
    var head = el.querySelector('h1 a[href],h2 a[href],h3 a[href],h4 a[href],h5 a[href],h6 a[href],a[href] h1,a[href] h2,a[href] h3,a[href] h4,[role=heading] a[href]');
    var a = head ? (head.matches('a[href]') ? head : head.closest('a[href]')) : (el.matches('a[href]') ? el : el.querySelector('a[href]'));
    if (!a) return null;
    try { var u = new URL(a.href); return u.origin === location.origin ? u.pathname + u.search : a.href; } catch (e) { return null; }
  }
  function describe(name, els) {
    els.sort(function (a, b) { return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1; });
    var top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
    var items = els.slice(0, maxItems).map(function (el) {
      var r = el.getBoundingClientRect();
      top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom); left = Math.min(left, r.left); right = Math.max(right, r.right);
      var item = { id: idOf(el), text: text(el) }, l = link(el);
      if (l) item.link = l;
      (state.texts || (state.texts = new WeakMap())).set(el, item.text);
      return item;
    });
    return { id: name, region: name, heading: '', count: els.length, items: items, box: { x: Math.round(left), y: Math.round(top + scrollY), w: Math.round(right - left), h: Math.round(bottom - top) } };
  }
  var groups = [];

  // Repeated cards: one class signature, three or more shown copies holding a link and text,
  // none inside another. A wrapper whose copies each hold one card of another signature is
  // the same result, so only the outer copy is kept.
  var bySig = new Map(), all = document.body ? document.body.getElementsByTagName('*') : [];
  for (var i = 0; i < all.length && i < 30000; i++) {
    var el = all[i], cls = typeof el.className === 'string' ? el.className.trim() : '';
    if (!cls || el.closest(CHROME)) continue;
    var sig = el.tagName + '.' + cls.split(/\s+/).sort().join('.');
    if (!bySig.has(sig)) bySig.set(sig, []);
    bySig.get(sig).push(el);
  }
  var cardSets = [];
  bySig.forEach(function (els, sig) {
    if (els.length < 3) return;
    var ok = els.filter(function (el) { return shown(el) && (el.matches('a[href]') || el.querySelector('a[href]')) && (el.innerText || '').trim().length >= 15; });
    ok = ok.filter(function (el) { return !ok.some(function (o) { return o !== el && o.contains(el); }); });
    // Distinct results link to distinct places; a repeated "Add to cart" row does not.
    var hrefs = new Set(ok.map(function (el) { return link(el); }).filter(Boolean));
    if (ok.length >= 3 && hrefs.size >= ok.length * 0.6) cardSets.push(ok);
  });
  cardSets = cardSets.filter(function (inner) {
    return !cardSets.some(function (outer) {
      return outer !== inner && outer.length === inner.length && inner.every(function (el) { return outer.some(function (o) { return o !== el && o.contains(el); }); });
    });
  });
  cardSets.sort(function (a, b) { return b.length - a.length; }).slice(0, 4).forEach(function (els, k) { groups.push(describe('repeated cards ' + (k + 1), els)); });

  // Heading-led blocks: per heading level, the largest ancestor of each heading that holds
  // no other heading of that level.
  var levels = new Map();
  Array.prototype.forEach.call(document.querySelectorAll('h2,h3,h4,h5,[role=heading]'), function (h) {
    if (!shown(h) || h.closest(CHROME) || (h.innerText || '').trim().length < 3) return;
    var level = h.getAttribute('role') === 'heading' ? 'h' + (h.getAttribute('aria-level') || '2') : h.tagName.toLowerCase();
    if (!levels.has(level)) levels.set(level, []);
    levels.get(level).push(h);
  });
  levels.forEach(function (heads, level) {
    if (heads.length < 2) return;
    var blocks = heads.map(function (h) {
      var box = h;
      for (var up = h.parentElement; up && up !== document.body; up = up.parentElement) {
        if (heads.filter(function (o) { return up.contains(o); }).length > 1) break;
        box = up;
      }
      return box;
    });
    blocks = blocks.filter(function (b, k) { return blocks.indexOf(b) === k && b.querySelector('a[href],button') && (b.innerText || '').trim().length >= 15; });
    if (blocks.length >= 2) groups.push(describe('heading-led blocks ' + level, blocks));
  });
  return { url: location.href, groups: groups };
})

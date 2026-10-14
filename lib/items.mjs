// Repeated items on a page: search results, cards, inbox rows, chat messages.
// An item is one of three or more same-tag siblings of similar size; their parent is
// a group. No site rules: banners, grids and threads all have this shape, and a page
// region (nav, main, a heading) labels each group.

const ITEMS_FN = `
(function (opts) {
  var maxItems = opts.maxItems || 30, maxGroups = opts.maxGroups || 8;
  var state = window.__bcItems || (window.__bcItems = { ids: new WeakMap(), n: 0, seen: {} });
  function idOf(el) { var id = state.ids.get(el); if (!id) { id = 'i' + (++state.n); state.ids.set(el, id); } return id; }
  function shown(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    var s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity || '1') < 0.05) return null;
    return r;
  }
  // Text in reading order, with " · " where pieces are visibly apart (a badge next to a
  // title, a price on its own line). innerText glues adjacent inline elements together.
  function itemText(el, max) {
    var out = '', prev = null, w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), range = document.createRange();
    for (var t = w.nextNode(); t && out.length < max; t = w.nextNode()) {
      var s = t.textContent.replace(/\\s+/g, ' ');
      if (!s.trim() || !t.parentElement || t.parentElement.closest('script,style,noscript')) continue;
      range.selectNodeContents(t);
      var r = range.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      if (prev) {
        var apart = t.parentElement !== prev.el && (Math.abs(r.top - prev.r.top) > prev.r.height / 2 || r.left - prev.r.right > 1.5);
        out += apart ? ' · ' : (/\\s$/.test(prev.s) || /^\\s/.test(s) ? ' ' : '');
      }
      out += s.trim();
      prev = { el: t.parentElement, r: r, s: s };
    }
    return out.slice(0, max);
  }
  function clean(t) { return (t || '').replace(/[ \\t]+/g, ' ').split(/\\n+/).map(function (x) { return x.trim(); }).filter(Boolean).join(' · '); }
  function internal(el) { return el.closest && el.closest('[data-cdp],[data-cdp-internal]'); }
  function median(xs) { var s = xs.slice().sort(function (a, b) { return a - b; }); return s[s.length >> 1]; }

  // 1. Candidate groups: same-tag children of one parent, of similar size, with content.
  var found = [];
  var all = document.body ? document.body.getElementsByTagName('*') : [];
  for (var i = 0; i < all.length && i < 30000; i++) {
    var p = all[i];
    if (p.children.length < 3 || internal(p)) continue;
    var byTag = {};
    for (var j = 0; j < p.children.length; j++) {
      var c = p.children[j];
      if (/^(SCRIPT|STYLE|TEMPLATE|BR|HR)$/.test(c.tagName)) continue;
      var r = shown(c);
      if (!r) continue;
      if (!(c.innerText || '').trim() && !c.querySelector('a[href],img,button')) continue;
      (byTag[c.tagName] = byTag[c.tagName] || []).push({ el: c, r: r });
    }
    for (var tag in byTag) {
      var kids = byTag[tag];
      if (kids.length < 3) continue;
      var mw = median(kids.map(function (k) { return k.r.width; })), mh = median(kids.map(function (k) { return k.r.height; }));
      var members = kids.filter(function (k) { return k.r.width >= mw / 2 && k.r.width <= mw * 2 && k.r.height >= mh / 3 && k.r.height <= mh * 3; });
      if (members.length < 3) continue;
      var textLen = members.reduce(function (n, k) { return n + (k.el.innerText || '').length; }, 0) / members.length;
      found.push({ parent: p, members: members, textLen: textLen });
    }
  }

  // 2. Keep the most specific groups: drop sub-parts of an item (badges, spans inside a
  // card) and page layout wrappers that merely contain real groups.
  found.sort(function (a, b) { return b.members.length - a.members.length || b.textLen - a.textLen; });
  var kept = [];
  found.forEach(function (g) {
    if (g.textLen < 2) return;
    var clash = kept.some(function (k) {
      var insideItem = k.members.some(function (m) { return m.el.contains(g.parent); });
      var wrapsGroup = g.members.some(function (m) { return m.el.contains(k.parent); });
      return insideItem || wrapsGroup;
    });
    if (!clash) kept.push(g);
  });

  // 3. Describe each group and its items.
  var headings = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3,h4,[role=heading]'));
  var landmarkSel = 'main,nav,header,footer,aside,form,dialog,[role=main],[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[role=region],[role=dialog],[role=log],[role=list],[role=feed],[role=grid],section[aria-label]';
  function region(el) {
    var parts = [];
    for (var n = el; n && n !== document.body; n = n.parentElement) {
      if (n.matches && n.matches(landmarkSel)) {
        var role = n.getAttribute('role') || n.tagName.toLowerCase();
        var label = n.getAttribute('aria-label');
        parts.unshift(label ? role + ' "' + label.slice(0, 40) + '"' : role);
      }
    }
    return parts.join(' › ');
  }
  function heading(el) {
    var best = null;
    headings.forEach(function (h) {
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING && !el.contains(h) && shown(h)) best = h;
    });
    return best ? clean(best.innerText).slice(0, 80) : '';
  }
  var HINT = /(^|[-_ ])(ad|ads|advert|sponsor|sponsored|promoted|spotlight|bump|bumped|boost|boosted|featured)([-_ ]|$)/i;
  function hints(el) {
    var out = [];
    [el].concat(Array.prototype.slice.call(el.querySelectorAll('[class],[id],[data-testid],[aria-label]'), 0, 60)).forEach(function (n) {
      [n.getAttribute('class'), n.id, n.getAttribute('data-testid'), n.getAttribute('aria-label')].forEach(function (v) {
        (v || '').split(/\\s+/).forEach(function (tok) { if (tok && HINT.test(tok) && out.indexOf(tok) < 0 && out.length < 4) out.push(tok.slice(0, 30)); });
      });
    });
    return out;
  }
  // Where an item's visible text sits within its group: chat bubbles align left or right.
  function textSpan(el) {
    var lo = Infinity, hi = -Infinity, w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), range = document.createRange();
    for (var t = w.nextNode(); t; t = w.nextNode()) {
      if (!t.textContent.trim()) continue;
      range.selectNodeContents(t);
      var rs = range.getClientRects();
      for (var k = 0; k < rs.length; k++) { if (rs[k].width) { lo = Math.min(lo, rs[k].left); hi = Math.max(hi, rs[k].right); } }
    }
    return lo === Infinity ? null : { lo: lo, hi: hi };
  }
  var vh = innerHeight, groups = [];
  // Content first: lists in the page's header, nav and footer are chrome.
  function chrome(el) { return !!el.closest('header,nav,footer,[role=banner],[role=navigation],[role=contentinfo]'); }
  kept.sort(function (a, b) { return chrome(a.parent) - chrome(b.parent); });
  kept.slice(0, maxGroups).forEach(function (g, gi) {
    var pr = g.parent.getBoundingClientRect();
    var items = g.members.map(function (m) {
      var el = m.el, link = el.matches('a[href]') ? el : null;
      if (!link) {
        // The link carrying the most text is the item's own (a listing title), not a
        // side link such as the seller's profile.
        Array.prototype.forEach.call(el.querySelectorAll('a[href]'), function (a) {
          if (!link || (a.innerText || '').trim().length > (link.innerText || '').trim().length) link = a;
        });
      }
      var id = idOf(el), span = textSpan(el), align = null;
      if (span && pr.width) {
        var left = span.lo - pr.left, right = pr.right - span.hi;
        align = right > left * 2 + 24 ? 'left' : left > right * 2 + 24 ? 'right' : 'full';
      }
      var item = { id: id, text: itemText(el, 300) };
      if (link) { try { var u = new URL(link.href); item.link = u.origin === location.origin ? u.pathname + u.search : link.href; } catch (e) {} }
      var h = hints(el); if (h.length) item.hints = h;
      item.align = align;
      if (m.r.top > vh) item.below = true; else if (m.r.bottom < 0) item.above = true;
      if (!state.seen[id]) item.new = true;
      return item;
    });
    // Alignment only means something when a group mixes sides, as a chat does.
    var sides = {};
    items.forEach(function (it) { sides[it.align] = 1; });
    var tops0 = g.members.map(function (m) { return Math.round(m.r.top); });
    var mixed = sides.left && sides.right && tops0.filter(function (t) { return t === tops0[0]; }).length === 1;
    items.forEach(function (it) { if (!mixed) delete it.align; });
    var tops = g.members.map(function (m) { return Math.round(m.r.top); });
    var cols = tops.filter(function (t) { return t === tops[0]; }).length;
    groups.push({
      id: 'g' + (gi + 1),
      region: region(g.parent),
      heading: heading(g.parent),
      label: g.parent.getAttribute('aria-label') || '',
      chrome: chrome(g.parent) || undefined,
      count: items.length,
      columns: cols > 1 ? cols : undefined,
      below: items.filter(function (it) { return it.below; }).length,
      box: { x: Math.round(pr.left), y: Math.round(pr.top + scrollY), w: Math.round(pr.width), h: Math.round(pr.height) },
      items: items.slice(0, opts.all ? items.length : maxItems),
    });
  });
  groups.forEach(function (g) { g.items.forEach(function (it) { state.seen[it.id] = 1; }); });
  return { url: location.href, title: document.title, scroll: { y: Math.round(scrollY), h: document.documentElement.scrollHeight, vh: vh }, groups: groups };
})
`;

export function itemsExpression(opts = {}) {
  return `(${ITEMS_FN})(${JSON.stringify(opts)})`;
}

export function formatItems(r, { maxText = 160, full = false } = {}) {
  const lines = [`${r.title}\n${r.url}\nscroll ${r.scroll.y}/${r.scroll.h}`];
  for (const g of r.groups) {
    const where = [g.region, g.heading && `"${g.heading}"`, g.label && `[${g.label}]`].filter(Boolean).join(' · ');
    lines.push(`\n${g.id}  ${where || '(no region)'}  · ${g.count} items${g.columns ? `, ${g.columns} per row` : ''}${g.below ? `, ${g.below} below the fold` : ''}`);
    if (g.chrome && !full) { lines.push(`  (page chrome: ${g.items.slice(0, 4).map(i => i.text.slice(0, 24)).join(' | ')}… — browserctrl items <tab> --group ${g.id})`); continue; }
    for (const it of g.items) {
      const tags = [it.new && '*', it.align && `[${it.align}]`, it.hints && `{${it.hints.join(',')}}`].filter(Boolean).join(' ');
      lines.push(`  ${it.id.padEnd(5)} ${tags ? `${tags} ` : ''}${it.text.slice(0, maxText) || '(no text)'}${it.link ? `  → ${it.link.slice(0, 80)}` : ''}`);
    }
    if (g.count > g.items.length) lines.push(`  … ${g.count - g.items.length} more (--all)`);
  }
  return lines.join('\n');
}

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
      if (!s.trim() || /^[\\s·•|\\-–—]+$/.test(s) || !t.parentElement || t.parentElement.closest('script,style,noscript')) continue;
      range.selectNodeContents(t);
      var rs = range.getClientRects();
      if (!rs.length || (!rs[0].width && !rs[0].height)) continue;
      // Compare with the previous text's last line, not its whole box: a title wrapping over
      // three lines would otherwise swallow the price under it.
      var first = rs[0], lastLine = rs[rs.length - 1];
      if (prev) {
        var apart = t.parentElement !== prev.el && (first.top >= prev.r.bottom - 2 || Math.abs(first.top - prev.r.top) > prev.r.height / 2 || first.left - prev.r.right > 1.5);
        out += apart ? ' · ' : (/\\s$/.test(prev.s) || /^\\s/.test(s) ? ' ' : '');
      }
      out += s.trim();
      prev = { el: t.parentElement, r: lastLine, s: s };
    }
    return out.replace(/( · )+/g, " · ").slice(0, max);
  }
  // A table row reads as "Header: value" pairs, so values keep their meaning.
  function headersFor(row) {
    var table = row.closest('table,[role=table],[role=grid],[role=treegrid]');
    if (!table) return null;
    var head = table.querySelector('thead tr, [role=row]:has(> [role=columnheader]), tr:has(> th)');
    if (!head || head === row) return null;
    return Array.prototype.map.call(head.children, function (c) { return itemText(c, 40); });
  }
  function rowText(row) {
    if (!/^(TR)$/.test(row.tagName) && row.getAttribute('role') !== 'row') return '';
    var heads = headersFor(row);
    if (!heads || !heads.some(Boolean)) return '';
    var parts = [];
    Array.prototype.forEach.call(row.children, function (cell, k) {
      var v = itemText(cell, 120);
      if (v) parts.push(heads[k] ? heads[k] + ': ' + v : v);
    });
    return parts.join(' · ').slice(0, 300);
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
      if (tag === 'TH' || (byTag[tag][0].el.getAttribute('role') === 'columnheader')) continue; // a header row, carried by its rows
      var members = kids.filter(function (k) { return k.r.width >= mw / 2 && k.r.width <= mw * 2 && k.r.height >= mh / 3 && k.r.height <= mh * 3; });
      if (members.length < 3) continue;
      var textLen = members.reduce(function (n, k) { return n + (k.el.innerText || '').length; }, 0) / members.length;
      found.push({ parent: p, members: members, textLen: textLen });
    }
  }

  // 1b. Cells are parts of a row, not items: when most members of a group each hold a
  // group of their own (a table row's cells side by side), those inner groups are cells.
  var byParent = new Map();
  found.forEach(function (g) { byParent.set(g.parent, g); });
  var cells = new Set();
  found.forEach(function (rows) {
    var inner = rows.members.map(function (m) {
      return byParent.get(m.el) || (m.el.children.length === 1 && byParent.get(m.el.children[0])) || null;
    }).filter(Boolean);
    if (inner.length >= 3 && inner.length >= rows.members.length * 0.6) inner.forEach(function (g) { cells.add(g); });
  });
  found = found.filter(function (g) { return !cells.has(g); });
  // Columns and sections of a page are same-size siblings too; each holds several stories.
  // A group whose members mostly link to three or more stories is layout, not a list.
  // Stories a box links to: links with headline-length text, counted by where they go.
  function stories(box) {
    var hrefs = new Set();
    Array.prototype.forEach.call(box.querySelectorAll('a[href]'), function (a) { if (clean(a.innerText).length >= 15) hrefs.add(a.href.split('#')[0]); });
    return hrefs.size;
  }
  // A list row has one headline; a section of stories has several.
  function headlines(box) {
    var hrefs = new Set();
    Array.prototype.forEach.call(box.querySelectorAll('h1 a[href],h2 a[href],h3 a[href],h4 a[href],h5 a[href],h6 a[href],a[href] h1,a[href] h2,a[href] h3,a[href] h4,a[href] h5,a[href] h6'), function (n) {
      var a = n.matches('a[href]') ? n : n.closest('a[href]'); if (a) hrefs.add(a.href.split('#')[0]);
    });
    return hrefs.size;
  }
  found = found.filter(function (g) {
    var multi = g.members.filter(function (m) { return stories(m.el) >= 3 || headlines(m.el) >= 2; }).length;
    return multi < g.members.length * 0.6;
  });

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
      // A section title, not a story's linked headline that happens to come first.
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING && !el.contains(h) && !h.querySelector('a[href]') && !h.closest('a[href]') && shown(h)) best = h;
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
  // A div grid has no <th>: a group of short labels sitting above a group of rows, with
  // one label over each cell, is that grid's header. Its labels name the row cells.
  var headerOf = new Map(), isHeader = new Set();
  kept.forEach(function (rows) {
    var first = rows.members[0].el, cells = Array.prototype.filter.call(first.children, function (c) { return shown(c); });
    if (cells.length < 3 || rowText(first)) return;
    // Grid cells sit side by side on one line; a card's parts are stacked.
    var t0 = cells[0].getBoundingClientRect().top;
    if (cells.filter(function (c) { return Math.abs(c.getBoundingClientRect().top - t0) < 6; }).length < 3) return;
    kept.forEach(function (h) {
      if (h === rows || isHeader.has(h) || h.textLen > 40 || Math.abs(h.members.length - cells.length) > 2) return;
      // A header is one line of plain labels directly above the first row.
      var gap = rows.members[0].r.top - h.members[0].r.bottom;
      if (gap < -4 || gap > 80) return;
      if (h.members.some(function (m) { return Math.abs(m.r.top - h.members[0].r.top) > 6 || m.el.querySelector('a[href]') || m.el.matches('a[href]'); })) return;
      // Match by position: the label whose left edge sits over the cell's left edge.
      var heads = cells.map(function (c) {
        var cl = c.getBoundingClientRect().left, hit = null;
        h.members.forEach(function (m) { if (Math.abs(m.r.left - cl) < 24) hit = m; });
        return hit ? itemText(hit.el, 40) : '';
      });
      if (heads.filter(Boolean).length < Math.min(cells.length, h.members.length) * 0.7) return;
      headerOf.set(rows, heads);
      isHeader.add(h);
    });
  });
  kept = kept.filter(function (g) { return !isHeader.has(g); });
  function gridText(el, heads) {
    var parts = [];
    Array.prototype.filter.call(el.children, function (c) { return shown(c); }).forEach(function (cell, k) {
      var v = itemText(cell, 120);
      if (v) parts.push(heads[k] ? heads[k] + ': ' + v : v);
    });
    return parts.join(' · ').slice(0, 300);
  }
  // A lead story or hero card stands alone, so it never forms a group of siblings. A
  // heading that links somewhere, outside every group and outside page chrome, is one;
  // they form one group of their own, placed by position like any other.
  var inGroup = function (el) { return kept.some(function (g) { return g.members.some(function (m) { return m.el.contains(el); }); }); };
  var HEAD_LINKS = 'h1 a[href],h2 a[href],h3 a[href],h4 a[href],h5 a[href],h6 a[href],[role=heading] a[href],a[href] h1,a[href] h2,a[href] h3,a[href] h4,a[href] h5,a[href] h6';
  var leads = [], leadSeen = new Set();
  Array.prototype.forEach.call(document.querySelectorAll(HEAD_LINKS), function (n) {
    var a = n.matches('a[href]') ? n : n.closest('a[href]');
    if (!a || leadSeen.has(a.href) || internal(a) || inGroup(a)) return;
    var r = shown(a), txt = clean(a.innerText);
    if (!r || txt.length < 15 || a.closest('header,nav,footer,[role=banner],[role=navigation],[role=contentinfo]')) return;
    leadSeen.add(a.href);
    // The item is the card around the headline: the largest ancestor that links to this story only.
    var box = a;
    for (var up = a.parentElement; up && up !== document.body && !inGroup(up) && stories(up) <= 1; up = up.parentElement) box = up;
    leads.push({ el: box, r: box.getBoundingClientRect(), link: a });
  });
  // One group per page section: the nearest heading above a lead that is not a headline itself.
  var sectionHeads = Array.prototype.filter.call(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]'), function (h) {
    return !h.querySelector('a[href]') && !h.closest('a[href]') && clean(h.innerText).length > 1 && shown(h);
  });
  var buckets = new Map();
  leads.forEach(function (l) {
    var sec = null;
    sectionHeads.forEach(function (h) { if (h.compareDocumentPosition(l.el) & Node.DOCUMENT_POSITION_FOLLOWING) sec = h; });
    if (!buckets.has(sec)) buckets.set(sec, []);
    buckets.get(sec).push(l);
  });
  buckets.forEach(function (ms, sec) {
    ms.sort(function (x, y) { return (x.r.top - y.r.top) || (x.r.left - y.r.left); });
    kept.push({ parent: ms[0].el.parentElement || document.body, members: ms, textLen: 99, lead: true, section: sec ? clean(sec.innerText).slice(0, 80) : '' });
  });
  var vh = innerHeight, groups = [];
  // Content first: lists in the page's header, nav and footer are chrome.
  function chrome(el) { return !!el.closest('header,nav,footer,[role=banner],[role=navigation],[role=contentinfo]'); }
  // Choose the biggest groups, then list them in reading order (top of the page first),
  // so "the first N" on a page means what a person sees first.
  // Headlines standing alone near the top (a lead story) are kept even when their group is small.
  var leadTop = function (g) { return g.lead && g.members[0].r.top < innerHeight * 1.5; };
  kept.sort(function (a, b) { return chrome(a.parent) - chrome(b.parent) || leadTop(b) - leadTop(a); });
  var top = function (g) { return g.members[0].r.top + scrollY; };
  kept.slice(0, maxGroups).sort(function (a, b) { return chrome(a.parent) - chrome(b.parent) || top(a) - top(b); }).forEach(function (g, gi) {
    var pr = g.parent.getBoundingClientRect();
    var items = g.members.map(function (m) {
      var el = m.el, link = m.link || (el.matches('a[href]') ? el : null);
      if (!link) {
        // The link carrying the most text is the item's own (a listing title), not a
        // side link such as the seller's profile.
        // Prefer a link to a record (its path ends in an id: a listing, an MR, a post), then
        // the most prominent text, then the longest.
        var score = function (a) {
          var path = a.pathname || '', fs = parseFloat(getComputedStyle(a).fontSize) || 0, fw = parseInt(getComputedStyle(a).fontWeight, 10) || 400;
          return (/\\d{3,}[^/]*\\/?$/.test(path) ? 1000 : 0) + fs * 10 + (fw >= 600 ? 5 : 0) + Math.min((a.innerText || '').trim().length, 80) / 100;
        };
        var best = -1;
        Array.prototype.forEach.call(el.querySelectorAll('a[href]'), function (a) {
          var sc = score(a); if (sc > best) { best = sc; link = a; }
        });
      }
      var id = idOf(el), span = textSpan(el), align = null;
      if (span && pr.width) {
        // A side only when one gap is large and the other small, as with chat bubbles.
        var left = (span.lo - pr.left) / pr.width, right = (pr.right - span.hi) / pr.width;
        align = right > 0.25 && left < 0.1 ? 'left' : left > 0.25 && right < 0.1 ? 'right' : 'full';
      }
      var heads = headerOf.get(g);
      var item = { id: id, text: rowText(el) || (heads ? gridText(el, heads) : '') || itemText(el, 600) };
      if (link) { try { var u = new URL(link.href); item.link = u.origin === location.origin ? u.pathname + u.search : link.href; } catch (e) {} }
      var h = hints(el); if (h.length) item.hints = h;
      item.align = align;
      if (m.r.top > vh) item.below = true; else if (m.r.bottom < 0) item.above = true;
      if (!state.seen[id]) item.new = true;
      return item;
    });
    // Alignment only means something when a group mixes sides, as a chat does.
    var sides = { left: 0, right: 0 };
    items.forEach(function (it) { sides[it.align] = (sides[it.align] || 0) + 1; });
    var tops0 = g.members.map(function (m) { return Math.round(m.r.top); });
    var mixed = sides.left >= 2 && sides.right >= 2 && tops0.filter(function (t) { return t === tops0[0]; }).length === 1;
    items.forEach(function (it) { if (!mixed) delete it.align; });
    var tops = g.members.map(function (m) { return Math.round(m.r.top); });
    var cols = tops.filter(function (t) { return t === tops[0]; }).length;
    groups.push({
      id: 'g' + (gi + 1),
      region: g.lead ? 'headlines outside lists' : region(g.parent),
      heading: g.lead ? g.section : heading(g.parent),
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

// Fits an item's text in max characters by trimming its longest pieces first, so a long
// title gives way before a price, date or status beside it. Links are never shortened:
// they identify the item.
export function shorten(text, max) {
  if (!text || text.length <= max) return text || '';
  const parts = text.split(' · ');
  const total = () => parts.reduce((n, p) => n + p.length, 0) + 3 * (parts.length - 1);
  while (total() > max) {
    let i = 0;
    parts.forEach((p, k) => { if (p.length > parts[i].length) i = k; });
    if (parts[i].length <= 41) break;
    parts[i] = `${parts[i].slice(0, Math.max(40, parts[i].length - (total() - max) - 1))}…`;
  }
  const out = parts.join(' · ');
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

// main: the largest content group in full, the others as one line each (what a
// do --then items caller usually needs). grep: keep only items whose text matches.
export function formatItems(r, { maxText = 160, full = false, main = false, grep = null } = {}) {
  const re = grep ? new RegExp(grep, 'i') : null;
  const biggest = main ? (r.groups.filter(g => !g.chrome).sort((a, b) => b.count - a.count)[0] || null) : null;
  const lines = [`${r.title}\n${r.url}\nscroll ${r.scroll.y}/${r.scroll.h}`];
  for (const g of r.groups) {
    const where = [g.region, g.heading && `"${g.heading}"`, g.label && `[${g.label}]`].filter(Boolean).join(' · ');
    lines.push(`\n${g.id}  ${where || '(no region)'}  · ${g.count} items${g.columns ? `, ${g.columns} per row` : ''}${g.below ? `, ${g.below} below the fold` : ''}`);
    if (g.chrome && !full) { lines.push(`  (page chrome: ${g.items.slice(0, 4).map(i => i.text.slice(0, 24)).join(' | ')}… — browserctrl items <tab> --group ${g.id})`); continue; }
    if (biggest && g !== biggest) { lines.push(`  (${g.items.slice(0, 3).map(i => shorten(i.text, 30)).join(' | ')}… — browserctrl items <tab> --group ${g.id})`); continue; }
    for (const it of g.items) {
      if (re && !re.test(`${it.text} ${it.link || ''}`)) continue;
      const tags = [it.new && '*', it.align && `[${it.align}]`, it.hints && `{${it.hints.join(',')}}`].filter(Boolean).join(' ');
      lines.push(`  ${it.id.padEnd(5)} ${tags ? `${tags} ` : ''}${shorten(it.text, maxText) || '(no text)'}${it.link ? `  → ${it.link}` : ''}`);
    }
    if (g.count > g.items.length) lines.push(`  … ${g.count - g.items.length} more (--all)`);
  }
  return lines.join('\n');
}

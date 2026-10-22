// read_page: a compact snapshot of what a page offers, with stable refs (lib/refs.mjs).
// Keep it dependency-free and defensive: it runs on arbitrary sites.
(function (opts) {
  var maxText = opts.maxText || 20000;
  var limit = opts.max || 400;
  var vw = window.innerWidth, vh = window.innerHeight;
  var interactiveSel = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]',
    '[role=menuitem]', '[role=option]', '[role=switch]', '[role=combobox]', '[role=textbox]',
    '[contenteditable=""]', '[contenteditable=true]', '[onclick]', '[tabindex]:not([tabindex="-1"])'
  ].join(',');
  var MAX_FRAMES = 20, MAX_FRAME_DEPTH = 3;

  var state = window.__bcRead || (window.__bcRead = { ids: new WeakMap(), n: 0, reads: 0 });
  var firstRead = state.reads === 0;
  state.reads++;
  function stableId(el) {
    var id = state.ids.get(el);
    if (id) return { id: id, fresh: false };
    id = 'e' + (++state.n);
    state.ids.set(el, id);
    return { id: id, fresh: true };
  }

  // These caches belong to one synchronous snapshot; styles may change between reads.
  var styles = new WeakMap(), srOnly = new WeakMap();
  function styleOf(el) {
    if (styles.has(el)) return styles.get(el);
    var w = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    var s = w.getComputedStyle(el);
    styles.set(el, s);
    return s;
  }
  function visible(el) {
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var s = styleOf(el);
    if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity || '1') < 0.05) return false;
    if (screenReaderOnly(el)) return false;
    return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }
  // Text for screen readers only: it or an ancestor clips to a box of a pixel or so, so the
  // element has a size but nobody sees it, and a click on it lands on whatever is drawn there.
  function screenReaderOnly(el) {
    var chain = [], hidden = false;
    for (var e = el; e && e.nodeType === 1; e = up(e)) {
      if (srOnly.has(e)) { hidden = srOnly.get(e); break; }
      chain.push(e);
      if (screenReaderClip(e, styleOf(e))) { hidden = true; break; }
    }
    for (var i = 0; i < chain.length; i++) srOnly.set(chain[i], hidden);
    return hidden;
  }
  // Parent across shadow roots and same-origin frame boundaries.
  function up(node) {
    if (node.parentElement) return node.parentElement;
    var root = node.getRootNode && node.getRootNode();
    if (root && root.host) return root.host;
    try {
      var w = node.ownerDocument && node.ownerDocument.defaultView;
      if (w && w !== window && w.frameElement) return w.frameElement;
    } catch (e) {}
    return null;
  }
  function within(el, anc) {
    for (var n = el; n; n = up(n)) if (n === anc) return true;
    return false;
  }

  // The extension's annotation controls live in the inspected page's DOM. They
  // are useful to the human, but must never become targets for page automation.
  // Do not use [data-cdp-overlay] here: that marker intentionally sits on
  // <html>, so it would incorrectly hide the entire page.
  function internal(el) {
    for (var node = el; node; node = node.parentElement || (node.getRootNode && (node.getRootNode() || {}).host)) {
      if (node.nodeType === 1 && (node.hasAttribute('data-cdp') || node.getAttribute('data-cdp-internal') === 'true')) return true;
    }
    return false;
  }

  // An icon-only button (a stepper's +/−, a bare ×) has no name of its own. Name it from
  // its row ("Children", "Ages 2-17") and its direction, read from its symbol, its
  // attributes or, for a pair of unnamed buttons around a count, its position.
  var SYMBOL = /^[+\-−–×✕⨯x]?$/i;
  function buttonish(el) {
    var tag = el.tagName, role = el.getAttribute('role');
    return tag === 'BUTTON' || role === 'button' || (tag === 'INPUT' && /^(button|submit)$/.test(el.type));
  }
  function rowLabel(el) {
    for (var n = el.parentElement, k = 0; n && n !== document.body && k < 4; n = n.parentElement, k++) {
      var lines = (n.innerText || '').split(/\n+/).map(function (s) { return s.trim(); })
        .filter(function (s) { return /[A-Za-z\u00C0-\uFFFF]{2}/.test(s) && s.length <= 60; });
      if (lines.length) return { text: lines[0].slice(0, 60), row: n }; // the row's label, not its sub-line ("Ages 2-17")
    }
    return null;
  }
  function directionOf(el, own, row) {
    if (/^\+$/.test(own)) return 1;
    if (/^[\-−–]$/.test(own)) return -1;
    var attrs = [el.getAttribute('data-testid'), el.getAttribute('data-test'), el.getAttribute('title'), el.getAttribute('name'), typeof el.className === 'string' ? el.className : '', el.innerHTML.slice(0, 300)].join(' ');
    if (/increase|increment|plus|\badd\b|\bup\b|more/i.test(attrs)) return 1;
    if (/decrease|decrement|minus|subtract|remove|\bdown\b|less/i.test(attrs)) return -1;
    if (row) {
      var bare = Array.prototype.filter.call(row.querySelectorAll('button,[role=button]'), function (b) {
        return visible(b) && SYMBOL.test(((b.getAttribute('aria-label') || '') + (b.innerText || '')).trim());
      });
      if (bare.length === 2) return bare[0] === el ? -1 : 1;
    }
    return 0;
  }
  // An icon button whose own markup says it closes something (class "close-btn", a
  // "dismiss" test id, a title): "Close", not a name borrowed from the row it sits in (a
  // popup's close button would otherwise read as "Sign up to our emails… (unnamed button)").
  var CLOSES = /(^|[\s_-])(close|closer|dismiss|cancel)([\s_-]|btn|button|icon|$)|(^|[\s_-])x-?mark|modal-x|icon-x([\s_-]|$)/i;
  function closeHint(el) {
    var own = [typeof el.className === 'string' ? el.className : '', el.id || '', el.getAttribute('data-testid') || '', el.getAttribute('data-test') || '', el.getAttribute('title') || '', el.getAttribute('name') || ''];
    var icon = el.querySelector && el.querySelector('svg, i, span[class], [data-icon]');
    if (icon) own.push(icon.getAttribute('class') || '', icon.getAttribute('data-icon') || '', (icon.querySelector && icon.querySelector('title') || {}).textContent || '');
    return CLOSES.test(own.join(' '));
  }
  function contextName(el, name) {
    if (!buttonish(el) || !SYMBOL.test(name)) return null;
    if (!name && closeHint(el)) return 'Close';
    var lab = rowLabel(el);
    if (!lab) return null;
    var dir = directionOf(el, name, lab.row);
    if (/^[×✕⨯x]$/i.test(name)) return 'Close ' + lab.text;
    return dir > 0 ? 'Increase ' + lab.text : dir < 0 ? 'Decrease ' + lab.text : lab.text + ' (unnamed button)';
  }

  // A text field with no name of its own (react-select's bare input, a combobox whose label
  // is a sibling div) is named from the label of the row that holds only it ("Make and
  // Model"); its hint text, often a separate element it is described by, becomes the
  // placeholder ("Type to Search").
  function fieldish(el) {
    var tag = el.tagName, role = el.getAttribute('role');
    return tag === 'TEXTAREA' || /^(combobox|textbox|searchbox|spinbutton)$/.test(role || '') ||
      (tag === 'INPUT' && !/^(button|submit|reset|checkbox|radio|hidden|file|image|range|color)$/.test(el.type));
  }
  function textOfIds(el, attr) {
    var ids = el.getAttribute(attr);
    if (!ids) return '';
    var doc = el.ownerDocument || document;
    return ids.split(/\s+/).map(function (id) { var n = doc.getElementById(id); return n ? (n.innerText || n.textContent || '').trim() : ''; })
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 80);
  }
  var FIELD_SEL = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]),textarea,select,[role=combobox],[role=textbox],[role=searchbox]';
  function fieldContextName(el, name) {
    if (name || !fieldish(el)) return null;
    var hint = (el.getAttribute('placeholder') || '').trim() || textOfIds(el, 'aria-describedby');
    var skip = [hint, String(el.value || '').trim()].filter(Boolean);
    for (var n = el.parentElement, k = 0; n && n !== document.body && k < 6; n = n.parentElement, k++) {
      var fields = Array.prototype.filter.call(n.querySelectorAll(FIELD_SEL), function (f) { return f !== el && !el.contains(f) && !f.contains(el) && f.getClientRects().length; });
      if (fields.length) break; // the row holds other fields too: its text is not this one's label
      var lines = (n.innerText || '').split(/\n+/).map(function (s) { return s.trim(); })
        .filter(function (s) { return /[A-Za-z\u00C0-\uFFFF]{2}/.test(s) && s.length <= 60 && skip.indexOf(s) < 0; });
      if (lines.length) return { name: lines[0], hint: hint };
    }
    return hint ? { name: hint, hint: '' } : null;
  }

  // A plain element counted as a control by its cursor or click listener has no role of its own.
  function roleOf(el) {
    if (!el.getAttribute('role') && clickables.has(el)) return 'clickable';
    return accRole(el);
  }

  function testid(el) {
    var attrs = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];
    for (var i = 0; i < attrs.length; i++) {
      var v = el.getAttribute(attrs[i]);
      if (v) return v;
    }
    return null;
  }

  // ---- collect: document, open shadow roots, same-origin frames ----
  var stats = { interactive: 0, links: 0, iframes: 0, shadowRoots: 0, total: 0, readyState: document.readyState };
  var crossOrigin = [];
  var inaccessibleFrames = [];
  var nodes = [], ctxOf = new Map(), frameCount = 0;
  var top = { ox: 0, oy: 0, depth: 0, win: window, frame: null, src: null };
  // querySelectorAll stops at shadow boundaries. Modern chat composers and
  // design-system controls commonly use open shadow roots, so collect those
  // deliberately while keeping the resulting elements usable as normal refs.
  // Clickable beyond tags and roles (Browser Use's is_interactive): a plain div whose
  // computed cursor is pointer, or that has its own click listener, is a control on many
  // sites (a "Sort by" dropdown, a filter chip). Only the outermost such element counts,
  // and not one inside or around a real control, so card children are not duplicated.
  // Bounded: style checks stop after MAX_STYLE_SCAN elements, listener checks run only on
  // small pages, and at most MAX_CLICKABLE are added.
  var MAX_STYLE_SCAN = 15000, MAX_CLICKABLE = 150, LISTENER_PAGE_LIMIT = 3000;
  var clickables = new Set(), styleScanned = 0;
  var listenersOf = typeof getEventListeners === 'function' ? getEventListeners : null;
  var CLICK_EVENTS = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart'];
  function onScreen(el) {
    var r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw ? 1 : 0;
  }
  // An item of a list floating over the page (a dropdown or suggestion list that just
  // opened) is a choice even with no role, cursor or listener of its own: frameworks
  // often handle it by keyboard or by a listener on the list.
  function popupItem(el) {
    if (el.tagName !== 'LI' || !el.parentElement || (el.innerText || '').trim().length > 80) return false;
    for (var n = el.parentElement, k = 0; n && n !== document.body && k < 3; n = n.parentElement, k++) {
      var pos = styleOf(n).position;
      if (pos === 'absolute' || pos === 'fixed') return true;
    }
    return false;
  }
  function pointerish(el) {
    var tag = el.tagName;
    if (tag === 'HTML' || tag === 'BODY' || tag === 'LABEL' || tag === 'OPTION' || tag === 'IFRAME' || tag === 'FRAME' || tag === 'svg' || tag === 'path') return false;
    var w = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    if (w.SVGElement && el instanceof w.SVGElement && tag !== 'svg') return false;
    var cursor = styleOf(el).cursor, pointer = cursor === 'pointer' || popupItem(el);
    if (pointer) {
      var par = el.parentElement;
      if (par && styleOf(par).cursor === 'pointer') return false; // cursor inherits: keep the outermost
    } else if (!(listenersOf && stats.total <= LISTENER_PAGE_LIMIT)) {
      return false;
    } else {
      var ls = null;
      try { ls = listenersOf(el); } catch (e) { ls = null; }
      if (!ls || !CLICK_EVENTS.some(function (k) { return ls[k] && ls[k].length; })) return false;
    }
    if (!visible(el)) return false;
    var r = el.getBoundingClientRect();
    if (r.width * r.height > vw * vh * 0.6) return false; // a whole-page wrapper, not a control
    if (el.parentElement && el.parentElement.closest(interactiveSel)) return false;
    var inner = el.querySelectorAll(interactiveSel);
    for (var k = 0; k < inner.length && k < 50; k++) if (visible(inner[k])) return false;
    return true;
  }
  function collect(root, ctx) {
    var mine = [];
    Array.prototype.forEach.call(root.querySelectorAll(interactiveSel), function (el) {
      if (ctxOf.has(el)) return;
      ctxOf.set(el, ctx);
      mine.push(el);
    });
    stats.links += root.querySelectorAll('a[href]').length;
    var all = root.querySelectorAll('*');
    stats.total += all.length;
    var frames = [], shadows = [], extra = 0, found = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.shadowRoot && el.shadowRoot.mode === 'open') { stats.shadowRoots++; shadows.push(el.shadowRoot); }
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') frames.push(el);
      if (styleScanned < MAX_STYLE_SCAN && !ctxOf.has(el)) {
        styleScanned++;
        if (!internal(el) && pointerish(el)) found.push(el);
      }
    }
    // Keep what is on screen first: an open menu is appended at the end of the page, after
    // a grid that can use up the cap.
    found.sort(function (a, b) { return onScreen(b) - onScreen(a); });
    found.forEach(function (el) {
      if (clickables.size >= MAX_CLICKABLE) return;
      clickables.add(el); ctxOf.set(el, ctx); mine.push(el); extra++;
    });
    // Keep reading order when clickables were added among the tag-matched controls.
    if (extra) mine.sort(function (a, b) { return a === b ? 0 : (a.compareDocumentPosition(b) & 4 ? -1 : 1); });
    Array.prototype.push.apply(nodes, mine);
    shadows.forEach(function (sr) { collect(sr, ctx); });
    frames.forEach(function (f) {
      stats.iframes++;
      var doc = null;
      try { doc = f.contentDocument; } catch (e) { doc = null; }
      if (!doc) {
        var origin = '';
        try { origin = new URL(f.getAttribute('src') || 'about:blank', (f.ownerDocument || document).baseURI).origin; } catch (e) { origin = String(f.getAttribute('src') || '').slice(0, 80); }
        if (crossOrigin.length < MAX_FRAMES) crossOrigin.push(origin);
        // A cross-origin document cannot be read here. Keep its actual navigable
        // URL and visible size so callers can explain a large embedded form.
        if (inaccessibleFrames.length < MAX_FRAMES && !internal(f) && visible(f)) {
          var fr = f.getBoundingClientRect();
          var fw = Math.max(0, Math.min(vw, ctx.ox + fr.right) - Math.max(0, ctx.ox + fr.left));
          var fh = Math.max(0, Math.min(vh, ctx.oy + fr.bottom) - Math.max(0, ctx.oy + fr.top));
          try {
            var frameURL = new URL(f.getAttribute('src') || '', (f.ownerDocument || document).baseURI);
            if (/^https?:$/.test(frameURL.protocol) && !frameURL.username && !frameURL.password && fw * fh > 0)
              inaccessibleFrames.push({ src: frameURL.href, origin: frameURL.origin, viewportFraction: fw * fh / Math.max(1, vw * vh) });
          } catch (e) {}
        }
        return;
      }
      if (ctx.depth + 1 > MAX_FRAME_DEPTH || frameCount >= MAX_FRAMES || internal(f) || !visible(f)) return;
      frameCount++;
      var r = f.getBoundingClientRect(), cs = styleOf(f);
      var child = {
        ox: ctx.ox + r.left + f.clientLeft + (parseFloat(cs.paddingLeft) || 0),
        oy: ctx.oy + r.top + f.clientTop + (parseFloat(cs.paddingTop) || 0),
        depth: ctx.depth + 1, win: doc.defaultView, frame: f,
        src: (doc.location && doc.location.href || '').slice(0, 200)
      };
      collect(doc, child);
    });
  }
  collect(document, top);

  // Custom radios and checkboxes hide the real input and show a styled label.
  // Offer the visible label in its place, with the input's role and state.
  // The label takes the input's place in reading order: appended at the end, a big page's
  // filter checkboxes fell past the row limit.
  var proxyOf = new Map(), proxyFor = new Map();
  nodes.slice().forEach(function (el) {
    if (el.tagName !== 'INPUT' || (el.type !== 'radio' && el.type !== 'checkbox') || visible(el)) return;
    var label = (el.labels && el.labels[0]) || el.closest('label');
    if (!label || !visible(label) || ctxOf.has(label)) return;
    proxyOf.set(label, el);
    proxyFor.set(el, label);
    ctxOf.set(label, ctxOf.get(el));
  });
  if (proxyFor.size) nodes = nodes.reduce(function (out, n) { out.push(n); if (proxyFor.has(n)) out.push(proxyFor.get(n)); return out; }, []);

  function boxOf(el, ctx) {
    var r = el.getBoundingClientRect();
    return { left: r.left + ctx.ox, top: r.top + ctx.oy, right: r.right + ctx.ox, bottom: r.bottom + ctx.oy, width: r.width, height: r.height };
  }

  var cands = [];
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (internal(el)) continue;
    var vis = visible(el);
    if (!opts.includeHidden && !vis) continue;
    var ctx = ctxOf.get(el) || top;
    var sid = stableId(el);
    cands.push({ el: el, ctx: ctx, vis: vis, box: boxOf(el, ctx), id: sid.id, isNew: sid.fresh && !firstRead });
  }
  var candOf = new Map();
  cands.forEach(function (c) { candOf.set(c.el, c); });

  // ---- 1. card containment ----
  // A link or button whose descendants are mostly decoration (title, price, an inner
  // tabindex span) reads as one row. Descendants with their own action stay.
  function propagating(el) {
    var tag = el.tagName, role = el.getAttribute('role');
    return tag === 'A' || tag === 'BUTTON' || role === 'button' || role === 'link' || role === 'combobox';
  }
  function contained(child, parent) {
    var area = child.width * child.height;
    if (!area) return false;
    var x = Math.max(0, Math.min(child.right, parent.right) - Math.max(child.left, parent.left));
    var y = Math.max(0, Math.min(child.bottom, parent.bottom) - Math.max(child.top, parent.top));
    return x * y / area >= 0.99;
  }
  var OWN_ACTION_ROLES = { button: 1, checkbox: 1, radio: 1, switch: 1, tab: 1, menuitem: 1, option: 1, combobox: 1, textbox: 1, slider: 1 };
  function ownAction(el, container) {
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'LABEL' || el.isContentEditable || proxyOf.has(el)) return true;
    if (tag === 'BUTTON') return true;
    var role = el.getAttribute('role');
    if (role && OWN_ACTION_ROLES[role]) return true;
    if (el.hasAttribute('onclick')) return true;
    if (tag === 'A' && el.href) return !(container.tagName === 'A' && container.href === el.href);
    if ((el.getAttribute('aria-label') || '').trim() && tag !== 'A') return true;
    return false;
  }
  var folded = 0;
  cands.forEach(function (c) {
    if (!c.vis) return;
    for (var n = c.el.parentElement || (c.el.getRootNode && (c.el.getRootNode() || {}).host); n; n = n.parentElement || (n.getRootNode && (n.getRootNode() || {}).host)) {
      var p = candOf.get(n);
      if (!p || !propagating(n)) continue;
      if (p.vis && contained(c.box, p.box) && !ownAction(c.el, n)) { c.drop = true; folded++; }
      break;
    }
  });
  cands = cands.filter(function (c) { return !c.drop; });

  // ---- 2. modals and occlusion ----
  function area(b) { return Math.max(0, b.width) * Math.max(0, b.height); }
  function fixedBox(el) {
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var p = styleOf(n).position;
      if (p === 'fixed' || p === 'sticky') return n.getBoundingClientRect();
    }
    return null;
  }
  var modals = [];
  Array.prototype.forEach.call(document.querySelectorAll('[aria-modal=true], dialog[open], [role=dialog], [role=alertdialog]'), function (m) {
    if (internal(m) || !visible(m)) return;
    var strong = m.getAttribute('aria-modal') === 'true';
    try { if (!strong && m.matches(':modal')) strong = true; } catch (e) {}
    if (!strong) {
      // A dialog role alone also names popovers and cookie bars; count it as modal
      // when it, or the fixed layer it sits in, takes a real share of the screen.
      var r = m.getBoundingClientRect(), fb = fixedBox(m);
      var big = r.width * r.height >= vw * vh * 0.25 || (fb && fb.width * fb.height >= vw * vh * 0.5);
      if (!big) return;
    }
    if (modals.some(function (o) { return within(m, o); })) return;
    modals.push(m);
  });
  // An open dropdown, menu or suggestion list is the active layer even when it is
  // rendered as a portal at the end of <body>, outside the dialog that opened it: count
  // it with the modal (not inert) and list it first, before a page's hundreds of other
  // controls use up the row limit. Only lists that are on top at their own centre count.
  var popups = [];
  Array.prototype.forEach.call(document.querySelectorAll('[role=listbox],[role=menu],[role=tree]'), function (p) {
    if (internal(p) || !visible(p) || popups.some(function (o) { return within(p, o); })) return;
    var r = p.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return;
    var hit = document.elementFromPoint(Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), Math.min(vh - 1, Math.max(0, r.top + Math.min(r.height / 2, 20))));
    if (!hit || !within(hit, p)) return;
    if (!modals.some(function (m) { return within(p, m); })) popups.push(p);
  });
  function inPopup(el) { return popups.some(function (p) { return within(el, p); }); }
  function inModal(el) { return modals.some(function (m) { return within(el, m); }) || inPopup(el); }

  function describe(el) {
    var t = (el.getAttribute && (el.getAttribute('aria-label') || '')) || '';
    if (!t) t = (el.innerText || '').trim().replace(/\s+/g, ' ');
    // A web component's popup (a country picker, a newsletter prompt) draws its text in its
    // shadow root: the host's own innerText is empty.
    if (!t && el.shadowRoot && el.shadowRoot.mode === 'open') {
      var parts = [], w = document.createTreeWalker(el.shadowRoot, NodeFilter.SHOW_TEXT);
      for (var n = w.nextNode(); n && parts.join(' ').length < 60; n = w.nextNode()) {
        if (!n.parentElement || n.parentElement.closest('style,script,template')) continue;
        var s = n.data.replace(/\s+/g, ' ').trim();
        if (s) parts.push(s);
      }
      t = parts.join(' ');
    }
    return el.tagName.toLowerCase() + (t ? ' "' + t.slice(0, 40) + '"' : '');
  }
  function owns(el, hit) {
    if (!hit) return false;
    if (hit === el || el.contains(hit) || hit.contains(el)) return true;
    var lab = el.labels && el.labels[0];
    if (lab && (lab === hit || lab.contains(hit))) return true;
    var input = proxyOf.get(el);
    if (input && (input === hit || hit.contains(input))) return true;
    return sameControl(el, hit);
  }
  // A small fixed bar (site header, cookie strip) covers whatever scrolls under it;
  // a click scrolls the target clear first, so that is not worth flagging.
  function chrome(cover) {
    if (inModal(cover)) return false;
    var fb = fixedBox(cover);
    return !!(fb && fb.height < vh * 0.3);
  }
  function occlusion(c) {
    var b = c.box;
    if (!c.vis || b.bottom <= 0 || b.top >= vh || b.right <= 0 || b.left >= vw) return null;
    var root = c.el.getRootNode && c.el.getRootNode().elementFromPoint ? c.el.getRootNode() : (c.el.ownerDocument || document);
    var pts = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
    var tested = 0, blocked = 0, centerCover = null;
    for (var k = 0; k < pts.length; k++) {
      var gx = b.left + b.width * pts[k][0], gy = b.top + b.height * pts[k][1];
      if (gx < 0 || gy < 0 || gx >= vw || gy >= vh) continue;
      tested++;
      var hit = null, mine;
      if (c.ctx.frame) {
        // The frame itself must be on top at this point, then the element inside it.
        var outer = c.ctx.frame;
        while (true) {
          var w = outer.ownerDocument.defaultView;
          if (w === window || !w.frameElement) break;
          outer = w.frameElement;
        }
        var topHit = document.elementFromPoint(gx, gy);
        if (topHit !== outer && !(topHit && topHit.contains(outer))) hit = topHit;
      }
      if (!hit) {
        var lh = root.elementFromPoint(gx - c.ctx.ox, gy - c.ctx.oy);
        // A web component's popup hits as its host, often a 0x0 box: descend to what is
        // drawn there, so its full-screen layer counts as a cover and not as a slim bar.
        for (var dk = 0; dk < 8 && lh && lh.shadowRoot && lh.shadowRoot.elementFromPoint && !owns(c.el, lh); dk++) {
          var dn = lh.shadowRoot.elementFromPoint(gx - c.ctx.ox, gy - c.ctx.oy);
          if (!dn || dn === lh) break;
          lh = dn;
        }
        mine = owns(c.el, lh);
        if (!mine) hit = lh;
      }
      if (hit && !chrome(hit)) {
        blocked++;
        if (k === 0) centerCover = hit;
      }
    }
    if (!tested || !centerCover || blocked * 2 < tested) return null;
    c.coverPinned = pinnedBar(centerCover, c.el) || clippedByScroller(c.el) || coverOutsideScroller(centerCover, c.el);
    return describe(centerCover);
  }
  // Or it sits past the visible edge of a scrolling list (a dialog's body scrolls while its
  // footer stays put): scrolling the list brings it out from under whatever is there.
  function clippedByScroller(el) {
    var r = el.getBoundingClientRect();
    for (var n = el.parentElement, k = 0; n && n !== document.body && k < 12; n = n.parentElement, k++) {
      var s = getComputedStyle(n);
      if (!/(auto|scroll|overlay)/.test(s.overflowY + ' ' + s.overflowX)) continue;
      if (n.scrollHeight <= n.clientHeight + 1 && n.scrollWidth <= n.clientWidth + 1) continue;
      var a = n.getBoundingClientRect();
      return r.top < a.top - 1 || r.bottom > a.bottom + 1 || r.left < a.left - 1 || r.right > a.right + 1;
    }
    return false;
  }
  // A cover that does not scroll with the element: the element sits in a list that can still
  // scroll and the cover is outside that list (a filter drawer's footer over its last row), so
  // scrolling the list brings the element clear. Walks up through shadow roots.
  function coverOutsideScroller(hit, el) {
    if (!hit) return false;
    for (var n = el.parentElement || (el.getRootNode && (el.getRootNode() || {}).host), k = 0; n && n !== document.body && n !== document.documentElement && k < 16; k++) {
      var s = getComputedStyle(n);
      if (/(auto|scroll|overlay)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 1) return !n.contains(hit);
      n = n.parentElement || (n.getRootNode && (n.getRootNode() || {}).host);
    }
    return false;
  }
  // A cover that is a pinned bar (a sticky header or a dialog's fixed footer, not holding the
  // element) only hides what scrolled under it: scrolling brings the element clear, as a click
  // by ref does. Airbnb's filter dialog keeps "Gym" under its "Clear all / Show places" footer.
  function pinnedBar(hit, el) {
    for (var n = hit, k = 0; n && n.nodeType === 1 && k < 8; n = n.parentElement, k++) {
      var p = getComputedStyle(n).position;
      if (p === 'fixed' || p === 'sticky') {
        if (n.contains(el)) return false;
        var r = n.getBoundingClientRect();
        return r.height < vh * 0.35;
      }
    }
    return false;
  }

  // ---- 3. viewport window ----
  var omitted = { above: 0, below: 0 };
  var kept = [];
  cands.forEach(function (c) {
    c.popup = popups.length ? inPopup(c.el) : false;
    c.modal = modals.length || c.popup ? inModal(c.el) : false;
    var b = c.box;
    var near = !c.vis || (b.bottom >= -vh && b.top <= 2 * vh && b.right >= -vw && b.left <= 2 * vw);
    if (!opts.all && !near && !c.modal) {
      if (b.bottom < -vh) omitted.above++; else omitted.below++;
      return;
    }
    kept.push(c);
  });
  stats.interactive = cands.filter(function (c) { return c.vis; }).length;
  if (modals.length || popups.length) {
    kept = kept.filter(function (c) { return c.popup; })
      .concat(kept.filter(function (c) { return c.modal && !c.popup; }), kept.filter(function (c) { return !c.modal; }));
  }
  var overLimit = Math.max(0, kept.length - limit);
  kept = kept.slice(0, limit);

  var rows = [], els = [];
  var active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  kept.forEach(function (c) {
    var el = c.el, b = c.box, input = proxyOf.get(el);
    var row = {
      ref: 'ref_' + (rows.length + 1),
      id: c.id,
      role: input ? input.type : roleOf(el),
      name: accName(el),
      tag: el.tagName.toLowerCase(),
      box: { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }
    };
    var ctxName = contextName(el, (row.name || '').trim());
    if (ctxName) { row.name = ctxName; row.nameFrom = 'context'; if (/\(unnamed button\)$/.test(ctxName)) row.borrowed = true; }
    var fieldName = !ctxName && !input && fieldContextName(el, (row.name || '').trim());
    if (fieldName) { row.name = fieldName.name; row.nameFrom = 'context'; if (fieldName.hint) row.placeholder = fieldName.hint.slice(0, 80); }
    // Still nameless: a button's test id says what it is ("structured-search-input-search-button"
    // reads as "search"). A made-up name, so it competes only when the intent shares a word.
    if (!(row.name || '').trim() && buttonish(el)) {
      var tidName = (testid(el) || '').split(/[-_\s.:]+|(?=[A-Z])/).map(function (w) { return w.toLowerCase(); })
        .filter(function (w) { return w.length > 1 && !/^(button|btn|icon|input|structured|wrapper|container|cta|primary|secondary|ui|el|elem|element|item|component|\d+)$/.test(w); });
      if (tidName.length) { row.name = tidName.slice(-3).join(' '); row.nameFrom = 'context'; row.derived = true; }
    }
    if (c.popup) row.popup = true;
    // A button that sends its form (a sign-up, a payment): what commits, whatever its name.
    try { if ((el.tagName === 'BUTTON' || el.tagName === 'INPUT') && el.type === 'submit' && el.form) row.submit = true; } catch (e) {}
    var tid = testid(el);
    if (tid) row.testid = tid;
    if (el.disabled) row.disabled = true;
    if (el.checked || (input && input.checked)) row.checked = true;
    // A toggle button (an amenity filter) says on or off with aria-pressed.
    var pressed = el.getAttribute && el.getAttribute('aria-pressed');
    if (pressed === 'true' || pressed === 'false') row.pressed = pressed === 'true';
    if (input && input.disabled) row.disabled = true;
    if (el.value !== undefined && el.value !== '' && el.type !== 'password') row.value = String(el.value).slice(0, 80);
    if (el.getAttribute('aria-expanded')) row.expanded = el.getAttribute('aria-expanded') === 'true';
    if (el.tagName.toLowerCase() === 'a' && el.href) row.href = el.href.slice(0, 200);
    if (!c.vis) row.hidden = true;
    if (c.isNew) row.new = true;
    try { if (el.closest('[role=search],[class*=filter i],[class*=token i],[class*=search-bar i],[class*=searchbar i],[data-testid*=filter i]')) row.infilter = true; } catch (e) {}
    // The hint a person reads in an empty field ("Search or filter results…") when the
    // accessible name is generic ("Search").
    var ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph && ph.trim() && ph.trim() !== row.name) row.placeholder = ph.trim().slice(0, 80);
    if (el === active && el !== document.body) row.focused = true;
    // An open dropdown, menu or suggestion list holding the element: what a step that
    // follows "type into the search box" usually means.
    var pop = null;
    try { pop = el.closest('[role=listbox],[role=menu],[role=tree],[role=dialog],[role=alertdialog],[role=tooltip]'); } catch (e) {}
    if (pop && pop !== el) row.within = pop.getAttribute('role') + ((pop.getAttribute('aria-label') || '') ? ' "' + pop.getAttribute('aria-label').slice(0, 40) + '"' : '');
    if (c.vis && (b.bottom <= 0 || b.top >= vh)) row.offscreen = b.bottom <= 0 ? 'above' : 'below';
    if (c.modal) row.modal = true;
    var inert = false;
    try { inert = !!(el.closest && el.closest('[inert]')); } catch (e) {}
    var cover = occlusion(c);
    // Two popups stacked (a cookie dialog, and a web component's region picker drawn over it):
    // the one on top is the active layer even though the dialog below is the marked modal. A
    // control on screen that nothing covers, inside a fixed layer over a real share of the
    // screen (found up through shadow hosts), is not inert behind that modal.
    var onTopLayer = false;
    if (modals.length && !c.modal && !inert && !cover && c.vis && b.bottom > 0 && b.top < vh && b.right > 0 && b.left < vw) {
      for (var ln = el, lk = 0; ln && lk < 40; lk++) {
        if (ln.nodeType === 1) {
          var lp = styleOf(ln).position;
          if (lp === 'fixed') { var lb = ln.getBoundingClientRect(); onTopLayer = lb.width * lb.height >= vw * vh * 0.2; break; }
        }
        ln = ln.parentElement || (ln.getRootNode && ln.getRootNode() !== document && (ln.getRootNode() || {}).host) || null;
      }
    }
    if (((modals.length && !c.modal) || inert) && !onTopLayer) row.inert = true;
    if (cover) { row.covered = cover; if (c.coverPinned) row.coverPinned = true; }
    if (c.ctx.frame) row.frame = c.ctx.src;
    rows.push(row);
    els.push(el);
  });

  var token = String(Date.now()) + ':' + Math.random().toString(36).slice(2, 8);
  var idsOf = {};
  rows.forEach(function (r, k) { idsOf[r.id] = k; });
  window.__cdp = { token: token, els: els, url: location.href, ids: idsOf };
  // Earlier snapshots stay addressable by token, so refs an agent read before another
  // read (by do or --intent) still mean the elements it saw.
  var snaps = window.__cdpSnaps || (window.__cdpSnaps = { order: [], by: {} });
  snaps.by[token] = window.__cdp;
  snaps.order.push(token);
  while (snaps.order.length > 8) delete snaps.by[snaps.order.shift()];

  var text = '';
  try { text = deepText() || ''; } catch (e) { try { text = (document.body ? document.body.innerText : '') || ''; } catch (e2) { text = ''; } }
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  var truncated = text.length > maxText;

  // ---- 4. loading signals ----
  var skeletons = 0, blocks = 0, pendingImages = 0;
  try {
    var bodyEls = document.body ? document.body.getElementsByTagName('*') : [];
    var leaves = 0;
    for (var s = 0; s < bodyEls.length && s < 20000; s++) {
      var n = bodyEls[s];
      if (internal(n)) continue;
      var cls = typeof n.className === 'string' ? n.className : (n.getAttribute('class') || '');
      var marked = n.getAttribute('aria-busy') === 'true' || /skeleton|shimmer|placeholder|loading|spinner/i.test(cls);
      if (n.tagName === 'IMG' && n.getAttribute('src') && !n.complete && n.getAttribute('loading') !== 'lazy') pendingImages++;
      if (marked) { if (visible(n) && !(n.parentElement && n.parentElement.closest('[aria-busy=true], [class*=skeleton], [class*=shimmer]'))) skeletons++; continue; }
      // An empty grey block: a leaf with a background and no content.
      if (n.children.length || leaves >= 3000 || /^(IMG|INPUT|SVG|CANVAS|VIDEO|IFRAME|HR|BR|SELECT|TEXTAREA|BUTTON|PATH|svg|path)$/.test(n.tagName)) continue;
      leaves++;
      if ((n.textContent || '').trim()) continue;
      var r = n.getBoundingClientRect();
      if (r.width < 30 || r.height < 8 || r.bottom < 0 || r.top > vh * 2) continue;
      var st = styleOf(n), bg = st.backgroundColor;
      if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg) && st.backgroundImage === 'none' && st.visibility !== 'hidden' && st.display !== 'none' && n !== document.body) {
        if (r.width < vw * 0.9 || r.height < vh * 0.5) blocks++;
      }
    }
  } catch (e) {}
  stats.skeletons = skeletons + blocks;
  if (pendingImages) stats.pendingImages = pendingImages;
  if (crossOrigin.length) stats.crossOrigin = crossOrigin;
  if (inaccessibleFrames.length) stats.inaccessibleFrames = inaccessibleFrames;
  if (folded) stats.folded = folded;
  var why = [];
  if (document.readyState !== 'complete') why.push('document is still loading (readyState ' + document.readyState + ')');
  // Marked placeholders are strong evidence; bare grey blocks need to come in numbers.
  if (skeletons >= 2 || blocks >= 6 || skeletons + blocks >= 4) why.push((skeletons + blocks) + ' skeleton or placeholder blocks');
  if (pendingImages >= 3) why.push(pendingImages + ' images still loading');
  if (text.length < 200 && stats.interactive < 3) why.push('the page has almost no content yet');

  var se = document.scrollingElement || document.documentElement;
  var sh = Math.max(se ? se.scrollHeight : 0, document.body ? document.body.scrollHeight : 0);
  var sy = window.scrollY;
  var round1 = function (x) { return Math.max(0, Math.round(x * 10) / 10); };

  var out = {
    token: token,
    url: location.href,
    title: document.title,
    scroll: { y: Math.round(sy), h: Math.round(document.body ? document.body.scrollHeight : 0), vh: vh, above: vh ? round1(sy / vh) : 0, below: vh ? round1((sh - sy - vh) / vh) : 0 },
    stats: stats,
    elements: rows,
    text: truncated ? text.slice(0, maxText) : text,
    textTruncated: truncated,
    textLength: text.length
  };
  if (why.length) out.loading = 'page may still be loading: ' + why.join('; ');
  if (modals.length) out.modal = { role: modals[0].getAttribute('role') || modals[0].tagName.toLowerCase(), name: (modals[0].getAttribute('aria-label') || (modals[0].getAttribute('aria-labelledby') || '').split(/\s+/).map(function (id) { var label = document.getElementById(id); return label ? label.textContent.trim() : ''; }).filter(Boolean).join(' ') || (modals[0].innerText || '').trim().split('\n')[0] || '').slice(0, 80) };
  var omittedTotal = omitted.above + omitted.below + overLimit;
  if (omittedTotal) out.omitted = { above: omitted.above, below: omitted.below, overLimit: overLimit, total: omittedTotal };
  return out;
})

// read_page: a compact snapshot of what a page offers, with stable refs.
//
// This is the single biggest usability difference between raw CDP and the
// Claude-in-Chrome style of driving a browser. Instead of guessing CSS
// selectors or pixel coordinates, you read the page once, get ref_1..ref_N for
// the interactive elements, and act on those refs. Refs live on the page in
// window.__cdp and are invalidated by navigation, which we detect rather than
// silently clicking the wrong thing.

// Serialized and evaluated in the page. Keep it dependency-free and defensive:
// it runs on arbitrary sites.
//
// Beyond listing controls, the snapshot applies the page-reading techniques of Browser
// Use's serializer, adapted to a live-DOM read:
// - a card that is one big link is one row: descendants that sit inside a link or
//   button and carry no action of their own are folded into it;
// - elements another element covers are marked (not dropped), and when a modal is open
//   everything outside it is inert and its controls come first;
// - every element keeps a stable id across reads of the same document, and rows not seen
//   by an earlier read are marked new;
// - page stats, loading signals and how much page lies above and below;
// - same-origin iframes are read in (with offsets so refs click the right point);
// - by default only elements within about one screen of the viewport are listed.
// A point on a control's own parts is not a cover: the checkbox input stretched over its
// label text, the label wrapping it, or the option row holding both. Shared by the
// snapshot's "covered" flag and by ref resolution before a click.
const SAME_CONTROL = `
  function sameControl(el, hit) {
    if (!el || !hit || !hit.closest) return false;
    var lab = el.closest && el.closest('label');
    if (lab && lab.contains(hit)) return true;
    var hlab = hit.closest('label');
    if (hlab && hlab.contains(el)) return true;
    if (hit.labels) for (var i = 0; i < hit.labels.length; i++) if (hit.labels[i] === el || hit.labels[i].contains(el)) return true;
    var n = el, k = 0;
    for (; n && n.nodeType === 1 && k < 4; n = n.parentElement, k++) {
      var role = n.getAttribute && n.getAttribute('role');
      if (/^(option|checkbox|radio|menuitemcheckbox|menuitemradio|switch|tab|treeitem)$/.test(role || '') && n.contains(hit)) return true;
    }
    // A bare checkbox or radio laid over its row (no label element), as custom filters do.
    if (hit.tagName === 'INPUT' && /^(checkbox|radio)$/.test(hit.type)) {
      var p = hit.parentElement;
      for (k = 0; p && k < 2; p = p.parentElement, k++) if (p.contains(el)) return true;
    }
    return false;
  }
`;

// The page's text as a person reads it, including what web components draw in open shadow
// roots: document.body.innerText stops at every shadow boundary, so a quiz or a popup built
// as a component is blank to it. Pages without shadow text keep innerText's own output.
// Page-side source of a function deepText(); call it, or use deepTextExpression().
export const DEEP_TEXT_FN = `function deepText() {
  var body = document.body;
  if (!body) return '';
  var plain = body.innerText || '';
  // Only when shadow roots hold text worth reading: otherwise innerText is the better read
  // (it knows tables, pre and line breaks).
  var hosts = [], stack = [document], seen = 0, shadowChars = 0;
  while (stack.length && seen < 30000) {
    var r = stack.pop(), all = r.querySelectorAll('*');
    for (var i = 0; i < all.length; i++, seen++) {
      var sr = all[i].shadowRoot;
      if (sr && sr.mode === 'open') { hosts.push(all[i]); stack.push(sr); shadowChars += (sr.textContent || '').replace(/\\s+/g, '').length; }
    }
  }
  if (!hosts.length || shadowChars < 20) return plain;
  var BLOCK = /^(block|flex|grid|list-item|table|table-row|table-caption|flow-root|-webkit-box)$/;
  var out = [], styleOf = new Map();
  function style(el) { var s = styleOf.get(el); if (!s) { s = getComputedStyle(el); styleOf.set(el, s); } return s; }
  function walk(node) {
    if (node.nodeType === 3) {
      var t = node.data.replace(/[ \\t\\r\\n\\f]+/g, ' ');
      if (t.trim()) out.push(t);
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    var block = false;
    if (node.nodeType === 1) {
      var tag = node.tagName;
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HEAD|svg|SVG)$/.test(tag)) return;
      if (node.hasAttribute('data-cdp') || node.getAttribute('data-cdp-internal') === 'true') return;
      var s = style(node);
      if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return;
      if (tag === 'BR') { out.push('\\n'); return; }
      block = BLOCK.test(s.display);
      if (block) out.push('\\n');
      if (node.shadowRoot && node.shadowRoot.mode === 'open') {
        for (var c = node.shadowRoot.firstChild; c; c = c.nextSibling) walk(c);
        if (block) out.push('\\n');
        return;
      }
      if (tag === 'SLOT') {
        var assigned = node.assignedNodes({ flatten: true });
        if (assigned.length) { for (var a = 0; a < assigned.length; a++) walk(assigned[a]); if (block) out.push('\\n'); return; }
      }
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { if (block) out.push('\\n'); return; }
    }
    for (var k = node.firstChild; k; k = k.nextSibling) walk(k);
    if (block) out.push('\\n');
  }
  walk(body);
  return out.join('').split('\\n').map(function (l) { return l.replace(/ {2,}/g, ' ').trim(); })
    .join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
}`;

// A ref or pin whose element the page replaced with a fresh copy (results arriving redraw
// the filters; a client-side route change rebuilds the form): the same control is the one
// connected element with the same tag and the same identifying attributes and text, shown
// on screen. Page-side source of bcSig(el) and bcRefind(sig); null when none or several match.
export const REFIND_FN = `function bcSig(el) {
  var a = function (n) { return (el.getAttribute && el.getAttribute(n)) || ''; };
  var text = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ? '' : (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  return { tag: el.tagName, id: el.id || '', type: a('type'), role: a('role'), name: a('name'), label: a('aria-label'), ph: a('placeholder'), href: a('href'), text: text };
}
function bcRefind(sig) {
  if (!sig || !(sig.id || sig.label || sig.name || sig.ph || sig.text || sig.href)) return null;
  var keys = ['type', 'role', 'name', 'label', 'ph', 'href', 'text'];
  var hits = [], stack = [document], seen = 0;
  while (stack.length && seen < 30000) {
    var root = stack.pop(), all = root.querySelectorAll(sig.tag);
    for (var i = 0; i < all.length; i++, seen++) {
      var el = all[i], s = bcSig(el), ok = true;
      for (var k = 0; k < keys.length && ok; k++) if (s[keys[k]] !== sig[keys[k]]) ok = false;
      if (ok && sig.id && s.id !== sig.id) ok = false;
      if (!ok) continue;
      var r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      if (r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none') hits.push(el);
    }
    var hosts = root.querySelectorAll('*');
    for (var h = 0; h < hosts.length; h++) if (hosts[h].shadowRoot && hosts[h].shadowRoot.mode === 'open') stack.push(hosts[h].shadowRoot);
  }
  return hits.length === 1 ? hits[0] : null;
}`;

export function deepTextExpression() {
  return `(${DEEP_TEXT_FN.replace('function deepText()', 'function ()')})()`;
}

const SNAPSHOT_FN = `
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

  function styleOf(el) {
    var w = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    return w.getComputedStyle(el);
  }
  function visible(el) {
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var s = styleOf(el);
    if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity || '1') < 0.05) return false;
    return true;
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

  function nameOf(el) {
    var doc = el.ownerDocument || document;
    // ids and label[for] resolve in the element's own tree: a control inside a component's
    // shadow root is labelled by a <label> in that same shadow root.
    var tree = el.getRootNode && el.getRootNode();
    if (!tree || !tree.querySelector) tree = doc;
    var byId = function (id) { return (tree.getElementById ? tree.getElementById(id) : tree.querySelector('#' + CSS.escape(id))) || doc.getElementById(id); };
    var t = (el.getAttribute('aria-label') || '').trim();
    if (t) return t;
    var labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      var parts = labelledby.split(/\\s+/).map(function (id) {
        var n = byId(id);
        return n ? (n.innerText || n.textContent || '').trim() : '';
      }).filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    if (el.id) {
      var lab = tree.querySelector('label[for="' + CSS.escape(el.id) + '"]') || doc.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab) {
        var lt = (lab.innerText || lab.textContent || '').trim().replace(/\\s+/g, ' ');
        if (lt) return lt;
      }
    }
    var enclosing = el.closest('label');
    if (enclosing && enclosing !== el) {
      var wrapped = (enclosing.innerText || enclosing.textContent || '').trim().replace(/\\s+/g, ' ');
      if (wrapped) return wrapped;
    }
    var own = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (own) return own.slice(0, 120);
    // A control inside a component's shadow root with no text of its own (an accordion's
    // <summary> whose slot is empty) is named by the component's heading or label.
    if (tree && tree.host && /^(SUMMARY|BUTTON)$/.test(el.tagName)) {
      var hh = tree.host.querySelector('[slot=summary],[slot=heading],[slot=label],h1,h2,h3,h4,h5,h6,label');
      var ht = hh ? (hh.innerText || hh.textContent || '').trim().replace(/\\s+/g, ' ') : '';
      if (ht) return ht.slice(0, 120);
    }
    // An icon-only control names itself through its icon: an svg's aria-label or <title>,
    // an image's alt (Airbnb's magnifier search button).
    try {
      var icon = el.querySelector('svg[aria-label],[role=img][aria-label],img[alt]');
      var il = icon ? (icon.getAttribute('aria-label') || icon.getAttribute('alt') || '').trim() : '';
      if (il) return il.slice(0, 120);
      var st = el.querySelector('svg title');
      if (st && (st.textContent || '').trim()) return st.textContent.trim().slice(0, 120);
    } catch (e) {}
    return (el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') ||
            el.getAttribute('name') || (['password','file','hidden'].includes(el.type) ? '' : el.value) || '').toString().trim().slice(0, 120);
  }

  // An icon-only button (a stepper's +/−, a bare ×) has no name of its own. Name it from
  // its row ("Children", "Ages 2-17") and its direction, read from its symbol, its
  // attributes or, for a pair of unnamed buttons around a count, its position.
  var SYMBOL = /^[+\\-−–×✕⨯x]?$/i;
  function buttonish(el) {
    var tag = el.tagName, role = el.getAttribute('role');
    return tag === 'BUTTON' || role === 'button' || (tag === 'INPUT' && /^(button|submit)$/.test(el.type));
  }
  function rowLabel(el) {
    for (var n = el.parentElement, k = 0; n && n !== document.body && k < 4; n = n.parentElement, k++) {
      var lines = (n.innerText || '').split(/\\n+/).map(function (s) { return s.trim(); })
        .filter(function (s) { return /[A-Za-z\\u00C0-\\uFFFF]{2}/.test(s) && s.length <= 60; });
      if (lines.length) return { text: lines[0].slice(0, 60), row: n }; // the row's label, not its sub-line ("Ages 2-17")
    }
    return null;
  }
  function directionOf(el, own, row) {
    if (/^\\+$/.test(own)) return 1;
    if (/^[\\-−–]$/.test(own)) return -1;
    var attrs = [el.getAttribute('data-testid'), el.getAttribute('data-test'), el.getAttribute('title'), el.getAttribute('name'), typeof el.className === 'string' ? el.className : '', el.innerHTML.slice(0, 300)].join(' ');
    if (/increase|increment|plus|\\badd\\b|\\bup\\b|more/i.test(attrs)) return 1;
    if (/decrease|decrement|minus|subtract|remove|\\bdown\\b|less/i.test(attrs)) return -1;
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
  var CLOSES = /(^|[\\s_-])(close|closer|dismiss|cancel)([\\s_-]|btn|button|icon|$)|(^|[\\s_-])x-?mark|modal-x|icon-x([\\s_-]|$)/i;
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
    return ids.split(/\\s+/).map(function (id) { var n = doc.getElementById(id); return n ? (n.innerText || n.textContent || '').trim() : ''; })
      .filter(Boolean).join(' ').replace(/\\s+/g, ' ').slice(0, 80);
  }
  var FIELD_SEL = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]),textarea,select,[role=combobox],[role=textbox],[role=searchbox]';
  function fieldContextName(el, name) {
    if (name || !fieldish(el)) return null;
    var hint = (el.getAttribute('placeholder') || '').trim() || textOfIds(el, 'aria-describedby');
    var skip = [hint, String(el.value || '').trim()].filter(Boolean);
    for (var n = el.parentElement, k = 0; n && n !== document.body && k < 6; n = n.parentElement, k++) {
      var fields = Array.prototype.filter.call(n.querySelectorAll(FIELD_SEL), function (f) { return f !== el && !el.contains(f) && !f.contains(el) && f.getClientRects().length; });
      if (fields.length) break; // the row holds other fields too: its text is not this one's label
      var lines = (n.innerText || '').split(/\\n+/).map(function (s) { return s.trim(); })
        .filter(function (s) { return /[A-Za-z\\u00C0-\\uFFFF]{2}/.test(s) && s.length <= 60 && skip.indexOf(s) < 0; });
      if (lines.length) return { name: lines[0], hint: hint };
    }
    return hint ? { name: hint, hint: '' } : null;
  }

  function roleOf(el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit;
    if (clickables.has(el)) return 'clickable';
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio' || type === 'file' || type === 'submit' || type === 'button') return type;
      if (type === 'range') return 'slider'; // set with set, not typed into
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return tag;
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
    if (!t) t = (el.innerText || '').trim().replace(/\\s+/g, ' ');
    // A web component's popup (a country picker, a newsletter prompt) draws its text in its
    // shadow root: the host's own innerText is empty.
    if (!t && el.shadowRoot && el.shadowRoot.mode === 'open') {
      var parts = [], w = document.createTreeWalker(el.shadowRoot, NodeFilter.SHOW_TEXT);
      for (var n = w.nextNode(); n && parts.join(' ').length < 60; n = w.nextNode()) {
        if (!n.parentElement || n.parentElement.closest('style,script,template')) continue;
        var s = n.data.replace(/\\s+/g, ' ').trim();
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
${SAME_CONTROL}
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
      name: nameOf(el),
      tag: el.tagName.toLowerCase(),
      box: { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }
    };
    var ctxName = contextName(el, (row.name || '').trim());
    if (ctxName) { row.name = ctxName; row.nameFrom = 'context'; if (/\\(unnamed button\\)$/.test(ctxName)) row.borrowed = true; }
    var fieldName = !ctxName && !input && fieldContextName(el, (row.name || '').trim());
    if (fieldName) { row.name = fieldName.name; row.nameFrom = 'context'; if (fieldName.hint) row.placeholder = fieldName.hint.slice(0, 80); }
    // Still nameless: a button's test id says what it is ("structured-search-input-search-button"
    // reads as "search"). A made-up name, so it competes only when the intent shares a word.
    if (!(row.name || '').trim() && buttonish(el)) {
      var tidName = (testid(el) || '').split(/[-_\\s.:]+|(?=[A-Z])/).map(function (w) { return w.toLowerCase(); })
        .filter(function (w) { return w.length > 1 && !/^(button|btn|icon|input|structured|wrapper|container|cta|primary|secondary|ui|el|elem|element|item|component|\\d+)$/.test(w); });
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
  // read (by do, --intent, an MCP client) still mean the elements it saw.
  var snaps = window.__cdpSnaps || (window.__cdpSnaps = { order: [], by: {} });
  snaps.by[token] = window.__cdp;
  snaps.order.push(token);
  while (snaps.order.length > 8) delete snaps.by[snaps.order.shift()];

  ${DEEP_TEXT_FN}
  var text = '';
  try { text = deepText() || ''; } catch (e) { try { text = (document.body ? document.body.innerText : '') || ''; } catch (e2) { text = ''; } }
  text = text.replace(/\\n{3,}/g, '\\n\\n').trim();
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
      if (bg && bg !== 'transparent' && !/rgba\\(.*,\\s*0\\)$/.test(bg) && st.backgroundImage === 'none' && st.visibility !== 'hidden' && st.display !== 'none' && n !== document.body) {
        if (r.width < vw * 0.9 || r.height < vh * 0.5) blocks++;
      }
    }
  } catch (e) {}
  stats.skeletons = skeletons + blocks;
  if (pendingImages) stats.pendingImages = pendingImages;
  if (crossOrigin.length) stats.crossOrigin = crossOrigin;
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
  if (modals.length) out.modal = { role: modals[0].getAttribute('role') || modals[0].tagName.toLowerCase(), name: (modals[0].getAttribute('aria-label') || (modals[0].innerText || '').trim().split('\\n')[0] || '').slice(0, 80) };
  var omittedTotal = omitted.above + omitted.below + overLimit;
  if (omittedTotal) out.omitted = { above: omitted.above, below: omitted.below, overLimit: overLimit, total: omittedTotal };
  return out;
})
`;

// A cheap look at whether the page is still loading, for settle(): the document's ready
// state and the marked placeholders the snapshot counts (aria-busy, skeleton, shimmer,
// spinner and loading classes, a visible progressbar), plus a signature that changes
// while the page is still filling in.
export const LOADING_EXPR = `(function () {
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
    if (bar) bars++; else if (n.getAttribute('aria-busy') === 'true') busy++; else if (btn && /(^|[-_\\s])(is-)?loading\\b|--loading/i.test(cls)) buttons++; else marked++;
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
})()`;

export function snapshotExpression(opts = {}) {
  return `(${SNAPSHOT_FN})(${JSON.stringify(opts)})`;
}

// A JS expression for the element behind a ref (ref_N, or a stable eN id) in the
// snapshot with this token (the latest snapshot without one), or an error code string.
export function refLookupExpression(ref, token) {
  return `(function () {
  var want = ${JSON.stringify(String(ref || ''))}, token = ${JSON.stringify(token || null)};
  var latest = window.__cdp, snaps = window.__cdpSnaps;
  var state = token ? (snaps && snaps.by[token]) || (latest && latest.token === token ? latest : null) : latest;
  if (!state) return latest ? 'stale' : 'no_snapshot';
  var idx = /^e\\d+$/.test(want) ? (state.ids || {})[want] : parseInt(want.replace('ref_', ''), 10) - 1;
  if (idx === undefined && /^e\\d+$/.test(want) && latest && latest !== state) { state = latest; idx = (latest.ids || {})[want]; }
  var el = idx === undefined || isNaN(idx) ? null : state.els[idx];
  if (!el) return 'unknown_ref';
  if (!el.isConnected) {
    // The page redrew it (same document, maybe a client-side route change): the one copy now
    // on screen with the same tag, attributes and text is the same control.
    ${REFIND_FN}
    var again = bcRefind(bcSig(el));
    if (again) { state.els[idx] = again; window.__bcRefound = want; return again; }
    return state.url !== location.href ? 'navigated' : 'detached';
  }
  // A frame that loaded a new page keeps the old document alive but windowless: its
  // elements still say they are connected, yet nothing typed into them reaches the page.
  if (!el.ownerDocument || !el.ownerDocument.defaultView) return 'frame_replaced';
  return el;
})()`;
}

// A page-side lookup by CSS selector that also searches open shadow roots, for elements
// browserctrl pinned (data-bc-pin) or a caller named inside web components:
// document.querySelector stops at every shadow boundary.
export function deepQuery(selector) {
  return `(function (s) {
    var hit = document.querySelector(s); if (hit) return hit;
    var stack = [document], seen = 0;
    while (stack.length && seen < 20000) {
      var root = stack.pop(), all = root.querySelectorAll('*');
      for (var i = 0; i < all.length; i++, seen++) {
        var sr = all[i].shadowRoot;
        if (sr) { var m = sr.querySelector(s); if (m) return m; stack.push(sr); }
      }
    }
    return null;
  })(${JSON.stringify(selector)})`;
}

// Resolve a ref back to its element and return what an action needs: the
// center point in CSS pixels, plus whether it is still on the same page.
export function resolveRefExpression(ref, token) {
  return resolveElementExpression(refLookupExpression(ref, token));
}

// The same for a CSS selector (shadow roots are not searched; a pinned data-bc-pin works).
// A selector click gets the same checks as a ref click: scroll only when out of view, and
// refuse a point that something else covers (a panel's footer over the last list row).
export function resolveSelectorExpression(selector) {
  return resolveElementExpression(`(${deepQuery(selector)} || 'no_match')`);
}

function resolveElementExpression(lookup) {
  return `
(function () {
  var el = ${lookup};
  if (typeof el === 'string') return { error: el };
  for (var node = el; node; node = node.parentElement || (node.getRootNode && (node.getRootNode() || {}).host)) {
    if (node.nodeType === 1 && (node.hasAttribute('data-cdp') || node.getAttribute('data-cdp-internal') === 'true')) return { error: 'internal' };
  }
  // A checkbox or radio kept visually hidden (a 1px input behind a size swatch or a filter's
  // label) is clicked through its visible label, as a person does: its own 1px box can sit
  // just outside the label, where a click lands on nothing.
  if (el.matches && el.matches('input[type=checkbox],input[type=radio]')) {
    var ib = el.getBoundingClientRect(), ist = getComputedStyle(el);
    if (ib.width < 4 || ib.height < 4 || parseFloat(ist.opacity || '1') < 0.05 || ist.visibility === 'hidden') {
      var labs = el.labels ? Array.prototype.slice.call(el.labels) : [];
      var shownLab = labs.filter(function (l) { var lb = l.getBoundingClientRect(); return lb.width >= 4 && lb.height >= 4 && getComputedStyle(l).visibility !== 'hidden'; })[0];
      if (shownLab) el = shownLab;
    }
  }
  // Scroll only an element that is not wholly in view: scrolling one that is moved Airbnb's
  // page on every stepper click, which collapsed its search bar and removed the Search
  // button. One in a frame still scrolls (the frame itself may be off screen); a covered one
  // is scrolled clear by the caller.
  var inFrame = el.ownerDocument !== document;
  var vr = el.getBoundingClientRect();
  if (inFrame || !vr.width || !vr.height || vr.top < 0 || vr.left < 0 || vr.bottom > innerHeight || vr.right > innerWidth) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  }
  // An element in a same-origin frame: its rect is in the frame's viewport, so add each
  // frame's content-box offset to get a point in the top page.
  var chain = [], ox = 0, oy = 0;
  try {
    for (var w = el.ownerDocument.defaultView; w && w !== window && w.frameElement; w = w.parent) chain.push(w.frameElement);
  } catch (e) {}
  for (var f = 0; f < chain.length; f++) {
    var fe = chain[f], fr = fe.getBoundingClientRect(), fs = fe.ownerDocument.defaultView.getComputedStyle(fe);
    ox += fr.left + fe.clientLeft + (parseFloat(fs.paddingLeft) || 0);
    oy += fr.top + fe.clientTop + (parseFloat(fs.paddingTop) || 0);
  }
  var outer = chain.length ? chain[chain.length - 1] : null;
  var view = el.ownerDocument.defaultView || window;
  // A web component whose own control lives in its shadow root (a design-system accordion's
  // <summary>, a button wrapping a slot): the click must land on that control, not on the
  // host's other parts (its content slot does nothing), so hit-test against the inner control.
  var CTL = 'summary,button,[role=button],a[href],input,select,textarea';
  var inner = el.shadowRoot && !/^(option|menuitem|menuitemradio|treeitem|gridcell)$/.test((el.getAttribute && el.getAttribute('role')) || '') && el.shadowRoot.querySelector(CTL);
  // Content slotted into a component (its heading) belongs to the control around its slot,
  // or, when the slot sits outside any control, to the component's own control: clicking an
  // accordion's heading means its toggle, though the heading is drawn over a slot that does nothing.
  // Only for content that is not a control itself (a heading, a label's text): a slotted
  // option or button is its own target. And the component's own control counts only when it
  // is a disclosure (<summary>): an option slotted into a select belongs to the list, not to
  // the select's button.
  var ownRole = el.getAttribute && el.getAttribute('role');
  var isCtl = (el.matches && el.matches(CTL)) || /^(option|button|link|checkbox|radio|menuitem|menuitemcheckbox|menuitemradio|tab|switch|combobox|treeitem|gridcell|slider|spinbutton)$/.test(ownRole || '');
  var slot = !inner && !isCtl && el.assignedSlot;
  if (slot) {
    var shost = slot.getRootNode && (slot.getRootNode() || {}).host;
    inner = (slot.closest && slot.closest(CTL)) || (shost && shost.shadowRoot && shost.shadowRoot.querySelector('summary')) || null;
  }
  var tgt = inner && inner.getBoundingClientRect().width > 0 ? inner : el;
  var r = tgt.getBoundingClientRect();
  // Click where the element is actually on top: a sticky bar, an overlay or a late layout
  // shift can put something else under its centre. Try the centre, then inner points.
  var root = el.getRootNode && el.getRootNode().elementFromPoint ? el.getRootNode() : el.ownerDocument;
  ${SAME_CONTROL}
  // Is a inside b across shadow boundaries and slots (slotted content belongs to its slot)?
  function within(a, b) {
    for (var n = a, k = 0; n && k < 64; k++) { if (n === b) return true; n = n.assignedSlot || n.parentNode || n.host; }
    return false;
  }
  // The element really under the point: through open shadow roots, not the retargeted host.
  function deepAt(x, y) {
    var h = root.elementFromPoint(x, y);
    for (var k = 0; k < 8 && h && h.shadowRoot; k++) { var n = h.shadowRoot.elementFromPoint(x, y); if (!n || n === h) break; h = n; }
    return h;
  }
  function owns(hit) {
    if (!hit) return false;
    if (tgt !== el) return within(hit, tgt);
    if (hit === el || el.contains(hit) || hit.contains(el)) return true;
    var lab = el.labels && el.labels[0];
    return !!(lab && (lab === hit || lab.contains(hit))) || sameControl(el, hit);
  }
  var px = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75], [0.15, 0.15], [0.85, 0.85]];
  var at = null, cover = null;
  for (var k = 0; k < px.length && !at; k++) {
    var x = r.left + r.width * px[k][0], y = r.top + r.height * px[k][1];
    if (x < 0 || y < 0 || x > view.innerWidth || y > view.innerHeight) continue;
    if (x + ox > innerWidth || y + oy > innerHeight) continue;
    if (outer) {
      var topHit = document.elementFromPoint(x + ox, y + oy);
      if (topHit !== outer && !(topHit && topHit.contains(outer))) { if (!cover && topHit) cover = topHit; continue; }
    }
    var hit = tgt !== el ? deepAt(x, y) : root.elementFromPoint(x, y);
    if (owns(hit)) at = { x: x, y: y }; else if (!cover && hit) cover = hit;
  }
  if (!at && r.width && r.height && cover) {
    // A cover inside a web component has no text of its own: name it by its host's. A host
    // whose popup lives in its shadow root has no light text either: read the shadow's.
    var hostText = function (h) {
      if (!h.shadowRoot || h.shadowRoot.mode !== 'open') return '';
      var out = [], w = document.createTreeWalker(h.shadowRoot, NodeFilter.SHOW_TEXT);
      for (var t = w.nextNode(); t && out.join(' ').length < 80; t = w.nextNode()) {
        var p = t.parentElement;
        if (!p || p.closest('style,script,template')) continue;
        var tx = t.data.replace(/\\s+/g, ' ').trim();
        if (tx) out.push(tx);
      }
      return out.join(' ');
    };
    var cw = cover, cname = '';
    for (var ck = 0; cw && ck < 6 && !(cname = (cw.innerText || (cw.getAttribute && cw.getAttribute('aria-label')) || hostText(cw) || '').trim()); ck++) cw = cw.parentElement || (cw.getRootNode && (cw.getRootNode() || {}).host);
    return { error: 'covered', by: ((cw || cover).tagName.toLowerCase() + ' "' + cname.slice(0, 40) + '"') };
  }
  if (!at) at = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  return {
    ok: true,
    x: Math.round(at.x + ox),
    y: Math.round(at.y + oy),
    w: Math.round(r.width),
    h: Math.round(r.height),
    tag: el.tagName.toLowerCase(),
    type: (el.getAttribute('type') || '').toLowerCase(),
    inViewport: r.top + oy >= 0 && r.bottom + oy <= window.innerHeight,
    ...(chain.length ? { frame: true } : {})
  };
})()`;
}

// The `read` text view: header with scroll position, page stats and loading or modal
// notes, then one line per element. `*` marks elements new since the previous read.
export function formatRead(snap) {
  const s = snap.stats || {};
  const sc = snap.scroll || {};
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const head = [
    snap.title,
    snap.url,
    `token: ${snap.token}   scroll ${sc.y}/${sc.h}` + (sc.above !== undefined ? ` · ${sc.above} screens above, ${sc.below} below` : ''),
  ];
  if (snap.stats) {
    const bits = [`${s.interactive} interactive`, plural(s.links, 'link')];
    if (s.iframes) bits.push(plural(s.iframes, 'iframe') + (s.crossOrigin?.length ? ` (cross-origin: ${[...new Set(s.crossOrigin)].join(', ')})` : ''));
    if (s.shadowRoots) bits.push(plural(s.shadowRoots, 'shadow root'));
    bits.push(`${s.total} elements`);
    if (s.folded) bits.push(`${s.folded} folded into their card`);
    head.push(`stats: ${bits.join(' · ')}`);
  }
  if (snap.waitNote) head.push(`wait: ${snap.waitNote}`);
  if (snap.loading) head.push(`loading: ${snap.loading}`);
  if (snap.modal) head.push(`modal open: ${snap.modal.role}${snap.modal.name ? ` "${snap.modal.name}"` : ''}; its controls come first, everything else is inert`);
  const lines = snap.elements.map(e => {
    const flags = [];
    if (e.testid) flags.push(`[${e.testid}]`);
    if (e.disabled) flags.push('(disabled)');
    if (e.expanded !== undefined) flags.push(e.expanded ? '(expanded)' : '(collapsed)');
    if (e.checked) flags.push('(checked)');
    if (e.pressed !== undefined) flags.push(e.pressed ? '(pressed)' : '(not pressed)');
    if (e.nameFrom === 'context') flags.push('(named from its row)');
    if (e.popup) flags.push('(open list)');
    if (e.covered) flags.push(`(covered by ${e.covered}${e.coverPinned ? ', a pinned bar: a click scrolls it clear' : ''})`);
    if (e.inert && !e.covered) flags.push('(inert)');
    if (e.offscreen) flags.push(`(${e.offscreen})`);
    if (e.frame) flags.push('(in frame)');
    const ref = `${e.new ? '*' : ' '}${e.ref}`;
    return `${ref.padEnd(9)} ${(e.id || '').padEnd(5)} ${e.role.padEnd(10)} ${(e.name || '').slice(0, 60).padEnd(60)}${flags.length ? ` ${flags.join(' ')}` : ''}`.trimEnd();
  });
  const o = snap.omitted;
  if (o?.total) {
    const where = [o.above ? `${o.above} above` : '', o.below ? `${o.below} below` : '', o.overLimit ? `${o.overLimit} over --max` : ''].filter(Boolean).join(', ');
    const how = [o.above || o.below ? '--all lists the whole page' : '', o.overLimit ? '--max raises the limit' : ''].filter(Boolean).join(', ');
    lines.push(`(${plural(o.total, 'more element')} not listed: ${where}; ${how})`);
  }
  return `${head.join('\n')}\n\n${lines.join('\n')}\n\n--- text${snap.textTruncated ? ` (truncated from ${snap.textLength})` : ''} ---\n${snap.text}`;
}

export const REF_ERRORS = {
  no_snapshot: 'No snapshot on this page. Run `cdp read <tab>` first, then use the refs it prints.',
  stale: 'The refs you are using are from an older snapshot of this page that it no longer keeps (it was re-read many times or reloaded). Re-run `browserctrl read <tab>` and use the new refs.',
  navigated: 'The page navigated since the snapshot was taken and that element is gone. Re-run `browserctrl read <tab>`.',
  unknown_ref: 'No such ref in the current snapshot. Re-run `cdp read <tab>` to see valid refs.',
  detached: 'That element has been removed from the page since the snapshot. Re-run `cdp read <tab>`.',
  frame_replaced: 'That element was in a frame that has loaded a new page since the snapshot. Re-run `browserctrl read <tab>` and use the new refs.',
  internal: 'That element belongs to Chrome CDP’s annotation UI, not the web page. Re-run `cdp read <tab>` and choose a page ref.',
  covered: 'Another element covers that one, so a click would land on it instead. Close the overlay or scroll, then re-run `cdp read <tab>`.',
};


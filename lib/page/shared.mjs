// Helpers that run in the page, written once. The page script loader (index.mjs) inlines
// the ones a script names, by their source text, so each must stand alone: it may use page
// globals and the other helpers here, nothing else. Node imports some of them as well (the
// date parser reads a step's date and every day cell's label alike).

// Counts fetch and XHR requests in flight, once per document, so settle can tell a page that
// is waiting on its server from one that is done, and notes a navigation away as it starts.
// Requests open longer than longPoll ms are long polls or streams, not a pending render.
export function bcNetWatch(longPoll) {
  if (window.__bcNet) return;
  const open = new Map(); let n = 0;
  const net = window.__bcNet = { last: Date.now(), busy: (since) => { const t = Date.now(); for (const s of open.values()) if (s >= since && t - s < longPoll) return true; return false; } };
  const start = () => { const id = ++n; open.set(id, Date.now()); net.last = Date.now(); return id; };
  const end = (id) => { open.delete(id); net.last = Date.now(); };
  const f = window.fetch;
  // keepalive and no-cors fetches are fire-and-forget (analytics, pixels): nothing renders from them.
  const detached = (init) => !!(init && (init.keepalive || init.mode === 'no-cors'));
  if (f) window.fetch = function (input, init) {
    if (detached(init) || (input && typeof input === 'object' && detached(input))) return f.apply(this, arguments);
    const id = start(); return f.apply(this, arguments).finally(() => end(id));
  };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () { const id = start(); this.addEventListener('loadend', () => end(id), { once: true }); return send.apply(this, arguments); };
  // A navigation away (a link, a form, location.assign) starts in this document before the
  // new one commits: note when, so settle waits for the new page instead of calling the old
  // one quiet. The Navigation API sees it as it starts; pagehide only as the page goes.
  // settle-end clears the mark.
  const leaving = window.__bcLeaving = { at: 0 };
  const leave = () => { leaving.at = Date.now(); };
  if (window.navigation && navigation.addEventListener) navigation.addEventListener('navigate', (e) => { if (!(e.destination && e.destination.sameDocument)) leave(); });
  addEventListener('pagehide', leave);
}

// The element for a CSS selector, searching open shadow roots too, for elements browserctrl
// pinned (data-bc-pin) or a caller named inside web components: document.querySelector stops
// at every shadow boundary.
export function findDeep(s) {
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
}

// Shown: at least 2 px both ways and not hidden by style.
export function isShown(el) { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none'; }

// A ref or pin whose element the page replaced with a fresh copy (results arriving redraw
// the filters; a client-side route change rebuilds the form): the same control is the one
// connected element with the same tag and the same identifying attributes and text, shown
// on screen. bcRefind(sig) is null when none or several match.
export function bcSig(el) {
  var a = function (n) { return (el.getAttribute && el.getAttribute(n)) || ''; };
  var text = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ? '' : (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return { tag: el.tagName, id: el.id || '', type: a('type'), role: a('role'), name: a('name'), label: a('aria-label'), ph: a('placeholder'), href: a('href'), text: text };
}
export function bcRefind(sig) {
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
}

// The element behind a ref (ref_N, or a stable eN id) in the snapshot with this token (the
// latest snapshot without one), or an error code string.
export function refLookup(want, token) {
  want = String(want || ''); token = token || null;
  var latest = window.__cdp, snaps = window.__cdpSnaps;
  var state = token ? (snaps && snaps.by[token]) || (latest && latest.token === token ? latest : null) : latest;
  if (!state) return latest ? 'stale' : 'no_snapshot';
  var idx = /^e\d+$/.test(want) ? (state.ids || {})[want] : parseInt(want.replace('ref_', ''), 10) - 1;
  if (idx === undefined && /^e\d+$/.test(want) && latest && latest !== state) { state = latest; idx = (latest.ids || {})[want]; }
  var el = idx === undefined || isNaN(idx) ? null : state.els[idx];
  if (!el) return 'unknown_ref';
  if (!el.isConnected) {
    // The page redrew it (same document, maybe a client-side route change): the one copy now
    // on screen with the same tag, attributes and text is the same control.
    var again = bcRefind(bcSig(el));
    if (again) { state.els[idx] = again; window.__bcRefound = want; return again; }
    return state.url !== location.href ? 'navigated' : 'detached';
  }
  // A frame that loaded a new page keeps the old document alive but windowless: its
  // elements still say they are connected, yet nothing typed into them reaches the page.
  if (!el.ownerDocument || !el.ownerDocument.defaultView) return 'frame_replaced';
  return el;
}

// A point on a control's own parts is not a cover: the checkbox input stretched over its
// label text, the label wrapping it, or the option row holding both. Shared by the
// snapshot's "covered" flag and by ref resolution before a click.
export function sameControl(el, hit) {
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

// The page's text as a person reads it, including what web components draw in open shadow
// roots: document.body.innerText stops at every shadow boundary, so a quiz or a popup built
// as a component is blank to it. Pages without shadow text keep innerText's own output.
export function deepText() {
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
      if (sr && sr.mode === 'open') { hosts.push(all[i]); stack.push(sr); shadowChars += (sr.textContent || '').replace(/\s+/g, '').length; }
    }
  }
  if (!hosts.length || shadowChars < 20) return plain;
  var BLOCK = /^(block|flex|grid|list-item|table|table-row|table-caption|flow-root|-webkit-box)$/;
  var out = [], styleOf = new Map();
  function style(el) { var s = styleOf.get(el); if (!s) { s = getComputedStyle(el); styleOf.set(el, s); } return s; }
  function walk(node) {
    if (node.nodeType === 3) {
      var t = node.data.replace(/[ \t\r\n\f]+/g, ' ');
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
      if (tag === 'BR') { out.push('\n'); return; }
      block = BLOCK.test(s.display);
      if (block) out.push('\n');
      if (node.shadowRoot && node.shadowRoot.mode === 'open') {
        for (var c = node.shadowRoot.firstChild; c; c = c.nextSibling) walk(c);
        if (block) out.push('\n');
        return;
      }
      if (tag === 'SLOT') {
        var assigned = node.assignedNodes({ flatten: true });
        if (assigned.length) { for (var a = 0; a < assigned.length; a++) walk(assigned[a]); if (block) out.push('\n'); return; }
      }
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { if (block) out.push('\n'); return; }
    }
    for (var k = node.firstChild; k; k = k.nextSibling) walk(k);
    if (block) out.push('\n');
  }
  walk(body);
  return out.join('').split('\n').map(function (l) { return l.replace(/ {2,}/g, ' ').trim(); })
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Inside a dialog or an overlay panel? (What is on screen is read overlays first: a panel
// that slides in is usually appended at the end of the DOM.)
export function inOverlay(el) {
  // Memo for one page script's run: the loader declares this function afresh in each.
  const fixed = inOverlay.cache || (inOverlay.cache = new Map());
  if (fixed.has(el)) return fixed.get(el);
  let v = false;
  // Up through shadow roots too: a web-component modal (ion-modal, ion-alert) keeps its
  // buttons in a shadow tree whose parentElement chain stops at the root.
  const up = (n) => n.parentElement || (n.getRootNode && n.getRootNode() !== document && (n.getRootNode() || {}).host) || null;
  for (let n = el; n && n !== document.body; n = up(n)) {
    if (n.nodeType !== 1) continue;
    const s = getComputedStyle(n);
    if (n.matches('dialog[open]') || n.getAttribute('role') === 'dialog' || n.getAttribute('role') === 'alertdialog' || n.getAttribute('aria-modal') === 'true') { v = true; break; }
    // Fixed headers and bars are chrome, not overlays; a fixed panel covers a real share of the screen.
    if (s.position === 'fixed' || s.position === 'sticky') { v = n.getBoundingClientRect().height > innerHeight * 0.3; break; }
  }
  fixed.set(el, v);
  return v;
}

// A pinned or found element described the way a snapshot row would, and where it sits in
// the current snapshot (ref null when it is not in it).
export function elementInfo(el) {
  const role = accRole(el);
  const name = accName(el).replace(/\s+/g, ' ').trim().slice(0, 80);
  const els = (window.__cdp && window.__cdp.els) || [];
  const at = els.indexOf(el);
  const input = el.matches('input[type=checkbox],input[type=radio]') ? el : (el.control || el.querySelector && el.querySelector('input[type=checkbox],input[type=radio]'));
  return { ref: at >= 0 ? 'ref_' + (at + 1) : null, role, name, href: el.getAttribute('href') || undefined, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
    checked: input ? input.checked : el.hasAttribute('aria-checked') ? el.getAttribute('aria-checked') === 'true'
      : el.hasAttribute('aria-pressed') ? el.getAttribute('aria-pressed') === 'true' : undefined,
    pressed: !input && !el.hasAttribute('aria-checked') && el.hasAttribute('aria-pressed') ? el.getAttribute('aria-pressed') === 'true' : undefined };
}

// ---------------------------------------------------------------- dates ----
import { MONTHS, monthNumber, isoDate, parseDateText } from '../date-text.mjs';
export { MONTHS, monthNumber, isoDate, parseDateText };

// For a day cell just clicked (selector) and its date (iso): where the date shows. The
// calendar around the cell, a test for text that shows the date in any format, the short
// lines outside the calendar that show it, and the cell's look (date-look, date-shown).
export function dateCheck(selector, iso) {
  const want = iso;
  const [y, m, d] = want.split('-').map(Number);
  const isoOf = (x) => x && x.y + '-' + String(x.m).padStart(2, '0') + '-' + String(x.d).padStart(2, '0');
  const shows = (t) => {
    t = String(t || '');
    if (!/\d/.test(t)) return false;
    for (const part of t.split(/\s[-–—]\s|\s+to\s+|\|/)) if (isoOf(parseDateText(part)) === want) return true;
    const low = t.toLowerCase();
    // The day with its month word beside it, no year: "Oct 17", "17 okt", "17 de octubre".
    const tok = low.replace(/[,.]/g, ' ').split(/\s+/).filter(x => x && x !== 'de');
    for (let i = 0; i < tok.length; i++) if (monthNumber(tok[i]) === m && (+tok[i + 1] === d || +tok[i - 1] === d)) return true;
    if (new RegExp('(?<!\\d)' + m + '\\s*[月월]\\s*' + d + '(?!\\d)').test(low)) return true;
    return new RegExp('(?<![\\d/])0?' + m + '/0?' + d + '(?![\\d])').test(low);
  };
  const cell = findDeep(selector);
  const dated = (n) => /\d/.test((n.getAttribute && (n.getAttribute('aria-label') || n.getAttribute('data-date') || '')) || '');
  let cal = null;
  for (let n = cell && cell.isConnected ? cell.parentElement : null; n && n !== document.body; n = n.parentElement) {
    const k = [...n.querySelectorAll('[aria-label],[data-date],button,td')].filter(dated).length;
    if (k >= 7 || n.matches('table,[role=grid]')) { cal = n; if (k >= 20) break; }
  }
  const outside = (el) => !(cal && cal.contains(el)) && !el.closest('table,[role=grid],[data-cdp]');
  const seen = (el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden'; };
  // Short lines of text outside the calendar that show the date: leaf-ish blocks only.
  const lines = () => [...document.querySelectorAll('p,span,div,li,dd,dt,label,strong,b,h1,h2,h3,h4,h5,h6,small')]
    .filter(el => outside(el) && el.children.length <= 3 && seen(el)).map(el => (el.innerText || '').replace(/\s+/g, ' ').trim())
    .filter(t => t && t.length <= 120 && shows(t)).length;
  const lookOf = (el) => { const s = getComputedStyle(el), c = el.closest('td,[role=gridcell]'), cs = c ? getComputedStyle(c) : null; return [s.backgroundColor, s.color, s.fontWeight, cs && cs.backgroundColor, cs && cs.color].join('|'); };
  return { want, cell, isoOf, shows, outside, lines, lookOf };
}

// What is on screen, overlays first: a panel that slides in is usually appended at the end
// of the DOM, so the head of document.body.innerText misses it. { url, title, overlay, view }
export function viewText() {
  const vw = innerWidth, vh = innerHeight, over = [], rest = [];
  // Text nodes in rendered order, into open shadow roots (a popup or quiz drawn by a web
  // component) and through slots; a TreeWalker stops at every shadow boundary.
  const texts = [];
  const walk = (node) => {
    if (texts.length > 20000) return;
    if (node.nodeType === 3) { texts.push(node); return; }
    if (node.nodeType === 1) {
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.tagName)) return;
      if (node.shadowRoot && node.shadowRoot.mode === 'open') { for (let c = node.shadowRoot.firstChild; c; c = c.nextSibling) walk(c); return; }
      if (node.tagName === 'SLOT') { const a = node.assignedNodes({ flatten: true }); if (a.length) { a.forEach(walk); return; } }
    }
    for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
  };
  walk(document.body || document.documentElement);
  let last = null;
  for (const t of texts) {
    const s = t.textContent.replace(/\s+/g, ' ').trim();
    const el = t.parentElement || (t.parentNode && t.parentNode.host) || null;
    if (!s || !el || el.closest('script,style,noscript,[data-cdp]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
    const into = inOverlay(el) ? over : rest;
    if (into === last && into.length) into[into.length - 1] += ' ' + s; else into.push(s);
    last = into;
  }
  return { url: location.href, title: document.title, lang: document.documentElement.lang || '', overlay: over.join('\n'), view: rest.join('\n') };
}

// True only for effectively empty CSS clipping, not ordinary small icons or controls.
export function screenReaderClip(el, s) {
  var r;
  var clippedX = /^(hidden|clip|scroll|auto)$/.test(s.overflowX);
  var clippedY = /^(hidden|clip|scroll|auto)$/.test(s.overflowY);
  if (clippedX || clippedY) {
    r = el.getBoundingClientRect();
    if (clippedX && clippedY && r.width > 0 && r.width <= 1 && r.height > 0 && r.height <= 1) return true;
  }
  if (s.clip && s.clip !== 'auto' && /^(absolute|fixed)$/.test(s.position)) {
    var rect = s.clip.match(/^rect\(([^)]+)\)$/);
    var edges = rect && rect[1].split(/[,\s]+/).map(parseFloat);
    if (edges && edges.length === 4 && (edges[1] - edges[3] <= 1 || edges[2] - edges[0] <= 1)) return true;
  }
  var inset = s.clipPath && s.clipPath.match(/^inset\(([^)]+)\)$/);
  if (inset) {
    var parts = inset[1].split(/\s+round\s+/)[0].trim().split(/\s+/);
    if (parts.length >= 1 && parts.length <= 4 && parts.every(function (v) { return /^-?[\d.]+(px|%)$/.test(v) || v === '0'; })) {
      r = r || el.getBoundingClientRect();
      var values = [parts[0], parts[1] || parts[0], parts[2] || parts[0], parts[3] || parts[1] || parts[0]];
      var nums = values.map(function (v, i) { return parseFloat(v) * (v.endsWith('%') ? (i % 2 ? r.width : r.height) / 100 : 1); });
      if (r.width - nums[1] - nums[3] <= 1 || r.height - nums[0] - nums[2] <= 1) return true;
    }
  }
  return false;
}

// What find, fields and the page diff share: every element under open shadow roots, why
// an element is hidden and what opens it, and a handle to act on it by (a ref from the last
// read, else a pinned selector). Names and roles are accName and accRole.
export function findKit() {
  function all(root) {
    var out = [], stack = [root || document], seen = 0;
    while (stack.length && seen < 40000) {
      var r = stack.pop(), els = r.querySelectorAll('*');
      for (var i = 0; i < els.length; i++, seen++) {
        out.push(els[i]);
        if (els[i].shadowRoot && els[i].shadowRoot.mode === 'open') stack.push(els[i].shadowRoot);
      }
    }
    return out;
  }
  function up(el) { return el.parentElement || (el.getRootNode && el.getRootNode().host) || null; }
  function ours(el) { for (var e = el; e; e = up(e)) if (e.hasAttribute && e.hasAttribute('data-cdp')) return true; return false; }
  function clip(s, n) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n); }
  // Why a person cannot see it, or '' when they can.
  function hiddenWhy(el) {
    if (!el.isConnected) return 'removed';
    for (var e = el; e && e.nodeType === 1; e = up(e)) {
      if (e.hidden) return e === el ? 'hidden' : 'in a hidden section';
      var s = getComputedStyle(e);
      if (s.display === 'none') return e === el ? 'hidden' : 'in a hidden section';
      if (s.visibility === 'hidden' || s.visibility === 'collapse') return 'hidden';
      if (screenReaderClip(e, s)) return 'screen-reader only';
      if (e.tagName === 'DETAILS' && !e.open && e !== el && !(el.closest && el.closest('summary'))) return 'in a closed section';
    }
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return 'zero size';
    return '';
  }
  // The control that opens the section hiding el: aria-controls pointing at a hidden ancestor,
  // a closed <details>'s summary, or a heading control just before the hidden block.
  function opener(el) {
    var CTL = 'button,a,summary,[role=button],[role=tab],[aria-expanded]';
    for (var e = up(el); e && e.nodeType === 1 && e !== document.body; e = up(e)) {
      if (e.tagName === 'DETAILS' && !e.open) return e.querySelector('summary');
      var s = getComputedStyle(e);
      var shut = e.hidden || s.display === 'none' || s.visibility === 'hidden' || (s.maxHeight === '0px' && s.overflow !== 'visible') || e.getAttribute('aria-hidden') === 'true';
      // Some headers hide a nested form, while the clickable summary is a sibling
      // of its wrapper. Walk up through that wrapper, but accept only one visible
      // disclosure in a local header/form region rather than a page-wide button.
      if (!shut) {
        if (hiddenWhy(el) && e.matches('header,form,[role=search],[role=group]')) {
          var candidates = Array.prototype.filter.call(e.querySelectorAll(CTL), function (c) {
            return c !== el && !c.contains(el) && !hiddenWhy(c) && (c.matches('summary,[role=button],[aria-expanded="false"]') || c.hasAttribute('aria-controls'));
          });
          if (candidates.length === 1) return candidates[0];
        }
        continue;
      }
      if (e.id) {
        var c = (e.getRootNode().querySelector ? e.getRootNode() : document).querySelector('[aria-controls~="' + CSS.escape(e.id) + '"]');
        if (c && !hiddenWhy(c)) return c;
      }
      for (var p = e.previousElementSibling, k = 0; p && k < 3; p = p.previousElementSibling, k++) {
        var h = p.matches(CTL) ? p : p.querySelector(CTL);
        if (h && !hiddenWhy(h)) return h;
      }
      var par = up(e);
      if (par) { var first = par.querySelector(CTL); if (first && first !== el && !first.contains(el) && !hiddenWhy(first)) return first; }
    }
    return null;
  }
  var els = (window.__cdp && window.__cdp.els) || [], pinN = 0, stamp = Date.now().toString(36);
  // Name every element by a pinned selector, not by a ref of the last read.
  function forgetRefs() { els = []; }
  function handle(el) {
    var at = els.indexOf(el);
    if (at >= 0) return 'ref_' + (at + 1);
    var k = el.getAttribute('data-bc-pin');
    if (!k) { k = 'f' + stamp + '-' + (++pinN); el.setAttribute('data-bc-pin', k); }
    return '[data-bc-pin="' + k + '"]';
  }
  return { all: all, up: up, ours: ours, clip: clip, hiddenWhy: hiddenWhy, opener: opener, handle: handle, forgetRefs: forgetRefs };
}

// ------------------------------------------------------- names and roles ----
// One accessible name and one role for every page script: the snapshot's rows, find,
// fields and the page diff, and a pinned element's description (elementInfo).
// The name: aria-label, aria-labelledby, a <label for> (in the element's own shadow tree
// first), a wrapping <label>, its own text, a shadow host's heading for an empty control
// inside it, an icon's label, then visible input text or placeholder, title, alt, name or value.
// Input names are visible labels, not machine-generated form submission keys.
export function inputFallbackName(el) {
  if (el.tagName !== 'INPUT') return null;
  var type = (el.getAttribute('type') || 'text').toLowerCase();
  if (/^(submit|button|reset|image)$/.test(type)) {
    return String((type === 'image' ? el.getAttribute('alt') : el.value) || 'Submit').trim().slice(0, 120);
  }
  var name = (el.getAttribute('name') || '').trim();
  var generated = !['password','file','hidden'].includes(type) && !/\s/.test(name) && ((/[a-z]/i.test(name) && /\d/.test(name)) || (/^[a-z0-9_-]{6,}$/.test(name) && /\d/.test(name)));
  var explicit = el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt');
  if (explicit) return String(explicit).trim().slice(0, 120);
  if (name && !generated) return name.slice(0, 120);
  // Bare picker controls borrow only a row with no other controls, never a whole list.
  if (generated || /^(checkbox|radio)$/.test(type)) {
    for (var row = el.parentElement, depth = 0; row && row !== el.ownerDocument.body && depth < 6; row = row.parentElement, depth++) {
      if (Array.from(row.querySelectorAll('input,select,textarea,button,[role=checkbox],[role=radio]')).some(function (other) { return other !== el; })) break;
      var text = (row.innerText || row.textContent || '').trim().replace(/\s+/g, ' ');
      if (text) return text.slice(0, 120);
    }
    return '';
  }
  return String(['password','file','hidden','checkbox','radio'].includes(type) ? '' : el.value || '').trim().slice(0, 120);
}

export function accName(el) {
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
    var parts = labelledby.split(/\s+/).map(function (id) {
      var n = byId(id);
      return n ? (n.innerText || n.textContent || '').trim() : '';
    }).filter(Boolean);
    if (parts.length) return parts.join(' ');
  }
  if (el.id) {
    var lab = tree.querySelector('label[for="' + CSS.escape(el.id) + '"]') || doc.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    if (lab) {
      var lt = (lab.innerText || lab.textContent || '').trim().replace(/\s+/g, ' ');
      if (lt) return lt;
    }
  }
  var enclosing = el.closest('label');
  if (enclosing && enclosing !== el) {
    var wrapped = (enclosing.innerText || enclosing.textContent || '').trim().replace(/\s+/g, ' ');
    if (wrapped) return wrapped;
  }
  var own = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
  if (own) return own.slice(0, 120);
  // A control inside a component's shadow root with no text of its own (an accordion's
  // <summary> whose slot is empty) is named by the component's heading or label.
  if (tree && tree.host && /^(SUMMARY|BUTTON)$/.test(el.tagName)) {
    var hh = tree.host.querySelector('[slot=summary],[slot=heading],[slot=label],h1,h2,h3,h4,h5,h6,label');
    var ht = hh ? (hh.innerText || hh.textContent || '').trim().replace(/\s+/g, ' ') : '';
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
  var inputName = inputFallbackName(el);
  if (inputName !== null) return inputName;
  return (el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') ||
          el.getAttribute('name') || (['password','file','hidden'].includes(el.type) ? '' : el.value) || '').toString().trim().slice(0, 120);
}

// The role: an explicit role, else from the tag and input type. A range input is a slider
// (set with set, not typed into); a plain element is its tag name.
export function accRole(el) {
  var explicit = el.getAttribute('role');
  if (explicit) return explicit;
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

// The part of an element inside its viewport and every ancestor's clipping box.
export function visibleRect(el) {
  var view = el.ownerDocument.defaultView, r = el.getBoundingClientRect();
  var out = { left: Math.max(0, r.left), top: Math.max(0, r.top), right: Math.min(view.innerWidth, r.right), bottom: Math.min(view.innerHeight, r.bottom) };
  for (var n = el.assignedSlot || el.parentElement || el.getRootNode().host; n; n = n.assignedSlot || n.parentElement || (n.getRootNode && n.getRootNode().host)) {
    var style = view.getComputedStyle(n), box = n.getBoundingClientRect();
    // The root's overflow, and the body's when the root's is visible, applies to the
    // viewport (already the starting bounds), not to the element's own box.
    var doc = n.ownerDocument.documentElement;
    if (n === doc || (n === n.ownerDocument.body && view.getComputedStyle(doc).overflowX === 'visible' && view.getComputedStyle(doc).overflowY === 'visible')) continue;
    if (/^(auto|scroll|hidden|clip|overlay)$/.test(style.overflowX)) { out.left = Math.max(out.left, box.left + n.clientLeft); out.right = Math.min(out.right, box.left + n.clientLeft + n.clientWidth); }
    if (/^(auto|scroll|hidden|clip|overlay)$/.test(style.overflowY)) { out.top = Math.max(out.top, box.top + n.clientTop); out.bottom = Math.min(out.bottom, box.top + n.clientTop + n.clientHeight); }
  }
  out.width = Math.max(0, out.right - out.left); out.height = Math.max(0, out.bottom - out.top);
  return out;
}

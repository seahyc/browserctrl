// Resolve a ref (with its snapshot token) or a CSS selector to what an action needs: the
// point to click in CSS pixels, or { error }. A selector click gets the same checks as a ref
// click: scroll only when out of view, and refuse a point that something else covers (a
// panel's footer over the last list row).
({ ref, token, selector }) => {
  var el = selector ? (findDeep(selector) || 'no_match') : refLookup(ref, token);
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
  var vr = el.getBoundingClientRect(), visible = visibleRect(el);
  if (visible.width < vr.width || visible.height < vr.height) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  else if (inFrame || !vr.width || !vr.height || vr.top < 0 || vr.left < 0 || vr.bottom > innerHeight || vr.right > innerWidth) {
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
  var r = visibleRect(tgt);
  if (!r.width || !r.height) {
    // Clipping can leave no hit-test point at all (e.g. a link behind an
    // overflow container). That path previously discarded the covering name.
    var clipper = tgt.parentElement;
    while (clipper && (/^(inline|contents)$/.test(getComputedStyle(clipper).display) || !/(hidden|clip|scroll|auto)/.test(getComputedStyle(clipper).overflow + getComputedStyle(clipper).overflowX + getComputedStyle(clipper).overflowY))) clipper = clipper.parentElement;
    var blocker = clipper || tgt.ownerDocument.documentElement;
    var label = (accName(blocker) || blocker.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return { error: 'covered', by: (accRole(blocker) || blocker.tagName.toLowerCase()) + (label ? ' "' + label + '"' : '') + ' (clipping container)' };
  }
  // Click where the element is actually on top: a sticky bar, an overlay or a late layout
  // shift can put something else under its centre. Try the centre, then inner points.
  var root = el.getRootNode && el.getRootNode().elementFromPoint ? el.getRootNode() : el.ownerDocument;
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
    if (hit === el || el.contains(hit)) return true;
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
      if (topHit !== outer) { if (!cover && topHit) cover = topHit; continue; }
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
        var tx = t.data.replace(/\s+/g, ' ').trim();
        if (tx) out.push(tx);
      }
      return out.join(' ');
    };
    function describe(node) {
      var role = accRole(node) || node.tagName.toLowerCase();
      var name = (accName(node) || node.innerText || hostText(node) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      return role + (name ? ' "' + name + '"' : '');
    }
    var popup = cover.closest('[role=dialog],dialog,[aria-modal=true],[role=listbox],[role=menu],[role=tree],[popover],.dropdown,.dropdown-menu,.picker,[class*="picker"],[class*="dropdown"]');
    var chrome = cover;
    while (chrome && !['fixed','sticky'].includes(getComputedStyle(chrome).position)) chrome = chrome.parentElement;
    var container = popup || chrome || cover;
    var consent = /cookie|consent/i.test(accName(container) || '') && !/settings|preferences|customi[sz]/i.test(accName(container) || '');
    var kind = consent ? 'consent banner' : popup ? (popup.matches('dialog,[role=dialog],[aria-modal=true]') ? 'dialog' : 'popup') : chrome ? 'sticky header or fixed page chrome' : 'cover';
    return { error: 'covered', by: describe(cover) + (container !== cover ? ' inside ' + describe(container) : '') + ' (' + kind + ')', coverKind: kind };
  }
  if (!at) return { error: 'covered', by: 'the document viewport (no visible hit-test point)' };
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
}

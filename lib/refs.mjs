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
const SNAPSHOT_FN = `
(function (opts) {
  var maxText = opts.maxText || 20000;
  var interactiveSel = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]',
    '[role=menuitem]', '[role=option]', '[role=switch]', '[role=combobox]', '[role=textbox]',
    '[contenteditable=""]', '[contenteditable=true]', '[onclick]', '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  function visible(el) {
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity || '1') < 0.05) return false;
    return true;
  }

  // The extension's annotation controls live in the inspected page's DOM. They
  // are useful to the human, but must never become targets for page automation.
  // Do not use [data-cdp-overlay] here: that marker intentionally sits on
  // <html>, so it would incorrectly hide the entire page.
  function internal(el) {
    for (var node = el; node; node = node.parentElement || (node.getRootNode && node.getRootNode().host)) {
      if (node.nodeType === 1 && (node.hasAttribute('data-cdp') || node.getAttribute('data-cdp-internal') === 'true')) return true;
    }
    return false;
  }

  function nameOf(el) {
    var t = (el.getAttribute('aria-label') || '').trim();
    if (t) return t;
    var labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      var parts = labelledby.split(/\\s+/).map(function (id) {
        var n = document.getElementById(id);
        return n ? (n.innerText || n.textContent || '').trim() : '';
      }).filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    if (el.id) {
      var lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab) {
        var lt = (lab.innerText || lab.textContent || '').trim();
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
    return (el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') ||
            el.getAttribute('name') || (['password','file','hidden'].includes(el.type) ? '' : el.value) || '').toString().trim().slice(0, 120);
  }

  function roleOf(el) {
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

  var seen = [];
  var nodes = [];
  // querySelectorAll stops at shadow boundaries. Modern chat composers and
  // design-system controls commonly use open shadow roots, so collect those
  // deliberately while keeping the resulting elements usable as normal refs.
  function collect(root) {
    Array.prototype.forEach.call(root.querySelectorAll(interactiveSel), function (el) { nodes.push(el); });
    Array.prototype.forEach.call(root.querySelectorAll('*'), function (el) {
      if (el.shadowRoot && el.shadowRoot.mode === 'open') collect(el.shadowRoot);
    });
  }
  collect(document);
  // Custom radios and checkboxes hide the real input and show a styled label.
  // Offer the visible label in its place, with the input's role and state.
  var proxyOf = new Map();
  nodes.slice().forEach(function (el) {
    if (el.tagName !== 'INPUT' || (el.type !== 'radio' && el.type !== 'checkbox') || visible(el)) return;
    var label = (el.labels && el.labels[0]) || el.closest('label');
    if (!label || !visible(label) || nodes.indexOf(label) !== -1) return;
    proxyOf.set(label, el);
    nodes.push(label);
  });
  var rows = [];
  for (var i = 0; i < nodes.length && rows.length < (opts.max || 400); i++) {
    var el = nodes[i];
    if (internal(el)) continue;
    if (!opts.includeHidden && !visible(el)) continue;
    // Skip a wrapper whose only content is another candidate we already took.
    if (seen.indexOf(el) !== -1) continue;
    seen.push(el);
    var r = el.getBoundingClientRect();
    var input = proxyOf.get(el);
    var row = {
      ref: 'ref_' + (rows.length + 1),
      role: input ? input.type : roleOf(el),
      name: nameOf(el),
      tag: el.tagName.toLowerCase(),
      box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
    };
    var tid = testid(el);
    if (tid) row.testid = tid;
    if (el.disabled) row.disabled = true;
    if (el.checked || (input && input.checked)) row.checked = true;
    if (input && input.disabled) row.disabled = true;
    if (el.value !== undefined && el.value !== '' && el.type !== 'password') row.value = String(el.value).slice(0, 80);
    if (el.getAttribute('aria-expanded')) row.expanded = el.getAttribute('aria-expanded') === 'true';
    if (el.tagName.toLowerCase() === 'a' && el.href) row.href = el.href.slice(0, 200);
    if (!visible(el)) row.hidden = true;
    rows.push(row);
  }

  var token = String(Date.now()) + ':' + Math.random().toString(36).slice(2, 8);
  window.__cdp = { token: token, els: seen.slice(0, rows.length), url: location.href };

  var text = '';
  try { text = (document.body ? document.body.innerText : '') || ''; } catch (e) { text = ''; }
  text = text.replace(/\\n{3,}/g, '\\n\\n').trim();
  var truncated = text.length > maxText;

  return {
    token: token,
    url: location.href,
    title: document.title,
    scroll: { y: Math.round(window.scrollY), h: Math.round(document.body ? document.body.scrollHeight : 0), vh: window.innerHeight },
    elements: rows,
    text: truncated ? text.slice(0, maxText) : text,
    textTruncated: truncated,
    textLength: text.length
  };
})
`;

export function snapshotExpression(opts = {}) {
  return `(${SNAPSHOT_FN})(${JSON.stringify(opts)})`;
}

// Resolve a ref back to its element and return what an action needs: the
// center point in CSS pixels, plus whether it is still on the same page.
export function resolveRefExpression(ref, token) {
  return `
(function () {
  var state = window.__cdp;
  if (!state) return { error: 'no_snapshot' };
  ${token ? `if (state.token !== ${JSON.stringify(token)}) return { error: 'stale', token: state.token };` : ''}
  if (state.url !== location.href) return { error: 'navigated', url: location.href };
  var idx = parseInt(String(${JSON.stringify(ref)}).replace('ref_', ''), 10) - 1;
  var el = state.els[idx];
  if (!el) return { error: 'unknown_ref' };
  if (!el.isConnected) return { error: 'detached' };
  for (var node = el; node; node = node.parentElement || (node.getRootNode && node.getRootNode().host)) {
    if (node.nodeType === 1 && (node.hasAttribute('data-cdp') || node.getAttribute('data-cdp-internal') === 'true')) return { error: 'internal' };
  }
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  var r = el.getBoundingClientRect();
  // Click where the element is actually on top: a sticky bar, an overlay or a late layout
  // shift can put something else under its centre. Try the centre, then inner points.
  var root = el.getRootNode && el.getRootNode().elementFromPoint ? el.getRootNode() : document;
  function owns(hit) {
    if (!hit) return false;
    if (hit === el || el.contains(hit) || hit.contains(el)) return true;
    var lab = el.labels && el.labels[0];
    return !!(lab && (lab === hit || lab.contains(hit)));
  }
  var px = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75], [0.15, 0.15], [0.85, 0.85]];
  var at = null, cover = null;
  for (var k = 0; k < px.length && !at; k++) {
    var x = r.left + r.width * px[k][0], y = r.top + r.height * px[k][1];
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
    var hit = root.elementFromPoint(x, y);
    if (owns(hit)) at = { x: x, y: y }; else if (!cover && hit) cover = hit;
  }
  if (!at && r.width && r.height && cover) {
    return { error: 'covered', by: (cover.tagName.toLowerCase() + ' "' + (cover.innerText || cover.getAttribute('aria-label') || '').trim().slice(0, 40) + '"') };
  }
  if (!at) at = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  return {
    ok: true,
    x: Math.round(at.x),
    y: Math.round(at.y),
    w: Math.round(r.width),
    h: Math.round(r.height),
    tag: el.tagName.toLowerCase(),
    type: (el.getAttribute('type') || '').toLowerCase(),
    inViewport: r.top >= 0 && r.bottom <= window.innerHeight
  };
})()`;
}

export const REF_ERRORS = {
  no_snapshot: 'No snapshot on this page. Run `cdp read <tab>` first, then use the refs it prints.',
  stale: 'The refs you are using are from an older snapshot of this page. Re-run `cdp read <tab>`.',
  navigated: 'The page navigated since the snapshot was taken. Re-run `cdp read <tab>`.',
  unknown_ref: 'No such ref in the current snapshot. Re-run `cdp read <tab>` to see valid refs.',
  detached: 'That element has been removed from the page since the snapshot. Re-run `cdp read <tab>`.',
  internal: 'That element belongs to Chrome CDP’s annotation UI, not the web page. Re-run `cdp read <tab>` and choose a page ref.',
  covered: 'Another element covers that one, so a click would land on it instead. Close the overlay or scroll, then re-run `cdp read <tab>`.',
};

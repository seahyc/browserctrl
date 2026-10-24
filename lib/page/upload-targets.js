// The page's upload controls, for `upload <tab> "<name>" <file>`: every file input (in open
// shadow roots too), named by its label, aria-label or title; the visible labels and buttons
// that open one (label[for], a wrapping label, aria-controls, or a button beside a hidden
// input in the same small container); and visible buttons that say upload, attach, browse or
// choose file, which may open a picker the page makes on click. With `mark`, the control at
// that index is tagged so a selector can find it: its file input when it has one, else itself.
({ mark }) => {
  var clean = function (s) { return String(s || '').replace(/\s+/g, ' ').trim(); };
  var visible = function (el) {
    var r = el.getBoundingClientRect();
    var st = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
  };
  var all = function (sel) {
    var out = [];
    var walk = function (root) {
      Array.prototype.forEach.call(root.querySelectorAll(sel), function (el) { out.push(el); });
      Array.prototype.forEach.call(root.querySelectorAll('*'), function (el) { if (el.shadowRoot) walk(el.shadowRoot); });
    };
    walk(document);
    return out;
  };
  // The legend of its fieldset, else the last heading before it, so two "Upload" buttons can be
  // told apart.
  var headings = all('h1,h2,h3,h4,h5,h6,[role=heading]');
  var within = function (el) {
    var fs = el.closest('fieldset');
    var lg = fs && fs.querySelector('legend');
    if (lg) return clean(lg.innerText || lg.textContent).slice(0, 80);
    var before = headings.filter(function (h) { return h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING; });
    return before.length ? clean(before[before.length - 1].innerText || before[before.length - 1].textContent).slice(0, 80) : '';
  };
  var controls = [];
  var add = function (el, kind, name, input) {
    name = clean(name).slice(0, 120);
    if (!name || controls.some(function (c) { return c.el === el && c.name === name; })) return;
    controls.push({ el: el, kind: kind, name: name, input: input });
  };
  var buttons = 'button,[role=button],a,label,input[type=button],input[type=submit]';
  all('input[type=file]').forEach(function (input) {
    if (input.disabled) return;
    var shown = visible(input);
    var own = accName(input);
    if (own) add(input, 'file input', own, input);
    if (input.title) add(input, 'file input', input.title, input);
    Array.prototype.forEach.call(input.labels || [], function (l) { if (visible(l) || shown) add(l, 'label', l.innerText || l.textContent, input); });
    if (input.id) all('[aria-controls="' + CSS.escape(input.id) + '"]').forEach(function (b) { if (visible(b)) add(b, 'button', accName(b) || b.innerText, input); });
    // A hidden input styled away behind its own button: the visible buttons in its container.
    if (!shown) {
      for (var box = input.parentElement, depth = 0; box && depth < 3; box = box.parentElement, depth++) {
        var near = Array.prototype.filter.call(box.querySelectorAll(buttons), function (b) { return b !== input && visible(b); });
        if (near.length && near.length <= 3) { near.forEach(function (b) { add(b, b.tagName === 'LABEL' ? 'label' : 'button', accName(b) || b.innerText || b.value, input); }); break; }
      }
    }
  });
  all(buttons).forEach(function (b) {
    if (!visible(b) || b.disabled || controls.some(function (c) { return c.el === b; })) return;
    var name = clean(accName(b) || b.innerText || b.value);
    if (/\b(upload|attach|browse|choose (a )?files?|select (a )?files?|add (a )?files?)\b/i.test(name)) add(b, 'button', name, null);
  });
  var list = controls.map(function (c, i) {
    return { i: i, kind: c.kind, name: c.name, opens: c.input ? 'file input' : 'file picker', multiple: Boolean(c.input && c.input.multiple), within: within(c.el) };
  });
  if (mark === undefined || mark === null) return { controls: list };
  var c = controls[mark];
  if (!c) return { error: 'gone' };
  var el = c.input || c.el;
  var token = 'u' + Math.random().toString(36).slice(2, 10);
  el.setAttribute('data-browserctrl-upload', token);
  return { selector: '[data-browserctrl-upload="' + token + '"]', control: list[mark] };
}

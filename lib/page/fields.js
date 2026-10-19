// fields: what every field on the form holds now (unticked boxes only with all).
({ all: everything = false }) => {
  var kit = findKit(), all = kit.all, ours = kit.ours, clip = kit.clip, hiddenWhy = kit.hiddenWhy, opener = kit.opener, handle = kit.handle;
  var SEL = 'input,select,textarea,[role=combobox],[role=slider],[role=switch],[role=checkbox],[role=radio],[role=spinbutton],[role=textbox],[contenteditable=true]';
  var rows = [], groups = {}, unticked = 0;
  all(document).forEach(function (el) {
    if (!el.matches(SEL) || ours(el)) return;
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (el.tagName === 'INPUT' && /^(hidden|submit|button|reset|image)$/.test(type)) return;
    var why = hiddenWhy(el);
    var role = accRole(el), label = clip(accName(el), 80);
    // A custom checkbox draws a hidden input under a visible box: judge it by its label.
    if (why && !/^(checkbox|radio)$/.test(role)) { if (!everything) return; }
    var row = { handle: handle(el), role: role, label: label };
    if (role === 'checkbox' || role === 'switch' || role === 'radio') {
      var on = el.tagName === 'INPUT' ? el.checked : el.getAttribute('aria-checked') === 'true';
      if (role === 'radio') {
        var g = el.getAttribute('name') || (el.closest('[role=radiogroup]') || {}).id || label;
        groups[g] = groups[g] || { handle: on ? row.handle : null, role: 'radio group', label: (el.closest('fieldset') && clip((el.closest('fieldset').querySelector('legend') || {}).innerText, 60)) || g, value: null, options: 0 };
        groups[g].options++;
        if (on) { groups[g].value = label; groups[g].handle = row.handle; }
        return;
      }
      if (!on && !everything) { unticked++; return; }
      row.value = on ? 'checked' : 'unchecked';
    } else if (el.tagName === 'SELECT') {
      var o = el.selectedOptions && el.selectedOptions[0];
      row.value = o ? clip(o.text, 80) : '';
      row.options = el.options.length;
    } else if (role === 'slider' || role === 'spinbutton') {
      row.value = el.getAttribute('aria-valuetext') || el.getAttribute('aria-valuenow') || el.value;
      var lo = el.getAttribute('aria-valuemin') || el.min, hi = el.getAttribute('aria-valuemax') || el.max;
      if (lo || hi) row.range = lo + '–' + hi;
    } else if (el.isContentEditable) row.value = clip(el.innerText, 120);
    else row.value = clip(el.value != null ? el.value : el.getAttribute('aria-valuetext') || el.innerText, 120);
    if (el.required || el.getAttribute('aria-required') === 'true') row.required = true;
    if (el.getAttribute('aria-invalid') === 'true' || (el.validity && !el.validity.valid && el.value)) row.invalid = true;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') row.disabled = true;
    if (why) row.hidden = why;
    rows.push(row);
  });
  Object.keys(groups).forEach(function (k) { rows.push(groups[k]); });
  return { rows: rows.slice(0, 300), more: Math.max(0, rows.length - 300), unticked: unticked };
}

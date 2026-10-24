// Is every control with exactly this name disabled (a greyed-out Next on the last page)?
// Disabled means the disabled property, or aria-disabled on it or an ancestor. False when no
// control has the name, or one of them can be clicked.
({ names }) => {
  var norm = function (s) { return String(s || '').replace(/[-]/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim(); };
  var want = names.map(norm);
  var sel = 'button,a[href],input[type=button],input[type=submit],[role=button],[role=link],[role=menuitem],[role=tab],li[title]';
  var hits = Array.prototype.filter.call(document.querySelectorAll(sel), function (el) {
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    return want.indexOf(norm(accName(el) || el.getAttribute('title') || el.innerText)) >= 0;
  });
  if (!hits.length) return false;
  return hits.every(function (el) {
    return el.disabled || el.closest('[aria-disabled=true]') || (typeof el.className === 'string' && /(^|[\s_-])disabled($|[\s_-])/i.test(el.className));
  });
}

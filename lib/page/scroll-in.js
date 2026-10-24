// Scroll a pane inside the page (scroll --in): the element named by a CSS selector, a label
// (aria-label, title), a landmark word or a heading inside it, then the scroller itself, in
// it, or around it. amount: a number of pixels (negative is up), "down" / "up" (most of a
// pane), "end" / "top". A pane that scrolls with its own script (overflow hidden, as editors
// such as Monaco do) gets a wheel at its centre from the caller instead.
({ name, amount }) => {
  var norm = function (s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); };
  var want = norm(name);
  var shown = function (el) { var r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
  var native = function (el) { var s = getComputedStyle(el); return /auto|scroll|overlay/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1; };
  var custom = function (el) { return el.scrollHeight > el.clientHeight + 1 && /hidden|clip/.test(getComputedStyle(el).overflowY) && el.clientHeight > 40; };
  var scroller = function (el) {
    if (native(el)) return el;
    var best = null;
    Array.prototype.forEach.call(el.querySelectorAll('*'), function (d) { if ((native(d) || custom(d)) && shown(d) && (!best || d.clientHeight * d.clientWidth > best.clientHeight * best.clientWidth)) best = d; });
    if (best) return best;
    for (var a = el.parentElement; a && a !== document.body; a = a.parentElement) if (native(a)) return a;
    return custom(el) ? el : null;
  };
  var cands = [];
  try { if (/[#.\[>:]/.test(name)) cands = Array.prototype.slice.call(document.querySelectorAll(name)); } catch (e) {}
  if (!cands.length) {
    var ROLE = { main: 'main,[role=main]', navigation: 'nav,[role=navigation]', nav: 'nav,[role=navigation]', aside: 'aside,[role=complementary]', dialog: 'dialog,[role=dialog]', editor: '.monaco-editor,.cm-editor,.CodeMirror,[role=textbox][aria-multiline=true]' };
    if (ROLE[want]) cands = Array.prototype.slice.call(document.querySelectorAll(ROLE[want]));
  }
  if (!cands.length) {
    var all = document.querySelectorAll('[aria-label],[title],[aria-labelledby],h1,h2,h3,h4,h5,h6,[role=heading],legend,label');
    var exact = [], part = [];
    Array.prototype.forEach.call(all, function (el) {
      var by = el.getAttribute('aria-labelledby');
      var label = norm(el.getAttribute('aria-label') || el.getAttribute('title') || (by && document.getElementById(by) ? document.getElementById(by).textContent : '') || (/^(H\d|LEGEND|LABEL)$/.test(el.tagName) || el.getAttribute('role') === 'heading' ? el.innerText : ''));
      if (!label) return;
      // A heading or legend names the section around it.
      var target = /^(H\d|LEGEND|LABEL)$/.test(el.tagName) || el.getAttribute('role') === 'heading' ? (el.closest('section,article,fieldset,[role=region],[role=dialog],dialog') || el.parentElement) : el;
      if (label === want) exact.push(target); else if (label.indexOf(want) >= 0) part.push(target);
    });
    cands = exact.concat(part);
  }
  for (var i = 0; i < cands.length; i++) {
    var el = scroller(cands[i]);
    if (!el || !shown(el)) continue;
    var before = el.scrollTop, page = Math.round(el.clientHeight * 0.8);
    var dy = amount === 'down' ? page : amount === 'up' ? -page : amount === 'end' ? el.scrollHeight : amount === 'top' ? -el.scrollHeight : Number(amount) || page;
    var r = el.getBoundingClientRect();
    var label = (el.getAttribute('aria-label') || el.id || el.className && String(el.className).split(/\s+/)[0] || el.tagName.toLowerCase()).slice(0, 60);
    if (native(el)) {
      el.scrollBy({ top: dy, behavior: 'instant' });
      return { pane: label, scrollTop: Math.round(el.scrollTop), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, moved: Math.round(el.scrollTop - before),
        atEnd: el.scrollTop + el.clientHeight >= el.scrollHeight - 2, atTop: el.scrollTop <= 0 };
    }
    return { pane: label, wheel: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 200)), deltaY: dy }, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  }
  var panes = Array.prototype.filter.call(document.querySelectorAll('*'), function (d) { return native(d) && shown(d); }).slice(0, 10)
    .map(function (d) { return d.getAttribute('aria-label') || d.id || (d.className && String(d.className).split(/\s+/)[0]) || d.tagName.toLowerCase(); });
  return { pane: null, panes: panes, matched: cands.length };
}

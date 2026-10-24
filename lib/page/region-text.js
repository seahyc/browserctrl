// The text of one part of the page (text --region): a landmark by its role or label (main,
// navigation, a dialog, aside "Filters"), or a heading and what follows it up to the next
// heading of the same or a higher level. Unknown: the landmarks and headings that are there.
({ region }) => {
  var want = String(region || '').toLowerCase().replace(/\s+/g, ' ').trim();
  var norm = function (s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); };
  var shown = function (el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  var ROLE = { main: 'main', nav: 'navigation', navigation: 'navigation', header: 'banner', banner: 'banner', footer: 'contentinfo', contentinfo: 'contentinfo', aside: 'complementary', complementary: 'complementary', search: 'search', form: 'form', dialog: 'dialog', region: 'region' };
  var TAG = { main: 'main', navigation: 'nav', banner: 'header', contentinfo: 'footer', complementary: 'aside', form: 'form', dialog: 'dialog', region: 'section' };
  var landmarks = Array.prototype.slice.call(document.querySelectorAll('main,nav,header,footer,aside,form,dialog,section[aria-label],section[aria-labelledby],[role=main],[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[role=search],[role=form],[role=dialog],[role=alertdialog],[role=region],[aria-label]')).filter(shown);
  var roleOf = function (el) { var r = el.getAttribute('role'); if (r) return r === 'alertdialog' ? 'dialog' : r; for (var k in TAG) if (el.tagName.toLowerCase() === TAG[k]) return k; return ''; };
  var labelOf = function (el) {
    var by = el.getAttribute('aria-labelledby');
    if (by) return by.split(/\s+/).map(function (id) { var n = document.getElementById(id); return n ? n.textContent : ''; }).join(' ');
    return el.getAttribute('aria-label') || '';
  };
  var describe = function (el) { var l = norm(labelOf(el)); return (roleOf(el) || el.tagName.toLowerCase()) + (l ? ' "' + l.slice(0, 50) + '"' : ''); };
  // A role word first ("main", "dialog"), then a label that contains the words.
  var role = ROLE[want];
  var hit = role ? landmarks.filter(function (el) { return roleOf(el) === role; })[0] : null;
  if (!hit) hit = landmarks.filter(function (el) { return norm(labelOf(el)) === want; })[0] || landmarks.filter(function (el) { return norm(labelOf(el)).indexOf(want) >= 0; })[0];
  if (hit) return { found: describe(hit), text: hit.innerText };
  var heads = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]')).filter(shown);
  var level = function (h) { return Number(h.getAttribute('aria-level')) || Number(h.tagName.slice(1)) || 2; };
  var head = heads.filter(function (h) { return norm(h.innerText) === want; })[0] || heads.filter(function (h) { return norm(h.innerText).indexOf(want) >= 0; })[0];
  if (head) {
    var L = level(head), parts = [head.innerText], n = head;
    var stops = function (el) { return el.matches('h1,h2,h3,h4,h5,h6,[role=heading]') ? level(el) <= L : Array.prototype.some.call(el.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]'), function (h) { return level(h) <= L && shown(h); }); };
    for (var guard = 0; guard < 2000; guard++) {
      while (n && !n.nextElementSibling && n !== document.body) n = n.parentElement;
      if (!n || n === document.body) break;
      n = n.nextElementSibling;
      if (stops(n)) break;
      if (shown(n) && n.innerText) parts.push(n.innerText);
    }
    return { found: 'heading "' + norm(head.innerText).slice(0, 60) + '"', text: parts.join('\n') };
  }
  return { found: null, landmarks: landmarks.slice(0, 20).map(describe), headings: heads.slice(0, 30).map(function (h) { return norm(h.innerText).slice(0, 60); }) };
}

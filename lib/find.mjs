// find and fields: the two questions agents answered with hand-written eval in the Online-
// Mind2Web runs (25 of 95). "Where is the control that says X, even if a collapsed section
// hides it, and where does it link?" and "what does every field on this form hold now?"
// Both walk open shadow roots, and name each hit by a ref from the last read when it has
// one, else by a pinned selector that click, fill and do steps accept.

const WALK = `
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
  function clip(s, n) { return String(s || '').replace(/\\s+/g, ' ').trim().slice(0, n); }
  function byId(el, id) { var r = el.getRootNode && el.getRootNode(); return (r && r.getElementById ? r.getElementById(id) : null) || document.getElementById(id); }
  function labelOf(el) {
    var t = el.getAttribute('aria-label');
    if (t) return t;
    var lb = el.getAttribute('aria-labelledby');
    if (lb) { t = lb.split(/\\s+/).map(function (id) { var x = byId(el, id); return x ? x.innerText || x.textContent : ''; }).join(' '); if (clip(t, 5)) return t; }
    if (el.labels && el.labels.length) { t = Array.prototype.map.call(el.labels, function (l) { return l.innerText || l.textContent; }).join(' '); if (clip(t, 5)) return t; }
    var wrap = el.closest && el.closest('label');
    if (wrap && clip(wrap.innerText, 5)) return wrap.innerText;
    return el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '';
  }
  function roleOf(el) {
    var r = el.getAttribute('role');
    if (r) return r;
    var tag = el.tagName.toLowerCase(), type = (el.getAttribute('type') || 'text').toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return el.multiple ? 'listbox' : 'select';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'option') return 'option';
    if (tag === 'input') return /^(checkbox|radio)$/.test(type) ? type : /^(button|submit|reset|image)$/.test(type) ? 'button' : type === 'range' ? 'slider' : type === 'search' ? 'searchbox' : type === 'number' ? 'spinbutton' : 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return tag;
  }
  // Why a person cannot see it, or '' when they can.
  function hiddenWhy(el) {
    if (!el.isConnected) return 'removed';
    for (var e = el; e && e.nodeType === 1; e = up(e)) {
      if (e.hidden) return e === el ? 'hidden' : 'in a hidden section';
      var s = getComputedStyle(e);
      if (s.display === 'none') return e === el ? 'hidden' : 'in a hidden section';
      if (s.visibility === 'hidden' || s.visibility === 'collapse') return 'hidden';
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
      if (!shut) continue;
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
  function handle(el) {
    var at = els.indexOf(el);
    if (at >= 0) return 'ref_' + (at + 1);
    var k = el.getAttribute('data-bc-pin');
    if (!k) { k = 'f' + stamp + '-' + (++pinN); el.setAttribute('data-bc-pin', k); }
    return '[data-bc-pin="' + k + '"]';
  }
`;

export const FIND = (pattern, { limit = 25, pin = false } = {}) => `(() => {
  ${WALK}
  if (${pin}) els = [];
  var re = new RegExp(${JSON.stringify(pattern)}, 'i');
  var ACT = 'a[href],button,input,select,textarea,summary,option,label,[onclick],[tabindex]:not([tabindex="-1"]),[role=button],[role=link],[role=tab],[role=option],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=treeitem],[role=gridcell]';
  var hits = [], texts = [];
  all(document).forEach(function (el) {
    if (ours(el) || el.closest && el.closest('script,style,noscript,template')) return;
    var own = el.matches(ACT);
    var name = own ? clip(labelOf(el) || el.innerText || el.textContent || el.value, 120) : '';
    if (own && name && re.test(name)) {
      // The innermost control: a label's input, not every wrapper that also matches.
      if (hits.some(function (h) { return el.contains(h.el); })) return;
      hits = hits.filter(function (h) { return !h.el.contains(el); });
      hits.push({ el: el, name: name });
    } else if (!own && el.children.length === 0 && re.test(clip(el.textContent, 200))) texts.push(el);
  });
  var rows = hits.slice(0, ${limit}).map(function (h) {
    var el = h.el, why = hiddenWhy(el), o = why ? opener(el) : null;
    var href = el.getAttribute('href');
    return { handle: handle(el), role: roleOf(el), name: h.name, hidden: why || undefined,
      opens_with: o ? { handle: handle(o), role: roleOf(o), name: clip(labelOf(o) || o.innerText || o.textContent, 60) } : undefined,
      href: href && !/^(#|javascript:)/i.test(href) ? el.href : undefined,
      // A link that only runs script: what it runs often names the address parameter it sets
      // (AddCriteria('saltyp=2')), which a nav step can set directly.
      runs: (!href || /^(#|javascript:)/i.test(href)) && el.getAttribute('onclick') ? clip(el.getAttribute('onclick'), 100) : undefined,
      value: el.matches('input,select,textarea') ? (el.type === 'checkbox' || el.type === 'radio' ? (el.checked ? 'checked' : 'unchecked') : el.value) : undefined,
      disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' || undefined };
  });
  // Plain text that matches but sits in no control: where it is, so a read or scroll-to finds it.
  var plain = hits.length ? [] : texts.slice(0, 8).map(function (el) {
    return { handle: handle(el), role: 'text', name: clip(el.textContent, 120), hidden: hiddenWhy(el) || undefined };
  });
  return { matches: hits.length, rows: rows.concat(plain), more: Math.max(0, hits.length - ${limit}) };
})()`;

export const FIELDS = ({ all: everything = false } = {}) => `(() => {
  ${WALK}
  var SEL = 'input,select,textarea,[role=combobox],[role=slider],[role=switch],[role=checkbox],[role=radio],[role=spinbutton],[role=textbox],[contenteditable=true]';
  var rows = [], groups = {}, unticked = 0;
  all(document).forEach(function (el) {
    if (!el.matches(SEL) || ours(el)) return;
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (el.tagName === 'INPUT' && /^(hidden|submit|button|reset|image)$/.test(type)) return;
    var why = hiddenWhy(el);
    var role = roleOf(el), label = clip(labelOf(el), 80);
    // A custom checkbox draws a hidden input under a visible box: judge it by its label.
    if (why && !/^(checkbox|radio)$/.test(role)) { if (!${everything}) return; }
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
      if (!on && !${everything}) { unticked++; return; }
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
})()`;

const q = (s) => `"${String(s ?? '').replace(/"/g, '\\"')}"`;

export function formatFind(r, pattern) {
  if (!r?.rows?.length) return `Nothing on the page matches /${pattern}/ (open shadow roots and hidden sections included). Try fewer words, or read --all.`;
  const lines = r.rows.map(x => {
    const bits = [`${x.handle.padEnd(9)} ${x.role.padEnd(9)} ${q(x.name)}`];
    if (x.value !== undefined) bits.push(`value ${q(x.value)}`);
    if (x.disabled) bits.push('disabled');
    if (x.hidden) bits.push(x.opens_with ? `${x.hidden}: opens with ${x.opens_with.role} ${q(x.opens_with.name)} ${x.opens_with.handle}` : x.hidden);
    if (x.href) bits.push(`→ ${x.href}`);
    if (x.runs) bits.push(`runs ${x.runs}`);
    return bits.join('  ');
  });
  if (r.more) lines.push(`(${r.more} more; narrow the pattern)`);
  lines.push('', 'Use a handle in a step: do <tab> \'click ref_12\' or \'click [data-bc-pin="…"]\'. A hidden one: click its opener first, or nav to its link.');
  return lines.join('\n');
}

export function formatFields(r) {
  if (!r?.rows?.length) return r?.unticked ? `No filled fields; ${r.unticked} unticked boxes (--all lists them).` : 'No form fields on this page.';
  const lines = r.rows.map(x => {
    const bits = [`${String(x.handle || '').padEnd(9)} ${x.role.padEnd(11)} ${q(x.label)}`];
    if (x.role === 'radio group') bits.push(x.value ? `= ${q(x.value)} (of ${x.options})` : `nothing chosen (${x.options} options)`);
    else bits.push(`= ${q(x.value)}`);
    if (x.options && x.role !== 'radio group') bits.push(`(${x.options} options)`);
    if (x.range) bits.push(`range ${x.range}`);
    for (const k of ['required', 'invalid', 'disabled']) if (x[k]) bits.push(k);
    if (x.hidden) bits.push(`(${x.hidden})`);
    return bits.join('  ');
  });
  if (r.unticked) lines.push(`(${r.unticked} unticked boxes not listed; --all lists them)`);
  if (r.more) lines.push(`(${r.more} more fields not listed)`);
  return lines.join('\n');
}

// What a person would notice changed after a plan: controls by role and name with their
// state, headings, alerts and status lines, and result counts. Taken before and after a do
// plan; diffPage compares the two.
export const PAGE_STATE_FOR_DIFF = `(() => {
  ${WALK}
  var CTL = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=option],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=slider],[role=dialog],[role=alertdialog],dialog[open]';
  var out = [], texts = [], n = 0;
  var COUNT = /\\b\\d[\\d,.]*\\+?\\s+(results?|items?|jobs?|matches|products?|listings?|homes?|properties|places|stays|hotels?|flights?|cars?|vehicles|reviews?|found|events?|courses?|companies)\\b|\\b(of|showing)\\s+\\d[\\d,.]*\\b|\\bno (results|matches)\\b/i;
  all(document).forEach(function (el) {
    if (n > 2500 || ours(el)) return;
    var tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return;
    var isCtl = el.matches(CTL), isHead = /^H[1-3]$/.test(tag) || el.getAttribute('role') === 'heading';
    var live = el.matches('[role=alert],[role=status],[aria-live=assertive],[aria-live=polite]');
    if (!isCtl && !isHead && !live && !(el.children.length === 0 && el.textContent.length < 120 && COUNT.test(el.textContent))) return;
    if (el.matches('input[type=hidden]') || hiddenWhy(el)) return;
    n++;
    var role = roleOf(el);
    if (tag === 'DIALOG') role = 'dialog';
    var name = clip(isCtl ? (labelOf(el) || el.innerText || el.textContent) : (el.innerText || el.textContent), 80);
    if (!isCtl) { if (name) texts.push({ kind: isHead ? 'heading' : live ? 'notice' : 'count', text: name }); return; }
    var st = {};
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (/^(checkbox|radio)$/.test(type)) st.checked = el.checked;
    else if (el.hasAttribute('aria-checked')) st.checked = el.getAttribute('aria-checked') === 'true';
    if (el.hasAttribute('aria-pressed')) st.pressed = el.getAttribute('aria-pressed') === 'true';
    if (el.hasAttribute('aria-expanded')) st.open = el.getAttribute('aria-expanded') === 'true';
    if (tag === 'SUMMARY' && el.parentElement) st.open = !!el.parentElement.open;
    if (el.hasAttribute('aria-selected')) st.selected = el.getAttribute('aria-selected') === 'true';
    if (tag === 'SELECT') st.value = clip(el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].text : '', 60);
    else if ((tag === 'INPUT' && !/^(checkbox|radio|button|submit|reset|image)$/.test(type)) || tag === 'TEXTAREA') st.value = clip(el.value, 60);
    else if (role === 'slider') st.value = el.getAttribute('aria-valuetext') || el.getAttribute('aria-valuenow') || '';
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') st.disabled = true;
    out.push({ role: role, name: name, st: st });
  });
  return { url: location.href, title: document.title, controls: out, texts: texts.slice(0, 200) };
})()`;

const uncount = (s) => String(s || '').replace(/\s*\(\s*\d[\d,.]*\s*\)\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
const stateWords = (st) => {
  const w = [];
  if ('checked' in st) w.push(st.checked ? 'checked' : 'unchecked');
  if ('pressed' in st) w.push(st.pressed ? 'pressed' : 'not pressed');
  if ('open' in st) w.push(st.open ? 'open' : 'closed');
  if ('selected' in st) w.push(st.selected ? 'selected' : 'not selected');
  if ('value' in st) w.push(`"${st.value}"`);
  if (st.disabled) w.push('disabled');
  return w.join(', ');
};

// The changes between two PAGE_STATE_FOR_DIFF results, a person's view: what flipped, what
// counts moved, what dialogs or controls appeared or went. null when nothing visible changed.
export function diffPage(a, b, { max = 12 } = {}) {
  if (!a || !b) return null;
  const path = (u) => { try { const x = new URL(u); return x.origin + x.pathname.replace(/\/+$/, ''); } catch { return u; } };
  const out = { changed: [], counts: [], notices: [], added: [], gone: [] };
  if (path(a.url) !== path(b.url)) {
    out.newPage = { title: b.title, headings: b.texts.filter(t => t.kind === 'heading').slice(0, 4).map(t => t.text) };
    return out;
  }
  const key = (c) => `${c.role}|${uncount(c.name)}`;
  const group = (list) => { const m = new Map(); for (const c of list) { const k = key(c); if (!m.has(k)) m.set(k, []); m.get(k).push(c); } return m; };
  const A = group(a.controls), B = group(b.controls);
  for (const [k, bs] of B) {
    const as = A.get(k) || [];
    bs.forEach((c, i) => {
      const old = as[i];
      if (!old) { out.added.push(c); return; }
      const was = stateWords(old.st), now = stateWords(c.st);
      if (was !== now || old.name !== c.name) out.changed.push({ role: c.role, name: c.name, was: old.name !== c.name ? `${old.name}` : was, now: old.name !== c.name ? `${c.name}${now ? `, ${now}` : ''}` : now, renamed: old.name !== c.name });
    });
  }
  for (const [k, as] of A) { const bs = B.get(k) || []; for (const c of as.slice(bs.length)) out.gone.push(c); }
  const textSet = (list, kind) => new Set(list.filter(t => t.kind === kind).map(t => t.text));
  for (const kind of ['count', 'notice', 'heading']) {
    const was = textSet(a.texts, kind), now = textSet(b.texts, kind);
    const fresh = [...now].filter(t => !was.has(t)), lost = [...was].filter(t => !now.has(t));
    if (kind === 'count') fresh.forEach((t, i) => out.counts.push({ was: lost[i] || null, now: t }));
    // A live region that only holds prices or numbers (a cart total, a carousel's prices)
    // is not a notice a person reads.
    else if (kind === 'notice') fresh.filter(t => (t.match(/[A-Za-z\u00C0-\uFFFF]/g) || []).length >= t.replace(/\s/g, '').length * 0.5).forEach(t => out.notices.push(t));
    else fresh.forEach(t => out.notices.push(`heading "${t}"`));
  }
  // A dialog that appeared is the first thing a person sees.
  out.added.sort((x, y) => (/dialog/.test(y.role) ? 1 : 0) - (/dialog/.test(x.role) ? 1 : 0));
  const any = out.changed.length + out.counts.length + out.notices.length + out.added.length + out.gone.length;
  return any ? out : null;
}

export function formatDiff(d, { max = 10 } = {}) {
  if (!d) return '';
  if (d.newPage) return `page now: a different page, "${clip(d.newPage.title, 80)}"${d.newPage.headings.length ? `; headings: ${d.newPage.headings.map(h => `"${clip(h, 50)}"`).join(', ')}` : ''}`;
  const lines = ['changed on the page:'];
  for (const c of d.counts.slice(0, 4)) lines.push(`  ${c.was ? `"${clip(c.was, 60)}" → ` : ''}"${clip(c.now, 60)}"`);
  for (const n of d.notices.slice(0, 4)) lines.push(`  ! ${clip(n, 100)}`);
  for (const c of d.changed.slice(0, max)) lines.push(c.renamed ? `  ${c.role} "${clip(c.was, 50)}" → "${clip(c.now, 60)}"` : `  ${c.role} "${clip(c.name, 50)}": ${c.was || '—'} → ${c.now || '—'}`);
  if (d.changed.length > max) lines.push(`  (${d.changed.length - max} more changed)`);
  // Named, once each: a reloaded list adds and removes dozens of "Yes"/"No" and unnamed
  // buttons that say nothing; its count says enough.
  const named = (xs) => { const seen = new Set(); return xs.filter(c => { const k = `${c.role}|${c.name}`; if (!c.name || seen.has(k)) return false; seen.add(k); return true; }); };
  const list = (xs, n) => { const ys = named(xs); return ys.slice(0, n).map(c => `${c.role} "${clip(c.name, 40)}"`).join(', ') + (ys.length > n ? `, …` : ''); };
  const many = d.added.length > 15 || d.gone.length > 15;
  for (const c of named(d.added.filter(c => /dialog/.test(c.role)))) lines.push(`  + ${c.role} "${clip(c.name, 60)}" opened`);
  if (many) lines.push(`  a list or section was redrawn: ${d.added.length} controls new, ${d.gone.length} gone; new ones include ${list(d.added, 4) || 'unnamed controls'}`);
  else {
    if (d.added.length) lines.push(`  + ${d.added.length} new: ${list(d.added, 6) || 'unnamed controls'}`);
    if (d.gone.length) lines.push(`  − ${d.gone.length} gone: ${list(d.gone, 6) || 'unnamed controls'}`);
  }
  return lines.join('\n');
}

function clip(s, n) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n); }

// Every slider on the page, grouped: a thumb is a native range input or a role=slider; two
// or more thumbs under one close ancestor form a range ("Price" with Minimum and Maximum).
// Names come from aria-label, aria-labelledby, a <label>, a fieldset legend or group label,
// or the nearest line of text before the control. Thumbs are pinned <pin>-g<i>-t<j>.
// With `only` (a pinned selector), just the group that holds that element.
({ pin, only }) => {
  only = only || null;
  for (const old of document.querySelectorAll('[data-bc-pin^="' + pin + '-g"]')) old.removeAttribute('data-bc-pin');
  // The element a ref or selector named, found before the thumbs are pinned (pinning
  // replaces the attribute that selector matched).
  const onlyEl = only ? (() => { const stack = [document]; while (stack.length) { const r = stack.pop(); const hit = r.querySelector(only); if (hit) return hit; for (const el of r.querySelectorAll('*')) if (el.shadowRoot && el.shadowRoot.mode === 'open') stack.push(el.shadowRoot); } return null; })() : null;
  const txt = (el) => (el ? (el.innerText || el.textContent || '') : '').replace(/\s+/g, ' ').trim();
  const byIds = (ids, el) => (ids || '').split(/\s+/).map(id => (el && el.getRootNode && el.getRootNode().getElementById ? el.getRootNode().getElementById(id) : null) || document.getElementById(id)).filter(Boolean).map(txt).join(' ').trim();
  // Sliders inside web components too (Chase's calculators draw them in shadow roots).
  const deepAll = (sel) => { const out = [], stack = [document]; while (stack.length) { const r = stack.pop(); for (const el of r.querySelectorAll('*')) { if (el.matches(sel)) out.push(el); if (el.shadowRoot && el.shadowRoot.mode === 'open') stack.push(el.shadowRoot); } } return out; };
  const thumbs = deepAll('input[type=range],[role=slider]').filter(el => !el.closest('[data-cdp]') && (isShown(el) || (el.matches('input') && el.parentElement && isShown(el.parentElement))));
  const own = (el) => el.getAttribute('aria-label') || byIds(el.getAttribute('aria-labelledby'), el) || (el.labels && el.labels[0] && txt(el.labels[0])) || el.getAttribute('title') || '';
  // The text a person reads next to a control: the closest preceding line that is not a number.
  const before = (el) => {
    for (let n = el, i = 0; n && n !== document.body && i < 4; n = n.parentElement, i++) {
      for (let p = n.previousElementSibling; p; p = p.previousElementSibling) {
        const t = txt(p).split(/\n/)[0];
        if (t && /[A-Za-z\u00C0-\uFFFF]{2}/.test(t) && t.length <= 60) return t;
      }
    }
    return '';
  };
  const groupOf = (el) => {
    for (let n = el.parentElement, i = 0; n && n !== document.body && i < 4; n = n.parentElement, i++) {
      const inside = thumbs.filter(t => n.contains(t));
      if (inside.length > 1) return n;
    }
    return null;
  };
  const labelOfGroup = (g, first) => {
    if (!g) return '';
    const legend = g.matches('fieldset') ? g.querySelector(':scope > legend') : null;
    return g.getAttribute('aria-label') || byIds(g.getAttribute('aria-labelledby'), g) || (legend && txt(legend)) || before(g) || before(first);
  };
  const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const stateOf = (el) => {
    const native = el.matches('input[type=range]');
    const min = native ? num(el.min || 0) : num(el.getAttribute('aria-valuemin'));
    const max = native ? num(el.max || 100) : num(el.getAttribute('aria-valuemax'));
    let now = native ? num(el.value) : num(el.getAttribute('aria-valuenow'));
    const text = el.getAttribute('aria-valuetext') || '';
    if (Number.isNaN(now) && text) { const m = text.replace(/(\d),(?=\d{3}\b)/g, '$1').match(/-?\d+(\.\d+)?/); if (m) now = Number(m[0]); }
    const step = native ? (el.step === 'any' ? 0 : num(el.step || 1)) : NaN;
    return { native, min, max, now, step, text, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true' };
  };
  const groups = [], seen = new Set();
  for (const t of thumbs) {
    if (seen.has(t)) continue;
    const g = groupOf(t);
    const members = g ? thumbs.filter(x => g.contains(x)) : [t];
    members.forEach(x => seen.add(x));
    groups.push({ g, members });
  }
  const out = [];
  groups.forEach(({ g, members }, i) => {
    if (only && !members.some(m => m === onlyEl || m.contains(onlyEl) || (onlyEl && onlyEl.contains(m)))) return;
    out.push({
      label: (members.length > 1 ? labelOfGroup(g, members[0]) : (own(members[0]) || before(members[0]))).slice(0, 80),
      thumbs: members.map((m, j) => { const key = pin + '-g' + i + '-t' + j; m.setAttribute('data-bc-pin', key); return { selector: '[data-bc-pin="' + key + '"]', name: own(m).slice(0, 60), only: !!(onlyEl && (m === onlyEl || m.contains(onlyEl) || onlyEl.contains(m))), ...stateOf(m) }; }),
    });
  });
  return out;
}

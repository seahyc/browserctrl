// Keep the option's expected value and its owning control before a popup can disappear.
({ selector, before, key, owner, optionsBefore, capture = false }) => {
  const el = selector ? findDeep(selector) : null;
  const text = el => (el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim();
  if (capture) {
    const kit = findKit();
    return kit.all(document).filter(el => el.matches('option,[role=option]') && isShown(el) && !kit.hiddenWhy(el)).map(text);
  }
  const tokens = value => String(value || '').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const changedValueMatches = (ctl, saved) => {
    if (!ctl || ctl.value == null || String(ctl.value) === saved.typed) return false;
    const now = new Set(tokens(ctl.value));
    const option = tokens(saved.name);
    const numbers = option.filter(t => /\d/.test(t));
    if (numbers.length && !numbers.every(t => now.has(t))) return false;
    const typed = tokens(saved.typed).filter(t => option.includes(t));
    if (typed.some(t => /\d/.test(t) && t.length >= 3) && typed.every(t => now.has(t))) return true;
    const words = [...new Set((saved.name.match(/[\p{L}\p{N}]+/gu) || [])
      .filter(t => t.length >= 3 && !/\d/.test(t) && !/^[A-Z]{2,3}$/.test(t))
      .map(t => t.toLocaleLowerCase()))];
    return words.length >= 2 && words.every(t => now.has(t));
  };
  const shown = el => el ? [el.value, el.getAttribute('aria-valuetext'), text(el)].filter(Boolean).join(' ').trim() : '';
  const outside = name => {
    const found = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) {
      const parent = node.parentElement;
      if (!parent || parent.closest('[role=listbox],[role=option],select,script,style') || !parent.checkVisibility()) continue;
      const value = node.textContent.replace(/\s+/g, ' ').trim();
      if (name && value.includes(name)) found.push(value);
    }
    return found;
  };
  if (before) {
    const ctl = before.control ? findDeep(before.control) : null;
    const now = shown(ctl);
    if (el && (el.selected === true || el.getAttribute('aria-selected') === 'true')) return 'VERIFIED';
    if (ctl && (now === before.name || now === before.value ||
      (now !== before.shown && before.name && (now.includes(before.name) || before.name.startsWith(now + ' '))) ||
      (ctl.value != null && String(ctl.value) === before.value))) return 'VERIFIED';
    if (changedValueMatches(ctl, before)) return 'VERIFIED';
    if (before.aria || (ctl && ctl.matches('select'))) return 'FAILED';
    const appeared = outside(before.name);
    if (appeared.some(value => appeared.filter(v => v === value).length > before.outside.filter(v => v === value).length)) return 'VERIFIED';
    if (ctl && now === before.shown) return 'FAILED';
    return 'UNVERIFIED';
  }
  if (!el) return null;
  const list = el.closest('[role=listbox],select');
  if (!el.matches('option,[role=option]') && !(list && el.matches('li,[role=listitem]'))) return null;
  const root = el.getRootNode();
  const controls = Array.from(root.querySelectorAll('[role=combobox],input,textarea,[role=textbox]'));
  const combos = controls.filter(c => c.matches('[role=combobox]'));
  const linked = controls.filter(c => list && list.id &&
    [c.getAttribute('aria-controls'), c.getAttribute('aria-owns')].some(ids => (ids || '').split(/\s+/).includes(list.id)));
  const expanded = combos.filter(c => c.getAttribute('aria-expanded') === 'true');
  const filled = owner && Array.isArray(optionsBefore) && !optionsBefore.includes(text(el)) ? findDeep(owner) : null;
  const ctl = el.closest('select') || (linked.length === 1 ? linked[0] : null) || (expanded.length === 1 ? expanded[0] : null) || filled;
  let control = null;
  if (ctl) { ctl.setAttribute('data-bc-option-control', key); control = `[data-bc-option-control="${key}"]`; }
  return { aria: el.hasAttribute('aria-selected') || !!(list && list.querySelector('[aria-selected]')), outside: outside(text(el)), control, typed: ctl?.value == null ? '' : String(ctl.value), shown: shown(ctl), name: text(el), value: String(el.value ?? el.getAttribute('data-value') ?? text(el)) };
}

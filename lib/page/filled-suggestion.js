// Prefer an exact option of the just-filled field over unrelated copies elsewhere on the page.
({ selector, value, key }) => {
  const field = findDeep(selector);
  if (!field) return null;
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const want = norm(value), rect = field.getBoundingClientRect();
  const controlled = (field.getAttribute('aria-controls') || '').split(/\s+/).concat((field.getAttribute('aria-owns') || '').split(/\s+/)).map(id => field.getRootNode().getElementById?.(id)).filter(Boolean);
  const kit = findKit();
  const shown = n => isShown(n) && !kit.hiddenWhy(n) && n.checkVisibility({checkOpacity:true});
  const popups = [...new Set([...controlled, ...kit.all(document).filter(n => n.matches('[role=listbox]'))])].filter(n => {
    if (!shown(n)) return false;
    if (controlled.includes(n)) return true;
    const b = n.getBoundingClientRect();
    return b.top >= rect.bottom - 8 && b.top <= rect.bottom + 200 && b.right > rect.left && b.left < rect.right;
  });
  const hits = popups.flatMap(n => [...n.querySelectorAll('[role=option],a[href],button,[role=link],[role=button]')]).filter(n => shown(n) && norm(n.getAttribute('aria-label') || n.innerText || n.textContent) === want);
  const unique = [...new Set(hits)];
  if (unique.length !== 1) return null;
  const el = unique[0];
  el.setAttribute('data-bc-pin', key);
  const info = elementInfo(el);
  return {...info, selector:'[data-bc-pin="' + key + '"]'};
}

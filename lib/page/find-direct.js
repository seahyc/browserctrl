// Find a direct target now: a pinned ref (kind pin), an item id from items, a CSS selector,
// or an option of an open listbox whose text is the target. A list item is clicked through
// its title link (itemControl). Pins it as key; returns elementInfo() plus the selector, or { error }.
({ kind, value, key, action }) => {
  let el = null;
  // The control a click on a whole item means: its title link, then any other link, then a
  // button. A toggle (Carnival's "Save Itinerary" heart, drawn first over each trip's image)
  // only when the item has nothing else: a plan that wants it names it.
  const CLICKY = 'a[href],button,[role=button],[role=link]';
  const toggle = n => /^(checkbox|radio|switch|menuitemcheckbox|menuitemradio)$/.test(n.getAttribute('role') || '') || n.hasAttribute('aria-pressed') || n.hasAttribute('aria-checked');
  const rank = n => n.matches('a[href]:not([href^="javascript:"]),[role=link]') ? (n.closest('h1,h2,h3,h4,h5,h6,[role=heading]') ? 0 : 1) : toggle(n) ? 3 : 2;
  const itemControl = item => {
    if (item.matches(CLICKY)) return item;
    const all = [...item.querySelectorAll(CLICKY)].filter(isShown);
    return all.sort((a, b) => rank(a) - rank(b))[0] || null;
  };
  if (kind === 'pin') {
    el = document.querySelector('[data-bc-pin="' + value + '"]');
    // The page redrew the pinned control during the plan: the one matching copy on screen.
    if (!el) el = bcRefind((window.__bcPinSig || {})[value]);
  }
  else if (kind === 'item') {
    const ids = window.__bcItems && window.__bcItems.ids;
    if (!ids) return { error: 'no_items' };
    for (const n of document.querySelectorAll('body *')) if (ids.get(n) === value) { el = n; break; }
    if (el && action === 'click') el = itemControl(el) || el;
  } else if (kind === 'selector') {
    let all;
    try { all = [...document.querySelectorAll(value)]; } catch (e) { return { error: 'invalid' }; }
    el = all.find(isShown) || all[0] || null;
  } else if (kind === 'text') {
    const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const want = norm(value), state = window.__bcItems;
    const kit = findKit();
    const titleMatches = n => {
      const text = state?.texts?.get(n);
      if (!text) return false;
      if (norm(text) === want || norm(text.split(' · ')[0]) === want) return true;
      return ['a[href],[role=link]', 'h1,h2,h3,h4,h5,h6,[role=heading]'].some(sel => {
        const title = n.querySelector(sel);
        return title && norm(title.innerText || title.textContent) === want;
      });
    };
    const hits = kit.all(document).filter(n =>
      (titleMatches(n) || (n.matches('a[href],[role=link]') && norm(n.innerText || n.textContent) === want)) &&
      !n.closest('[data-cdp]') && isShown(n) && !kit.hiddenWhy(n) && n.checkVisibility({ checkOpacity: true }));
    const targets = [...new Set(hits.map(n => itemControl(n) || n))];
    if (targets.length !== 1) return { error: 'none' };
    el = targets[0];
  } else if (kind === 'option') {
    const want = value.toLowerCase().replace(/\s+/g, ' ').trim();
    for (const o of document.querySelectorAll('[role=option],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],li[data-value],[data-value][tabindex]')) {
      if (!isShown(o) || o.closest('[data-cdp]')) continue;
      const t = (o.getAttribute('aria-label') || o.innerText || o.getAttribute('data-value') || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (t === want) { el = o; break; }
    }
  }
  if (!el) return { error: 'none' };
  if (!el.isConnected) return { error: 'detached' };
  el.setAttribute('data-bc-pin', key);
  return { ...elementInfo(el), selector: '[data-bc-pin="' + key + '"]', shown: isShown(el) };
}

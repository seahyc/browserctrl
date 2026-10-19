// Find a direct target now: a pinned ref (kind pin), an item id from items, a CSS selector,
// or an option of an open listbox whose text is the target. A list item is clicked through
// its first link or button. Pins it as key; returns elementInfo() plus the selector, or { error }.
({ kind, value, key, action }) => {
  let el = null;
  if (kind === 'pin') {
    el = document.querySelector('[data-bc-pin="' + value + '"]');
    // The page redrew the pinned control during the plan: the one matching copy on screen.
    if (!el) el = bcRefind((window.__bcPinSig || {})[value]);
  }
  else if (kind === 'item') {
    const ids = window.__bcItems && window.__bcItems.ids;
    if (!ids) return { error: 'no_items' };
    for (const n of document.querySelectorAll('body *')) if (ids.get(n) === value) { el = n; break; }
    if (el && action === 'click' && !el.matches('a[href],button,[role=button],[role=link]')) el = [...el.querySelectorAll('a[href],button,[role=button],[role=link]')].find(isShown) || el;
  } else if (kind === 'selector') {
    let all;
    try { all = [...document.querySelectorAll(value)]; } catch (e) { return { error: 'invalid' }; }
    el = all.find(isShown) || all[0] || null;
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

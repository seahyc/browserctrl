// Pin the element behind a ref of the last read as key, so a later step can find it by
// selector after another read renumbered the refs. Returns its selector, or null.
({ ref, key }) => {
  const els = (window.__cdp && window.__cdp.els) || [];
  const el = els[ref.replace('ref_', '') - 1];
  if (!el) return null;
  el.setAttribute('data-bc-pin', key);
  return '[data-bc-pin="' + key + '"]';
}

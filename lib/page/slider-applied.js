// Local visible value labels supplement aria/value when a page commits asynchronously.
({ selector }) => {
  const el = findDeep(selector);
  if (!el) return null;
  const native = el.matches('input[type=range]');
  const raw = native ? el.value : el.getAttribute('aria-valuenow');
  const labels = [];
  const add = (node) => { if (node && isShown(node)) { const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim(); if (text && text.length <= 100 && /\d/.test(text)) labels.push(text); } };
  if (el.getAttribute('aria-valuetext')) labels.push(el.getAttribute('aria-valuetext'));
  for (const id of (el.getAttribute('aria-describedby') || '').split(/\s+/)) if (id) add(el.getRootNode().getElementById?.(id));
  for (let parent = el.parentElement, depth = 0; parent && parent !== document.body && depth < 2; parent = parent.parentElement, depth++) {
    if (parent.querySelectorAll('input[type=range],[role=slider]').length !== 1) break;
    for (const output of parent.querySelectorAll('output')) add(output);
  }
  return { now: raw === null || raw === '' ? null : Number(raw), labels: [...new Set(labels)] };
}

// A clipping scroll ancestor can require another scroll after a late layout shift.
// Move only scroll containers that actually clip this target, never an unrelated cover.
({ selector, ref, token }) => {
  const target = selector ? findDeep(selector) : refLookup(ref, token);
  if (!target || typeof target === 'string' || target.ownerDocument !== document) return false;
  let moved = false;
  for (let node = target.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node), box = node.getBoundingClientRect(), rect = target.getBoundingClientRect();
    if (/^(inline|contents)$/.test(style.display)) continue;
    if (!box.width || !box.height) return false;
    const vertical = /auto|scroll|hidden/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
    const horizontal = /auto|scroll|hidden/.test(style.overflowX) && node.scrollWidth > node.clientWidth;
    const y = rect.top < box.top + node.clientTop || rect.bottom > box.top + node.clientTop + node.clientHeight;
    const x = rect.left < box.left + node.clientLeft || rect.right > box.left + node.clientLeft + node.clientWidth;
    if (vertical && y) { const before = node.scrollTop; node.scrollTop += rect.top - box.top - node.clientTop - (node.clientHeight - rect.height) / 2; moved ||= node.scrollTop !== before; }
    if (horizontal && x) { const before = node.scrollLeft; node.scrollLeft += rect.left - box.left - node.clientLeft - (node.clientWidth - rect.width) / 2; moved ||= node.scrollLeft !== before; }
  }
  if (!moved) return false;
  const rect = visibleRect(target);
  if (!rect.width || !rect.height) return false;
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return !!hit && (hit === target || target.contains(hit));
}

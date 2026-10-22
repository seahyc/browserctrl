// End a keyboard adjustment for controls that apply on release or change.
({ selector }) => {
  const el = findDeep(selector);
  if (!el) return;
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

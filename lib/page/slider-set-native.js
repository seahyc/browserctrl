// A native range input takes a value the way a person's drag would leave it: through the
// value setter React and other frameworks watch, then input and change events.
({ selector, value }) => {
  const el = findDeep(selector);
  if (!el) return null;
  el.focus();
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(el, String(value));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return Number(el.value);
}

// A slider thumb's value, limits, centre and track, and whether it has focus.
({ selector }) => {
  const el = findDeep(selector);
  if (!el || !el.isConnected) return null;
  const native = el.matches('input[type=range]');
  const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  let now = native ? num(el.value) : num(el.getAttribute('aria-valuenow'));
  const text = el.getAttribute('aria-valuetext') || '';
  if (Number.isNaN(now) && text) { const m = text.replace(/(\d),(?=\d{3}\b)/g, '$1').match(/-?\d+(\.\d+)?/); if (m) now = Number(m[0]); }
  const r = el.getBoundingClientRect();
  // The track: the nearest ancestor clearly wider than the thumb.
  let track = el.parentElement;
  while (track && track !== document.body && track.getBoundingClientRect().width < Math.max(r.width * 3, 40)) track = track.parentElement;
  const tr = track ? track.getBoundingClientRect() : r;
  const min = native ? num(el.min || 0) : num(el.getAttribute('aria-valuemin'));
  const max = native ? num(el.max || 100) : num(el.getAttribute('aria-valuemax'));
  return { now, min, max, native, x: r.left + r.width / 2, y: r.top + r.height / 2, track: { left: tr.left, width: tr.width }, focused: document.activeElement === el };
}

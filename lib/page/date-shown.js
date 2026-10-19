// After a day is clicked: does the page show it chosen? The cell (or its cell or button)
// carries a selected state or a selected-like class, the same day redrawn does, its look
// changed, a date field or button now shows the date, or a new line of text outside the
// calendar does ("Check-in: Thu, Oct 17"), in any format, with or without the year. A
// calendar that ignored the click shows none of these. date-look records the before.
({ selector, iso, before }) => {
  const { want, cell, isoOf, shows, outside, lines, lookOf } = dateCheck(selector, iso);
  before = before || null;
  const ON = /(^|[-_\s])(is-)?(selected|active|chosen|picked|checked|current|start|end|range-(start|end)|in-range|highlighted)([-_\s]|$)/i;
  const chosen = (el) => {
    if (!el) return false;
    for (const a of ['aria-selected', 'aria-pressed', 'aria-checked']) if (el.getAttribute(a) === 'true') return true;
    if (el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') return true;
    const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
    if (ON.test(cls)) return true;
    return /\bselected\b/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || ''));
  };
  const around = (el) => [el, el && el.parentElement, el && el.closest('td,[role=gridcell],[role=option]'), el && el.querySelector('button,[role=button],[aria-selected],[aria-pressed]')];
  if (cell && cell.isConnected) {
    if (around(cell).some(chosen)) return { shown: 'cell' };
    if (before && before.look && lookOf(cell) !== before.look) return { shown: 'look' };
  }
  // The calendar redrew: the same day, found again.
  for (const el of document.querySelectorAll('[aria-label],[data-date],[datetime],[title]')) {
    if (el === cell) continue;
    const label = [el.getAttribute('aria-label'), el.getAttribute('data-date'), el.getAttribute('datetime'), el.getAttribute('title')].filter(Boolean).join(' | ');
    if (!/\d/.test(label)) continue;
    let hit = false;
    for (const part of label.split(' | ')) if (isoOf(parseDateText(part)) === want) { hit = true; break; }
    if (hit && around(el).some(chosen)) return { shown: 'cell' };
  }
  // A field or the control that opened the picker shows the date.
  for (const el of document.querySelectorAll('input,textarea,[role=combobox],[role=textbox],button,[aria-haspopup],[aria-expanded],output,time')) {
    if (!outside(el)) continue;
    const t = el.matches('input,textarea') ? el.value : (el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '');
    if (shows(t)) return { shown: 'field' };
  }
  // A new line of text that shows it.
  if (before && lines() > before.lines) return { shown: 'text' };
  return { shown: null, cell: !!(cell && cell.isConnected) };
}

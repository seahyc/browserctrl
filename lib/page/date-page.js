// The clickable day cell for a date, the dates shown, and the month arrows. Pins the cell
// and arrows with data-bc-pin (<pin>-day, <pin>-next, <pin>-prev) so a click can find them.
({ iso: want, pin }) => {
  for (const old of document.querySelectorAll('[data-bc-pin^="' + pin + '-"]')) old.removeAttribute('data-bc-pin');
  const iso = (d) => d && d.y + '-' + String(d.m).padStart(2, '0') + '-' + String(d.d).padStart(2, '0');
  const labelOf = (el) => [el.getAttribute('aria-label'), el.getAttribute('data-date'), el.getAttribute('data-day'), el.getAttribute('data-testid'), el.getAttribute('datetime'), el.getAttribute('title')].filter(Boolean).join(' | ');
  // Day cells named only by their text ("October 16, 2026 16", a hidden label beside the
  // day number) carry the date in innerText: buttons and grid cells are read that way too.
  // Only inside a calendar-like grid: a dropdown button that shows a date is not a day cell.
  const inGrid = (el) => Boolean(el.closest('table,[role=grid],[role=rowgroup]')) || (el.parentElement && [...el.parentElement.children].filter(c => c.tagName === el.tagName).length >= 7);
  // Calendars drawn from plain elements (a Vue date picker's <span class="cell day">) mark
  // their day cells by class; headers and blanks are not days.
  const dayLike = (el) => { const c = typeof el.className === 'string' ? el.className : ''; return /(^|[\s_-])(day|date|cell)([\s_-]|$)/i.test(c) && !/header|name|blank|week|month|year/i.test(c); };
  const textOf = (el) => ((el.matches('button,td,[role=gridcell],[role=button]') || dayLike(el)) && inGrid(el) ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const cells = document.querySelectorAll('[aria-label],[data-date],[data-day],[data-testid],time[datetime],[title],button,td,[role=gridcell],[class*=day],[class*=date],[class*=cell]');
  // A grid of bare day numbers takes its month and year from the nearest heading before it
  // ("November 2026"), so calendars that label no day still work, side-by-side months too.
  const MONTH_YEAR = /^(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+(\d{4})$/i;
  const monthCache = new Map();
  const monthOf = (el) => {
    const grid = el.closest('table,[role=grid]') || (dayLike(el) && inGrid(el) ? el.parentElement : null);
    if (!grid) return null;
    if (monthCache.has(grid)) return monthCache.get(grid);
    let found = null;
    for (let n = grid.parentElement, i = 0; n && n !== document.body && i < 4 && !found; n = n.parentElement, i++) {
      for (const h of n.querySelectorAll('h1,h2,h3,h4,h5,h6,caption,[role=heading],strong,span,div')) {
        if (grid.contains(h) || h.children.length > 2) continue;
        if (!(h.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        const t = (h.innerText || '').replace(/\s+/g, ' ').trim();
        const m = t.match(MONTH_YEAR);
        if (m) found = { m: MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, y: +m[2] }; // the last heading before the grid wins
      }
    }
    monthCache.set(grid, found);
    return found;
  };
  let hit = null; const dates = [];
  for (let i = 0; i < cells.length && i < 5000; i++) {
    let el = cells[i];
    if (el.closest('[data-cdp]')) continue;
    const attrs = labelOf(el), own = textOf(el);
    const label = /\d/.test(attrs) || own.length > 60 ? attrs : own;
    if (!/\d/.test(label)) continue;
    let d = null;
    for (const part of label.split(' | ')) { d = parseDateText(part); if (d) break; }
    if (!d && /^\d{1,2}$/.test(label.trim())) { const mo = monthOf(el); if (mo) d = { y: mo.y, m: mo.m, d: +label.trim() }; }
    if (!d) continue;
    // A screen-reader label on a zero-size node inside the day: the day is its visible
    // clickable ancestor.
    if (!isShown(el)) {
      const up = el.closest('button,a,[role=button],[role=gridcell],td,[tabindex]');
      if (!up || !isShown(up)) continue;
      el = up;
    }
    dates.push(iso(d));
    if (!hit && iso(d) === want) {
      // Click the control itself: the cell, or the button inside it.
      const ctl = el.matches('button,a,[role=button],[role=gridcell],td,[tabindex]') ? el : (el.querySelector('button,a,[role=button]') || el);
      const off = ctl.disabled || ctl.getAttribute('aria-disabled') === 'true' || /\bdisabled\b|unavailable|blocked/i.test((ctl.className && ctl.className.baseVal !== undefined ? ctl.className.baseVal : ctl.className) || '');
      ctl.setAttribute('data-bc-pin', pin + '-day');
      hit = { label: label.slice(0, 80), disabled: !!off };
    }
  }
  // Month arrows: ones that say "month" first, then any next/previous arrow.
  const arrows = {}, found = { next: [], prev: [] };
  for (const el of document.querySelectorAll('button,a,[role=button],[class*=prev],[class*=next]')) {
    if (!isShown(el) || el.closest('[data-cdp]') || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
    // A bare element counts as an arrow only by its class, and only with no controls inside.
    if (!el.matches('button,a,[role=button]') && (el.querySelector('button,a,input') || (el.innerText || '').trim().length > 3)) continue;
    const n = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.innerText || '') + ' ' + (el.getAttribute('data-testid') || '') + ' ' + (typeof el.className === 'string' ? el.className : '')).toLowerCase().replace(/\s+/g, ' ').trim();
    if (/\bnext\b|forward|›|»|→|chevron.?right|arrow.?right/.test(n)) found.next.push([el, n]);
    if (/\bprev(ious)?\b|\bback\b|‹|«|←|chevron.?left|arrow.?left/.test(n)) found.prev.push([el, n]);
  }
  for (const k of ['next', 'prev']) {
    const pick = found[k].find(([, n]) => /month/.test(n)) || found[k][0];
    if (pick) { pick[0].setAttribute('data-bc-pin', pin + '-' + k); arrows[k] = pick[1].slice(0, 40); }
  }
  dates.sort();
  return { hit, first: dates[0] || null, last: dates[dates.length - 1] || null, count: dates.length, arrows };
}

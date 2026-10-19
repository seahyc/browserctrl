// Controls that may open a date picker, for a date step that finds no calendar: the plan's
// previous click may have closed a picker the page had opened by itself. Ranked by structure
// first: a date input, a field whose placeholder is a date format, a collapsed control that
// pops up a grid or dialog, a control whose name holds a date; date words only add weight.
// Pins them <pin>-open-<i>, best first, at most 3.
({ pin }) => {
  const WORDS = /\b(when|dates?|check[ -]?in|check[ -]?out|calendar|depart(ure|ing)?|arriv(e|al|ing)|return|pick[ -]?up|drop[ -]?off)\b/i;
  const FORMAT = /\b(mm|dd)\s*[\/.-]\s*(dd|mm)\b|\byyyy\b|\bjj\/mm\b|\btt\.mm\b/i;
  const DATEISH = /\b\d{1,2}[\/.-]\d{1,2}([\/.-]\d{2,4})?\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\badd dates?\b/i;
  const nameOf = (el) => (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.value || '').replace(/\s+/g, ' ').trim();
  const scored = [];
  for (const el of document.querySelectorAll('[aria-expanded="false"],[role=tab][aria-selected="false"],input[type=date],input[placeholder],[aria-haspopup]')) {
    if (!isShown(el) || el.closest('[data-cdp]') || el.disabled) continue;
    const name = nameOf(el), pop = (el.getAttribute('aria-haspopup') || '').toLowerCase();
    let sc = 0;
    if (el.matches('input[type=date]')) sc += 3;
    if (el.matches('input') && FORMAT.test(el.getAttribute('placeholder') || '')) sc += 3;
    if (pop === 'grid') sc += 2; else if (pop === 'dialog' || pop === 'true') sc += 1;
    if (DATEISH.test(name)) sc += 3;
    if (WORDS.test(name)) sc += 1;
    if (el.getAttribute('aria-expanded') !== 'false' && !el.matches('input')) sc -= 1; // already open, or no state to show
    if (sc >= 1) scored.push([sc, el, name]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, 3).map(([sc, el, name], i) => { el.setAttribute('data-bc-pin', pin + '-open-' + i); return { name: name.slice(0, 60), score: sc }; });
}

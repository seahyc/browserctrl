// Icon buttons with no name ("+", "−" next to "Children") get one from their row, so a plan
// can say "Increase Children" and an exact match or Jev can find it.
({ refs }) => {
  const els = (window.__cdp && window.__cdp.els) || [];
  const out = {};
  for (const ref of refs) {
    const el = els[parseInt(ref.replace('ref_', ''), 10) - 1];
    if (!el || !el.isConnected) continue;
    const hint = ((el.innerText || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.getAttribute('data-testid') || '') + ' ' + (typeof el.className === 'string' ? el.className : '') + ' ' + [...el.querySelectorAll('svg title, svg use, [class], [data-icon]')].slice(0, 4).map(n => (n.textContent || '') + ' ' + (n.getAttribute('href') || n.getAttribute('xlink:href') || '') + ' ' + (n.getAttribute('class') || '') + ' ' + (n.getAttribute('data-icon') || '')).join(' ')).toLowerCase();
    const own = (el.innerText || '').trim();
    if (!own && /(^|[\s_-])(close|closer|dismiss|cancel)([\s_-]|btn|button|icon|$)|(^|[\s_-])x-?mark|modal-x|icon-x([\s_-]|$)/i.test(hint)) { out[ref] = 'Close'; continue; }
    const verb = own === '+' ? 'Increase' : /^[-−–]$/.test(own) ? 'Decrease'
      : /\+|plus|increase|increment|\badd\b/.test(hint) ? 'Increase' : /−|–|minus|decrease|decrement|subtract/.test(hint) ? 'Decrease' : null;
    // The nearest ancestor with words of its own names the row: "Children Ages 0-17".
    let label = '';
    for (let n = el.parentElement, i = 0; n && i < 4 && !label; n = n.parentElement, i++) {
      const t = (n.innerText || '').split('\n').map(s => s.replace(/[+−–\-\d]/g, '').trim()).find(s => /[A-Za-z]{3,}/.test(s));
      if (t) label = t.slice(0, 40);
    }
    if (label || verb) out[ref] = verb ? verb + ' ' + (label || 'value') : label;
  }
  return out;
}

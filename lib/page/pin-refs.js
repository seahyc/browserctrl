// Pin the elements the caller's refs name, in the snapshot the caller read (token): a ref
// means what the agent's last read printed, even after another do read the page again.
// pins: [[ref, pin key], ...]. Returns 'ok' for each pinned, else { error: the lookup's code,
// was: { role, name } or null }.
({ pins, token }) => {
  const sigs = window.__bcPinSig || (window.__bcPinSig = {});
  const found = pins.map(([ref]) => refLookup(ref, token));
  // What a ref that no longer resolves named when it was read (a redrawn or removed
  // control keeps its old element in the snapshot): its role and name, so the stop can
  // offer the step by name instead.
  const was = (ref) => {
    const latest = window.__cdp, snaps = window.__cdpSnaps;
    const st = token ? (snaps && snaps.by[token]) || (latest && latest.token === token ? latest : null) : latest;
    if (!st) return null;
    const idx = /^e\d+$/.test(ref) ? (st.ids || {})[ref] : parseInt(String(ref).replace('ref_', ''), 10) - 1;
    const el = idx === undefined || isNaN(idx) ? null : st.els[idx];
    if (!el || !el.getAttribute) return null;
    const name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || ({ a: 'link', button: 'button', select: 'combobox', textarea: 'textbox' })[tag] || (tag === 'input' ? (/^(checkbox|radio|button|submit)$/.test(el.type) ? el.type.replace('submit', 'button') : 'textbox') : tag);
    return name ? { role, name } : null;
  };
  return pins.map(([ref, key], i) => {
    const el = found[i];
    if (typeof el === 'string') return { error: el, was: was(ref) };
    el.setAttribute('data-bc-pin', key);
    sigs[key] = bcSig(el); // to find it again if the page redraws it during the plan
    return 'ok';
  });
}

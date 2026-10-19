// Pin the elements the caller's refs name, in the snapshot the caller read (token): a ref
// means what the agent's last read printed, even after another do read the page again.
// pins: [[ref, pin key], ...]. Returns 'ok' or the lookup's error code for each.
({ pins, token }) => {
  const sigs = window.__bcPinSig || (window.__bcPinSig = {});
  const found = pins.map(([ref]) => refLookup(ref, token));
  return pins.map(([ref, key], i) => {
    const el = found[i];
    if (typeof el === 'string') return el;
    el.setAttribute('data-bc-pin', key);
    sigs[key] = bcSig(el); // to find it again if the page redraws it during the plan
    return 'ok';
  });
}

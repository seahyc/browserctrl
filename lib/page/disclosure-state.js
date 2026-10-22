// Whether what a click should open or close is open: a <summary>'s <details>, or a control's
// aria-expanded. A web component's own control in its shadow root counts for its host and for
// content slotted into it (an accordion's heading). activate: click that control directly.
({ selector, activate = false, visible = false }) => {
  const el = findDeep(selector);
  if (!el || !el.isConnected) return null;
  const CTL = 'summary,[aria-expanded]';
  let ctl = el.matches(CTL) ? el : el.closest(CTL);
  if (!ctl && el.shadowRoot) ctl = el.shadowRoot.querySelector(CTL);
  if (!ctl && el.assignedSlot) {
    const slot = el.assignedSlot, host = (slot.getRootNode() || {}).host;
    ctl = slot.closest(CTL) || (host && host.shadowRoot && host.shadowRoot.querySelector(CTL));
  }
  if (!ctl) return null;
  const read = () => ctl.tagName === 'SUMMARY' ? !!(ctl.parentElement && ctl.parentElement.open) : ctl.getAttribute('aria-expanded') === 'true';
  if (activate) ctl.click();
  if (!read() || !visible) return read();
  if (ctl.tagName === 'SUMMARY') return [...ctl.parentElement.children].some(n => n !== ctl && isShown(n));
  const ids = (ctl.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean);
  if (ids.length) return ids.some(id => { const n = ctl.getRootNode().getElementById(id); return n && isShown(n); });
  return !!(ctl.nextElementSibling && isShown(ctl.nextElementSibling));
}

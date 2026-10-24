// Whether what a click should open or close is open: a <summary>'s <details>, or a control's
// aria-expanded. A web component's own control in its shadow root counts for its host and for
// content slotted into it (an accordion's heading). activate: click that control directly.
// watch: from now on, note whether it opens at any moment (a flyout that opens under the
// pointer and shuts on the click that follows); seen: whether it did, and stop watching.
({ selector, activate = false, visible = false, watch = false, seen = false }) => {
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
  if (seen) {
    const w = window.__bcDisclosureWatch;
    if (!w || w.ctl !== ctl) return null;
    w.observer.disconnect();
    delete window.__bcDisclosureWatch;
    return w.opened;
  }
  if (watch) {
    window.__bcDisclosureWatch?.observer.disconnect();
    const w = { ctl, opened: false };
    w.observer = new MutationObserver(() => { if (read()) w.opened = true; });
    w.observer.observe(ctl.tagName === 'SUMMARY' ? ctl.parentElement : ctl, { attributes: true, attributeFilter: ['aria-expanded', 'open'] });
    window.__bcDisclosureWatch = w;
    return read();
  }
  if (activate) ctl.click();
  if (!read() || !visible) return read();
  if (ctl.tagName === 'SUMMARY') return [...ctl.parentElement.children].some(n => n !== ctl && isShown(n));
  const ids = (ctl.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean);
  if (ids.length) return ids.some(id => { const n = ctl.getRootNode().getElementById(id); return n && isShown(n); });
  if (ctl.nextElementSibling && isShown(ctl.nextElementSibling)) return true;
  // A popup control whose panel is rendered elsewhere (Carnival's filter modal in a React
  // portal at the end of <body>): any popup layer on screen that is not around the control.
  const pop = ctl.getAttribute('aria-haspopup');
  if (!pop || pop === 'false') return false;
  const on = n => { const r = n.getBoundingClientRect(); return isShown(n) && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight; };
  return [...document.querySelectorAll('dialog[open],[role=dialog],[aria-modal=true],[role=menu],[role=listbox],[popover]')].some(n => !n.contains(ctl) && on(n));
}

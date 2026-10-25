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
    // Links and buttons hidden near the control now: a panel the control does not name
    // (no aria-controls, not its next sibling) shows when one of them appears. The nearest
    // ancestor, up to four up, that holds any.
    const ACT = 'a[href],button,[role=menuitem],[role=option],[role=tab],input:not([type=hidden])';
    let hidden = [];
    for (let up = ctl.parentElement, i = 0; up && up !== document.body && i < 4 && !hidden.length; up = up.parentElement, i++) {
      hidden = [...up.querySelectorAll(ACT)].filter(n => n !== ctl && !ctl.contains(n) && !n.contains(ctl) && !isShown(n)).slice(0, 200);
    }
    window.__bcDisclosureHidden = { ctl, nodes: hidden };
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
  const near = window.__bcDisclosureHidden;
  const onScreen = n => { const r = n.getBoundingClientRect(); return isShown(n) && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight; };
  if (near && near.ctl === ctl && near.nodes.some(n => n.isConnected && onScreen(n))) return true;
  // A popup control whose panel is rendered elsewhere (Carnival's filter modal in a React
  // portal at the end of <body>): any popup layer on screen that is not around the control.
  const pop = ctl.getAttribute('aria-haspopup');
  if (!pop || pop === 'false') return false;
  return [...document.querySelectorAll('dialog[open],[role=dialog],[aria-modal=true],[role=menu],[role=listbox],[popover]')].some(n => !n.contains(ctl) && onScreen(n));
}

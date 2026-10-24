// A modal notice that only closes (UPS's "Service Alert": a message and an × button): the
// dialog on top of the target (or the one modal dialog on screen), when it holds no field,
// no choice and no button but its close control. Pins that control as key and returns
// { selector, name, dialog, text }, or null for anything that asks for a decision.
// gone: after the click, whether that control's dialog has left the screen.
({ selector, ref, token, key, gone }) => {
  const on = n => { const r = n.getBoundingClientRect(); return isShown(n) && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight; };
  const modal = n => { try { if (n.matches(':modal')) return true; } catch (e) {} return n.getAttribute('aria-modal') === 'true' || n.getAttribute('role') === 'alertdialog'; };
  const DIALOG = 'dialog,[role=dialog],[role=alertdialog],[aria-modal=true]';
  if (gone) {
    const b = document.querySelector(gone);
    const d = b && b.isConnected && b.closest(DIALOG);
    return !d || !on(d);
  }
  let dialog = null;
  const target = selector ? findDeep(selector) : ref ? refLookup(ref, token) : null;
  if (target && typeof target !== 'string') {
    const r = target.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2)));
    const d = hit && hit.closest(DIALOG);
    if (d && !d.contains(target) && on(d)) dialog = d;
  }
  if (!dialog) {
    // Behind a backdrop the hit is the backdrop: the one modal dialog on screen.
    const open = [...document.querySelectorAll(DIALOG)].filter(d => modal(d) && on(d) && !(target && d.contains(target)) && !d.closest('[data-cdp],[data-cdp-internal="true"]'));
    if (open.length !== 1) return null;
    dialog = open[0];
  }
  const FIELD = 'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]),select,textarea,[contenteditable=""],[contenteditable=true],[role=textbox],[role=combobox],[role=checkbox],[role=radio],[role=switch],[role=slider],[role=spinbutton],[role=listbox],[role=option],[role=menuitem],iframe';
  if ([...dialog.querySelectorAll(FIELD)].some(isShown)) return null;
  const name = n => (accName(n) || n.innerText || '').replace(/\s+/g, ' ').trim();
  const CLOSE = /^(close|dismiss|×|✕|✖|x|got it|understood|close (this )?(alert|notice|message|dialog|banner|window|popup|modal|service alert))$/i;
  const buttons = [...dialog.querySelectorAll('button,[role=button],input[type=button],input[type=submit]')].filter(isShown);
  if (!buttons.length || buttons.some(b => !CLOSE.test(name(b)))) return null;
  // Links in a notice are its "learn more"; a list of them is a choice (a country picker).
  if ([...dialog.querySelectorAll('a[href],[role=link]')].filter(isShown).length > 2) return null;
  const close = buttons.find(b => /^(close|dismiss|×|✕|✖|x)/i.test(name(b))) || buttons[0];
  close.setAttribute('data-bc-pin', key);
  const label = dialog.getAttribute('aria-label') || (dialog.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => (document.getElementById(id) || {}).textContent || '').join(' ');
  return { selector: '[data-bc-pin="' + key + '"]', name: name(close), dialog: label.replace(/\s+/g, ' ').trim(), text: (dialog.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200) };
}

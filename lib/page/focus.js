// Focus an element; true when it took the focus.
({ selector }) => { const el = findDeep(selector); if (!el) return false; el.focus(); return document.activeElement === el; }

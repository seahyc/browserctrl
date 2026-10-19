// Whether the element a selector names sits inside a dialog or overlay panel.
({ selector }) => { const el = document.querySelector(selector); return !!(el && inOverlay(el)); }

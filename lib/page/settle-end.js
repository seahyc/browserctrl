// Stop watching the page for changes, and forget a navigation the step started (it is done).
() => { const st = window.__bcSettle; if (st && st.mo) st.mo.disconnect(); window.__bcSettle = null; if (window.__bcLeaving) window.__bcLeaving.at = 0; }

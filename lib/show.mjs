// --show / BROWSERCTRL_SHOW=1: let a person watch automation. The tab comes to the
// front, each target is outlined just before the action, and a corner panel lists what
// ran and how long it took. Everything drawn is marked data-cdp so snapshots ignore it.
import * as ops from './ops.mjs';

export const showing = (flags = {}) => Boolean(flags.show) || process.env.BROWSERCTRL_SHOW === '1';

const esc = (s) => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

// Replace the panel's lines (do), or append one line to the recent-actions list.
export async function panel(conn, tab, { title = 'browserctrl', lines, append } = {}) {
  const js = `(() => {
    const st = window.__bcShow || (window.__bcShow = { lines: [] });
    ${append ? `st.lines.push(${JSON.stringify(append)}); st.lines = st.lines.slice(-8);` : `st.lines = ${JSON.stringify(lines || [])};`}
    let d = document.getElementById('bc-hud');
    if (!d) {
      d = document.createElement('div'); d.id = 'bc-hud'; d.setAttribute('data-cdp', '');
      d.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;max-width:460px;background:rgba(20,20,24,.9);color:#eee;font:12px/1.5 -apple-system,system-ui,sans-serif;padding:10px 12px;border-radius:10px;pointer-events:none;box-shadow:0 6px 24px rgba(0,0,0,.35);white-space:pre-wrap';
      document.documentElement.appendChild(d);
    }
    d.innerHTML = '<b>' + ${JSON.stringify(esc(title))} + '</b>\\n' + st.lines.map(l => l.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))).join('\\n');
  })()`;
  await ops.evaluate(conn, tab, js).catch(() => {});
}

// Outline the element behind a ref (from the latest snapshot) for a moment.
export async function flash(conn, tab, ref, ms = 300) {
  if (!ref) return;
  const idx = Number(String(ref).replace('ref_', '')) - 1;
  await ops.evaluate(conn, tab, `(() => { const el = window.__cdp && window.__cdp.els[${idx}]; if (!el) return; el.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = el.getBoundingClientRect(); const b = document.createElement('div'); b.setAttribute('data-cdp', ''); b.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:3px solid #ff2d55;border-radius:6px;box-shadow:0 0 0 6px rgba(255,45,85,.3);left:' + (r.left - 4) + 'px;top:' + (r.top - 4) + 'px;width:' + (r.width + 8) + 'px;height:' + (r.height + 8) + 'px'; document.documentElement.appendChild(b); setTimeout(() => b.remove(), ${ms * 2}); })()`).catch(() => {});
  await new Promise(r => setTimeout(r, ms));
}

export const bringToFront = (conn, tab) => ops.focus(conn, tab).catch(() => {});

// Annotate the controls a step is choosing among, on the page itself: dashed outlines
// with ref numbers for what Jev is shown, then each tinted by Jev's probability with the
// pick in red. `cands` are snapshot rows; `probs` maps ref -> p.
export async function annotate(conn, tab, { cands = [], probs = null, pick = null, note = '' } = {}) {
  const items = cands.slice(0, 200).map(c => ({ idx: Number(String(c.ref).replace('ref_', '')) - 1, label: c.ref.replace('ref_', ''), p: probs ? (probs[c.ref] ?? 0) : null, pick: c.ref === pick }));
  await ops.evaluate(conn, tab, `(() => {
    document.getElementById('bc-annot')?.remove();
    const layer = document.createElement('div'); layer.id = 'bc-annot'; layer.setAttribute('data-cdp', '');
    layer.style.cssText = 'position:fixed;inset:0;z-index:2147483645;pointer-events:none;font:10px -apple-system,system-ui,sans-serif';
    for (const it of ${JSON.stringify(items)}) {
      const el = window.__cdp && window.__cdp.els[it.idx]; if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.width < 2) continue;
      const g = it.p == null ? 0 : Math.max(0.08, it.p);
      const b = document.createElement('div');
      b.style.cssText = 'position:fixed;border-radius:4px;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;' +
        (it.pick ? 'outline:3px solid #ff2d55;box-shadow:0 0 0 5px rgba(255,45,85,.3);' : it.p == null ? 'outline:1px dashed rgba(90,120,255,.8);' : 'outline:2px solid rgba(20,170,80,' + (0.2 + g * 0.8) + ');background:rgba(20,200,90,' + (g * 0.4) + ');');
      const t = document.createElement('span');
      t.textContent = it.p == null || it.p < 0.02 ? it.label : Math.round(it.p * 100) + '%';
      t.style.cssText = 'position:absolute;left:-1px;top:-13px;padding:0 3px;border-radius:3px;color:#fff;background:' + (it.pick ? '#ff2d55' : it.p == null ? 'rgba(90,120,255,.85)' : 'rgba(20,150,70,.95)');
      b.appendChild(t); layer.appendChild(b);
    }
    document.documentElement.appendChild(layer);
    setTimeout(() => layer.remove(), 4000);
  })()`).catch(() => {});
}

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

// Show an action as a person would see it done: a cursor glides to the element, a ripple
// marks the click, and a label says what happens ("click Failed", "type jane",
// "⏎ Enter"). Without a ref the label sits at the focused element (type, key) or the
// middle of the screen (scroll, nav). Waits until the cursor has arrived.
export async function act(conn, tab, { ref = null, kind = 'click', label = '' } = {}) {
  const idx = ref ? Number(String(ref).replace('ref_', '')) - 1 : -1;
  await ops.evaluate(conn, tab, `(() => {
    const st = window.__bcShow || (window.__bcShow = { lines: [] });
    let el = ${idx} >= 0 && window.__cdp ? window.__cdp.els[${idx}] : null;
    if (!el && ${JSON.stringify(kind)} !== 'scroll' && ${JSON.stringify(kind)} !== 'nav') el = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el ? el.getBoundingClientRect() : { left: innerWidth / 2 - 1, top: innerHeight / 2 - 1, width: 2, height: 2 };
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const mk = (css) => { const d = document.createElement('div'); d.setAttribute('data-cdp', ''); d.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;' + css; document.documentElement.appendChild(d); return d; };
    let cur = document.getElementById('bc-cursor');
    if (!cur) {
      cur = mk('width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(255,45,85,.95);box-shadow:0 0 0 4px rgba(255,255,255,.9),0 2px 10px rgba(0,0,0,.4);transition:left .35s cubic-bezier(.2,.8,.2,1),top .35s cubic-bezier(.2,.8,.2,1);left:' + (st.cx ?? innerWidth / 2) + 'px;top:' + (st.cy ?? innerHeight / 2) + 'px');
      cur.id = 'bc-cursor';
    }
    requestAnimationFrame(() => { cur.style.left = x + 'px'; cur.style.top = y + 'px'; });
    st.cx = x; st.cy = y;
    if (el) {
      const box = mk('border:3px solid #ff2d55;border-radius:6px;box-shadow:0 0 0 6px rgba(255,45,85,.25);left:' + (r.left - 4) + 'px;top:' + (r.top - 4) + 'px;width:' + (r.width + 8) + 'px;height:' + (r.height + 8) + 'px');
      setTimeout(() => box.remove(), 1400);
    }
    const tag = mk('background:#ff2d55;color:#fff;font:600 13px/1.3 -apple-system,system-ui,sans-serif;padding:4px 9px;border-radius:7px;box-shadow:0 3px 12px rgba(0,0,0,.3);white-space:nowrap;max-width:420px;overflow:hidden;text-overflow:ellipsis;left:' + Math.min(innerWidth - 200, Math.max(8, r.left)) + 'px;top:' + (r.top > 40 ? r.top - 34 : r.top + r.height + 8) + 'px');
    tag.textContent = ${JSON.stringify(label)};
    setTimeout(() => tag.remove(), 1600);
    if (${JSON.stringify(kind)} === 'click') setTimeout(() => {
      const rip = mk('width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;border:3px solid #ff2d55;left:' + x + 'px;top:' + y + 'px;transition:all .5s ease-out;opacity:1');
      requestAnimationFrame(() => { rip.style.width = rip.style.height = '56px'; rip.style.margin = '-28px 0 0 -28px'; rip.style.opacity = '0'; });
      setTimeout(() => rip.remove(), 600);
    }, 380);
  })()`).catch(() => {});
  await new Promise(r => setTimeout(r, 450));
}

// A ticking "agent is thinking" line in the panel while no command runs, so a pause
// reads as the agent deciding rather than the page hanging. busy(true) while a command
// runs; busy(false, note) when it ends.
export async function busy(conn, tab, on, note = '') {
  await ops.evaluate(conn, tab, `(() => {
    const st = window.__bcShow || (window.__bcShow = { lines: [] });
    st.busy = ${on ? 'true' : 'false'}; st.since = Date.now(); st.note = ${JSON.stringify(note)};
    if (st.timer) return;
    st.timer = setInterval(() => {
      const d = document.getElementById('bc-hud'); if (!d) return;
      let f = document.getElementById('bc-hud-idle');
      if (!f) { f = document.createElement('div'); f.id = 'bc-hud-idle'; f.style.cssText = 'margin-top:6px;color:#9ad;font-weight:600'; d.appendChild(f); }
      const s = Math.round((Date.now() - st.since) / 1000);
      f.textContent = st.busy ? '⚙ ' + (st.note || 'working') + '… ' + s + 's' : (s >= 2 ? '💭 agent is deciding the next step… ' + s + 's' : '');
    }, 250);
  })()`).catch(() => {});
}

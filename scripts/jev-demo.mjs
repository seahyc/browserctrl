#!/usr/bin/env node
// Show, on the page itself, how Jev resolves an intent to an element.
//   node scripts/jev-demo.mjs <tab> "<intent>" [--action click|fill] [--value text] [--dry] [--browser dia]
// 1. outlines every candidate element Jev is offered, 2. tints them by Jev's probability,
// 3. clicks the pick (unless --dry or the pick is refused) and shows the page checks.
import { execFileSync } from 'node:child_process';
import * as jev from '../lib/jev.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const [tab, intent] = args;
const action = flag('--action', 'click');
const browser = flag('--browser', 'dia');
const dry = args.includes('--dry');
if (!tab || !intent) { console.error('usage: jev-demo.mjs <tab> "<intent>" [--action click|fill] [--value text] [--dry]'); process.exit(1); }

const bc = (...a) => execFileSync('browserctrl', [...a, '--browser', browser], { encoding: 'utf8', maxBuffer: 32 << 20 });
const evalJs = (js) => JSON.parse(bc('eval', tab, `JSON.stringify(${js})`) || 'null');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Everything drawn is marked data-cdp so browserctrl's own snapshots ignore it.
const OVERLAY = `(() => {
  document.getElementById('jev-demo')?.remove();
  const root = document.createElement('div');
  root.id = 'jev-demo'; root.setAttribute('data-cdp', '');
  root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;font:12px/1.35 -apple-system,system-ui,sans-serif';
  const panel = document.createElement('div');
  panel.id = 'jev-demo-panel';
  panel.style.cssText = 'position:fixed;right:12px;bottom:12px;width:360px;max-height:60vh;overflow:auto;background:rgba(20,20,24,.92);color:#eee;border-radius:10px;padding:12px 14px;box-shadow:0 8px 30px rgba(0,0,0,.35);white-space:pre-wrap';
  root.appendChild(panel);
  document.documentElement.appendChild(root);
  window.__jevDemo = {
    panel(html) { panel.innerHTML = html; },
    boxes(items) {
      root.querySelectorAll('.jev-box').forEach(n => n.remove());
      for (const it of items) {
        const b = document.createElement('div');
        b.className = 'jev-box';
        const g = it.p == null ? 0 : Math.max(0.08, it.p);
        b.style.cssText = 'position:fixed;border-radius:4px;transition:all .35s;' +
          'left:' + it.x + 'px;top:' + it.y + 'px;width:' + it.w + 'px;height:' + it.h + 'px;' +
          (it.p == null ? 'outline:1px dashed rgba(90,120,255,.75);' : 'outline:2px solid rgba(20,170,80,' + (0.25 + g * 0.75) + ');background:rgba(20,200,90,' + (g * 0.45) + ');') +
          (it.pick ? 'outline:3px solid #ff2d55;box-shadow:0 0 0 6px rgba(255,45,85,.35);' : '');
        const tag = document.createElement('span');
        tag.textContent = it.label;
        tag.style.cssText = 'position:absolute;left:-1px;top:-15px;padding:0 4px;border-radius:3px;font-size:10px;color:#fff;background:' + (it.pick ? '#ff2d55' : it.p == null ? 'rgba(90,120,255,.85)' : 'rgba(20,150,70,.95)');
        b.appendChild(tag);
        root.appendChild(b);
      }
    },
  };
  return true;
})()`;

const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const panel = (html) => bc('eval', tab, `window.__jevDemo.panel(${JSON.stringify(html)})`);
const boxes = (items) => bc('eval', tab, `window.__jevDemo.boxes(${JSON.stringify(items)})`);

const cfg = jev.jevKey();
const snap = JSON.parse(bc('read', tab, '--json', '--max-text', '0'));
evalJs(OVERLAY);
const view = evalJs(jev.VIEW_TEXT);
const cands = jev.shortlist(jev.candidatesFor(snap.elements, action), intent);
const onScreen = (e) => e.box && e.box.y + e.box.h > 0 && e.box.y < 2000;

// 1. What Jev is given.
boxes(cands.filter(onScreen).map(e => ({ ...e.box, label: e.ref.replace('ref_', ''), p: null })));
panel(`<b>Intent</b>  ${esc(intent)}  <i>(${action})</i>\n\n<b>What Jev gets</b>\n• ${cands.length} ${action}able elements (dashed blue): role + name + link\n• on-screen text: ${view.overlay ? `${view.overlay.length} chars of overlay + ` : ''}${Math.min((view.view || '').length, 3000)} chars\n\nOne Choice question: which element, or "none"?`);
console.log(`1/3 showing ${cands.length} candidates`);
await sleep(3500);

// 2. Jev's answer.
const pick = await jev.pickTarget(cfg, snap, { intent, action, view });
const why = jev.refusal(pick);
const prob = Object.fromEntries(pick.ranked.map(r => [r.ref, r.p]));
boxes(cands.filter(onScreen).map(e => ({ ...e.box, p: prob[e.ref] ?? 0.0, pick: !why && pick.pick?.ref === e.ref, label: prob[e.ref] ? `${Math.round(prob[e.ref] * 100)}%` : e.ref.replace('ref_', '') })));
const rows = pick.ranked.map(r => `${String(Math.round(r.p * 100)).padStart(3)}%  ${r.ref === 'none' ? '<i>none of these</i>' : esc(`${r.role} “${(r.name || '').slice(0, 40)}”`)}`).join('\n');
panel(`<b>Intent</b>  ${esc(intent)}\n\n<b>Jev's answer</b>  (${pick.ms} ms, ${pick.model})\n${rows}\n\n${why ? `<b style="color:#ff9f0a">Won't act:</b> ${esc(why)}` : `<b style="color:#30d158">Act on</b> ${esc(pick.pick.role)} “${esc((pick.pick.name || '').slice(0, 50))}” (p=${pick.p})`}`);
console.log(`2/3 ${why ? `refused: ${why}` : `pick ${pick.pick.ref} ${pick.pick.name} p=${pick.p}`} (${pick.ms} ms)`);
await sleep(4500);
if (why || dry) process.exit(0);

// 3. Act, then check the page.
if (action === 'fill') bc('fill', tab, '--ref', pick.pick.ref, '--token', snap.token, '--value', flag('--value', ''));
else bc('click', tab, '--ref', pick.pick.ref, '--token', snap.token);
await sleep(900);
evalJs(OVERLAY);
const after = await jev.checkPage(cfg, evalJs(jev.VIEW_TEXT), { expect: flag('--expect') });
panel(`<b>Intent</b>  ${esc(intent)}\n\n<b>Clicked</b> “${esc((pick.pick.name || '').slice(0, 50))}”\n\n<b>Page checks</b> (${after.ms} ms, one request)\n${Object.entries(after.checks).map(([k, v]) => `${String(Math.round(v * 100)).padStart(3)}%  ${k}`).join('\n')}`);
console.log('3/3 acted; checks', JSON.stringify(after.checks));

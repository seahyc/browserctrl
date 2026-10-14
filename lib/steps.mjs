// Run a short plan of steps in one call: the agent plans, browserctrl finds each target
// (an exact name match first, else one Jev choice) and stops at the first step it cannot
// do with confidence, returning the page so the agent can re-plan.
import * as ops from './ops.mjs';
import * as jev from './jev.mjs';
import { itemsExpression, formatItems } from './items.mjs';

const ACTIONS = new Set(['click', 'fill', 'select', 'hover', 'key', 'scroll', 'nav', 'expect', 'wait']);

// `click "More filters"`, `fill "the search box" = "aeron"`, `select Sort = Price`,
// `key Enter`, `scroll down`, `nav https://…`, `expect "results are filtered"`, `wait 1500`.
export function parseStep(line) {
  const m = String(line).trim().match(/^(\w+)\s*(.*)$/s);
  if (!m || !ACTIONS.has(m[1])) throw new Error(`Unknown step "${line}". Steps: ${[...ACTIONS].join(', ')}`);
  const action = m[1];
  let rest = m[2].trim();
  const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/s, '$2');
  if (action === 'fill' || action === 'select') {
    const eq = rest.match(/^(".*?"|'.*?'|[^=]+?)\s*=\s*(.*)$/s);
    if (!eq) throw new Error(`"${line}": write ${action} <target> = <value>`);
    return { action, target: unquote(eq[1]), value: unquote(eq[2]) };
  }
  if (['click', 'hover', 'expect'].includes(action) && !rest) throw new Error(`"${line}": name the ${action === 'expect' ? 'expected state' : 'element'}`);
  return { action, target: unquote(rest) };
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// An element whose name is exactly the target needs no model: "Apply", "More filters".
export function exactMatch(snap, step) {
  const want = norm(step.target);
  const hits = jev.candidatesFor(snap.elements, step.action).filter(e => norm(e.name) === want);
  return hits.length === 1 ? hits[0] : null;
}

// Wait until the DOM has been quiet for a moment, so the next step sees the result.
const SETTLE = (quietMs, maxMs) => `new Promise(resolve => {
  let last = Date.now(); const start = last;
  const mo = new MutationObserver(() => { last = Date.now(); });
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  // A filter or search usually fetches before it re-renders: new requests count as activity.
  let seen = performance.getEntriesByType('resource').length;
  const tick = () => {
    const n = performance.getEntriesByType('resource').length;
    if (n !== seen) { seen = n; last = Date.now(); }
    const now = Date.now();
    if (document.readyState === 'complete' && now - last >= ${quietMs} || now - start >= ${maxMs}) { mo.disconnect(); resolve(now - start); }
    else setTimeout(tick, 50);
  };
  tick();
})`;

// A click or Enter often starts a navigation a moment later; waiting on the old page's
// quiet DOM would hand the next step a page in transition. Give the navigation time to
// start, then wait for the current document to load and go quiet.
async function settle(conn, tab, { quietMs = 300, maxMs = 4000 } = {}) {
  const t0 = Date.now();
  await new Promise(r => setTimeout(r, 150));
  for (let i = 0; i < 3; i++) {
    await ops.waitForReady(conn, tab, { timeoutMs: 8000 }).catch(() => {});
    const ok = await ops.evaluate(conn, tab, SETTLE(quietMs, maxMs), { timeoutMs: maxMs + 3000 }).then(() => true, () => false);
    if (ok) break; // the document was replaced mid-wait otherwise: wait on the new one
  }
  return Date.now() - t0;
}

export async function runSteps(conn, tab, lines, { then, minP = 0.6, key: cfgIn } = {}) {
  const steps = lines.map(parseStep);
  let cfg = cfgIn;
  const getCfg = () => (cfg ||= jev.jevKey());
  const report = { steps: [], ms: 0 };
  const started = Date.now();
  // A background tab that does not render routes input by its last painted frame, so a
  // click can land on what used to be there. Keep it rendering without focusing it.
  await ops.wake(conn, tab).catch(() => {});
  let stopped = null;

  for (const [i, step] of steps.entries()) {
    const t0 = Date.now();
    const row = { step: i + 1, do: lines[i] };
    report.steps.push(row);
    try {
      if (step.action === 'key') { await ops.key(conn, tab, step.target); }
      else if (step.action === 'scroll') { await ops.scroll(conn, tab, { deltaY: /up/i.test(step.target) ? -700 : 700 }); }
      else if (step.action === 'wait') { await new Promise(r => setTimeout(r, Math.min(Number(step.target) || 1000, 10000))); }
      else if (step.action === 'nav') { await ops.navigate(conn, tab, step.target, { timeoutMs: 30000 }); }
      else if (step.action === 'expect') {
        const page = await ops.evaluate(conn, tab, jev.VIEW_TEXT);
        const c = await jev.checkPage(getCfg(), page, { expect: step.target });
        row.p = c.checks.expect;
        if (!c.expected) { stopped = { step: i + 1, reason: `The page does not show: ${step.target} (p=${c.checks.expect})`, flags: c.flags }; }
      } else {
        let snap = await ops.readPage(conn, tab, { maxText: 0, max: 400 });
        let el = exactMatch(snap, step);
        if (el) row.how = 'exact';
        else {
          let view = await ops.evaluate(conn, tab, jev.VIEW_TEXT);
          let pick = await jev.pickTarget(getCfg(), snap, { intent: step.target, action: step.action, view });
          if (!pick.pick) {
            // Often the page is still rendering what the step needs: settle once more and retry.
            row.retried = true;
            await settle(conn, tab, { maxMs: 2500 });
            snap = await ops.readPage(conn, tab, { maxText: 0, max: 400 });
            el = exactMatch(snap, step);
            if (el) { row.how = 'exact'; pick = null; }
            else {
              view = await ops.evaluate(conn, tab, jev.VIEW_TEXT);
              pick = await jev.pickTarget(getCfg(), snap, { intent: step.target, action: step.action, view });
            }
          }
          const why = pick && jev.refusal(pick, minP);
          if (why) { stopped = { step: i + 1, reason: why, candidates: pick.ranked }; }
          else if (pick) { el = pick.pick; row.how = `jev p=${pick.p}`; row.jev_ms = pick.ms; }
        }
        if (el && !stopped) {
          // An exact match skips Jev, so it gets the same commit guard here.
          if (row.how === 'exact' && jev.refusal({ pick: el, p: 1 }, 0)) {
            stopped = { step: i + 1, reason: jev.refusal({ pick: el, p: 1 }, 0) };
          } else {
            const t = { ref: el.ref, token: snap.token };
            row.target = `${el.role} "${(el.name || '').slice(0, 60)}"`;
            if (step.action === 'click') await ops.click(conn, tab, t);
            else if (step.action === 'hover') await ops.hover(conn, tab, t);
            else if (step.action === 'fill') await ops.fill(conn, tab, { ...t, value: step.value });
            else if (step.action === 'select') await ops.selectOption(conn, tab, { ...t, label: step.value });
          }
        }
      }
      if (!stopped && !['expect', 'wait'].includes(step.action)) row.settle_ms = await settle(conn, tab);
    } catch (e) {
      stopped = { step: i + 1, reason: e.message };
    }
    row.ms = Date.now() - t0;
    if (stopped) { row.stopped = true; break; }
  }

  report.ms = Date.now() - started;
  if (stopped) report.stopped = stopped;
  report.done = !stopped;
  const page = await ops.evaluate(conn, tab, jev.VIEW_TEXT);
  report.page = { url: page.url, title: page.title };
  // A challenge or login wall after the plan is the most common reason a run "worked" but
  // shows nothing useful; one check catches it.
  try { const c = await jev.checkPage(getCfg(), page); if (c.flags.length) report.flags = c.flags; } catch {}
  if (then === 'items') report.items = await ops.evaluate(conn, tab, itemsExpression({}));
  else if (then === 'text') report.text = `${page.overlay ? `${page.overlay}\n` : ''}${page.view}`.slice(0, 6000);
  return report;
}

export function formatSteps(r) {
  const lines = r.steps.map(s => `${s.stopped ? '✗' : '✓'} ${s.step}. ${s.do}${s.target ? `  → ${s.target}` : ''}${s.how ? ` (${s.how})` : ''}${s.p !== undefined ? ` (p=${s.p})` : ''}  ${s.ms} ms`);
  if (r.stopped) {
    lines.push(`\nStopped at step ${r.stopped.step}: ${r.stopped.reason}`);
    for (const c of r.stopped.candidates || []) lines.push(`  ${String(Math.round(c.p * 100)).padStart(3)}%  ${c.ref}${c.name ? ` ${c.role} "${c.name.slice(0, 60)}"` : ''}`);
  }
  lines.push(`\n${r.page.title}\n${r.page.url}${r.flags ? `\nflags: ${r.flags.join(', ')}` : ''}   total ${r.ms} ms`);
  if (r.items) lines.push(`\n${formatItems(r.items)}`);
  if (r.text) lines.push(`\n${r.text}`);
  return lines.join('\n');
}

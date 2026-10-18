// A JSONL trace per tab of every `do` run, so the agent can review what a plan did
// (targets, dismissed overlays, notices, expectations) later without spending turns
// during the plan. One line per step, then one summary line per run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as recording from './recording.mjs';
import * as caps from './caps.mjs';

export const dir = () => process.env.BROWSERCTRL_TRACES || path.join(os.homedir(), '.local/share/browserctrl/traces');
const fileFor = (tab) => path.join(dir(), `${String(tab).replace(/[^\w.-]/g, '_')}.jsonl`);

export function append(tab, records) {
  if (!recording.enabled('trace')) return null; // browserctrl trace off: see recording.mjs
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.appendFileSync(fileFor(tab), records.map(r => JSON.stringify(r)).join('\n') + '\n');
    // Capped: a tab's log keeps its latest runs (2 MB), the folder its newest logs (50 MB).
    if (caps.trimLog(fileFor(tab), 2 * 1024 * 1024) || Math.random() < 0.05) caps.prune(dir(), caps.capBytes('trace'), { keep: [path.basename(fileFor(tab))] });
    return fileFor(tab);
  } catch { return null; }
}

// The last N runs for a tab id or id prefix, newest last.
export function read(tab, { last = 5 } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir()).filter(n => n.endsWith('.jsonl') && n.startsWith(String(tab))); } catch {}
  if (!names.length) throw new Error(`No trace for tab ${tab} in ${dir()}${recording.enabled('trace') ? '' : ' (traces are off: browserctrl trace on)'}`);
  if (names.length > 1) throw new Error(`Tab prefix ${tab} matches ${names.length} traces: ${names.map(n => n.slice(0, -6)).join(', ')}`);
  const runs = new Map();
  for (const line of fs.readFileSync(path.join(dir(), names[0]), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!runs.has(r.run)) runs.set(r.run, { run: r.run, steps: [], summary: null });
    const run = runs.get(r.run);
    if (r.kind === 'run') run.summary = r; else run.steps.push(r);
  }
  return [...runs.values()].slice(-last);
}

const clip = (s, n = 80) => { s = String(s ?? '').replace(/\s+/g, ' '); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

export function format(runs) {
  const out = [];
  for (const { run, steps, summary: s } of runs) {
    out.push(`${s?.at || steps[0]?.at || ''}  run ${run}  ${s ? (s.done ? 'done' : 'stopped') : '(incomplete)'}${s ? `  ${s.ms} ms, ${s.jev_calls} Jev calls` : ''}`);
    for (const r of steps) {
      const bits = [
        r.target && `→ ${r.target.role} "${clip(r.target.name, 50)}" ${r.target.ref || ''}`.trim(),
        r.how && `(${r.how})`,
        r.expect && `expect "${clip(r.expect, 50)}" p=${r.expect_p ?? '?'}`,
        r.url_after && r.url_after !== r.url_before && `url → ${clip(r.url_after, 70)}`,
        r.settle_ms != null && `settle ${r.settle_ms} ms`,
      ].filter(Boolean).join('  ');
      out.push(`  ${r.stop ? '✗' : r.skipped ? '–' : '✓'} ${r.step}. ${clip(r.do, 70)}  ${bits}`);
      for (const d of r.dismissed || []) out.push(`      dismissed ${d.category}: "${clip(d.text, 60)}" via ${d.control}`);
      for (const e of r.events || []) out.push(`      notice: "${clip(e.text, 90)}"`);
      if (r.skipped) out.push(`      skipped: ${clip(r.skipped, 100)}`);
      if (r.stop) out.push(`      stopped: ${clip(r.stop, 140)}`);
    }
    if (s?.phases && Object.keys(s.phases).length) out.push(`  time: ${Object.entries(s.phases).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`).join(' · ')}`);
    if (s?.loop) out.push(`  loop: ${s.loop.pages} pages, ended by ${clip(s.loop.ended, 100)}${s.loop.items != null ? `, ${s.loop.items} items` : ''}`);
    if (s?.stopped && !steps.some(r => r.stop)) out.push(`  stopped: ${clip(s.stopped, 140)}`);
  }
  return out.join('\n');
}

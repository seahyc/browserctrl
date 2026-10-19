#!/usr/bin/env node
// Turns a browserctrl recording into what Online-Mind2Web's judge reads. Benchmark-only,
// so it lives here and not in the product.
//   node bench/om2w/export.mjs <recording dir> <out dir> --task-id ID --task "..." [--answer "..."]
// The judge's trajectories_dir layout is <out dir>/<task_id>/{result.json, trajectory/}.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonl } from '../../lib/rec.mjs';

// Online-Mind2Web v2 result.json (what its WebJudge reads), next to the stills.
// With `root`, writes <root>/<task_id>/{result.json, trajectory/} as the judge's
// trajectories_dir expects, hard-linking the stills.
export function exportOm2w(dir, { taskId, task, answer = '', root } = {}) {
  if (!taskId || !task) throw new Error('Online-Mind2Web export needs --task-id and --task');
  const steps = readJsonl(path.join(dir, 'steps.jsonl'));
  let last = null;
  const history = [];
  for (const s of steps) {
    if (s.screenshot) last = s.screenshot;
    if (!last) continue; // nothing to show yet
    if (s.action === 'stop recording' && history.length) continue;
    history.push({ step: history.length, screenshot: s.screenshot || last, url: s.url || null, action: s.action, action_status: s.status ?? null, thought: '' });
  }
  const result = { schema_version: 'online-mind2web-v2', task, task_id: taskId, agent_final_answer: answer, action_history: history };
  const outDir = root ? path.join(root, taskId) : dir;
  fs.mkdirSync(path.join(outDir, 'trajectory'), { recursive: true });
  if (outDir !== dir) {
    for (const f of new Set(history.map(h => h.screenshot))) {
      const to = path.join(outDir, 'trajectory', f);
      fs.rmSync(to, { force: true });
      try { fs.linkSync(path.join(dir, 'trajectory', f), to); } catch { fs.copyFileSync(path.join(dir, 'trajectory', f), to); }
    }
  }
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
  return { result: path.join(outDir, 'result.json'), steps: history.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), flags = {}, pos = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { pos.push(args[i]); continue; }
    const next = args[i + 1];
    flags[args[i].slice(2)] = next === undefined || next.startsWith('--') ? '' : (i++, next);
  }
  try {
    if (!pos[0] || !pos[1]) throw new Error('Usage: node bench/om2w/export.mjs <recording dir> <out dir> --task-id ID --task "..." [--answer "..."]');
    console.log(JSON.stringify(exportOm2w(pos[0], { taskId: flags['task-id'], task: flags.task, answer: flags.answer, root: pos[1] }), null, 2));
  } catch (e) { console.error(e.message); process.exit(1); }
}

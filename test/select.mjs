// npm run test:select: choose the core tier (npm test) by signal per second, and record timings.
// Runs every test file alone with V8 coverage, 8 at a time, merging the coverage of every process
// a file starts (the test, CLI calls, daemons), and the lines of lib/ and bin/ each file runs.
// Then picks files greedily by new covered lines per second until the core covers TARGET of all
// covered lines, skipping files slower than MAX_FILE_S (one file must not hold the whole run).
// Everything else goes in `extended`, which npm run test:full still runs. Writes test/tiers.json.
//   node test/select.mjs [--target 0.86] [--max-file 30] [--from DIR]   (DIR: reuse a coverage run)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const opt = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const TARGET = Number(opt('target', 0.86));
const MAX_FILE_S = Number(opt('max-file', 30));
// Files kept in the core whatever their coverage: they have caught regressions coverage misses.
let PINNED = [];
try { PINNED = JSON.parse(fs.readFileSync(path.join(HERE, 'tiers.json'), 'utf8')).pinned || []; } catch {}

const files = fs.readdirSync(HERE).filter(f => f.endsWith('.test.mjs')).sort();
let dir = opt('from', null);
const timings = {};
if (!dir) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-select-'));
  console.log(`# coverage run of ${files.length} files into ${dir}`);
  let next = 0, failed = [];
  const one = async () => {
    while (next < files.length) {
      const f = files[next++];
      const out = path.join(dir, f.replace('.test.mjs', ''));
      fs.mkdirSync(out, { recursive: true });
      const started = Date.now();
      const code = await new Promise(res => spawn(process.execPath, ['--import', './test/helpers.mjs', '--test', '--test-timeout=300000', path.join('test', f)],
        { cwd: ROOT, stdio: 'ignore', env: { ...process.env, NODE_V8_COVERAGE: out } }).on('exit', res));
      timings[f] = Math.round((Date.now() - started) / 100) / 10;
      if (code) failed.push(f);
      process.stdout.write('.');
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, os.cpus().length) }, one));
  console.log('');
  if (failed.length) { console.error(`failing files, fix them first: ${failed.join(', ')}`); process.exit(1); }
} else {
  // A reused run: timings from its _times.txt ("name ms ...").
  for (const l of fs.readFileSync(path.join(dir, '_times.txt'), 'utf8').trim().split('\n')) {
    const [n, ms] = l.split(/\s+/);
    timings[`${n}.test.mjs`] = Math.round(Number(ms) / 100) / 10;
  }
}

// Covered lines: a line counts when the innermost V8 block range holding its first non-blank
// character ran at least once.
const anchorsCache = new Map();
function anchors(file) {
  if (!anchorsCache.has(file)) {
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch {}
    if (text === null) { anchorsCache.set(file, null); return null; }
    const lines = [], keys = [];
    let pos = 0;
    text.split('\n').forEach((line, i) => {
      const t = line.trim();
      if (t && !t.startsWith('//')) { lines.push(i + 1); keys.push(pos + line.length - line.trimStart().length); }
      pos += line.length + 1;
    });
    anchorsCache.set(file, { lines, keys });
  }
  return anchorsCache.get(file);
}
const lowerBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };
const prefix = `file://${ROOT}/`;
const cov = {};
for (const f of files) {
  const d = path.join(dir, f.replace('.test.mjs', ''));
  const got = new Set();
  for (const j of fs.existsSync(d) ? fs.readdirSync(d).filter(x => x.endsWith('.json')) : []) {
    let data; try { data = JSON.parse(fs.readFileSync(path.join(d, j), 'utf8')); } catch { continue; }
    for (const sc of data.result || []) {
      const url = sc.url || '';
      const at = url.indexOf('/lib/') >= 0 ? url.indexOf('/lib/') : url.indexOf('/bin/');
      if (!url.startsWith('file://') || at < 0) continue;
      const rel = url.slice(at + 1);
      const a = anchors(path.join(ROOT, rel));
      if (!a) continue;
      const state = new Array(a.keys.length).fill(0);
      const ranges = sc.functions.flatMap(fn => fn.ranges).sort((x, y) => (y.endOffset - y.startOffset) - (x.endOffset - x.startOffset));
      for (const r of ranges) for (let k = lowerBound(a.keys, r.startOffset), e = lowerBound(a.keys, r.endOffset); k < e; k++) state[k] = r.count;
      state.forEach((c, k) => { if (c > 0) got.add(`${rel}:${a.lines[k]}`); });
    }
  }
  cov[f] = got;
}
const union = new Set(Object.values(cov).flatMap(s => [...s]));
const core = new Set(PINNED.filter(f => cov[f]));
const have = new Set([...core].flatMap(f => [...cov[f]]));
const pool = files.filter(f => !core.has(f) && (timings[f] ?? 0) <= MAX_FILE_S);
while (have.size / union.size < TARGET) {
  let best = null, score = 0;
  for (const f of pool) {
    if (core.has(f)) continue;
    let gain = 0; for (const l of cov[f]) if (!have.has(l)) gain++;
    const s = gain / Math.max(0.5, timings[f] ?? 1);
    if (s > score) { score = s; best = f; }
  }
  if (!best) break;
  core.add(best); for (const l of cov[best]) have.add(l);
}
const extended = files.filter(f => !core.has(f));
const coreTime = [...core].reduce((s, f) => s + (timings[f] ?? 0), 0);
const result = {
  note: 'Written by test/select.mjs (npm run test:select). npm test runs every file not in `extended`; npm run test:full runs all. `pinned` files stay in the core; edit it by hand.',
  generated: new Date().toISOString().slice(0, 10),
  target: TARGET, coverage: `${(100 * have.size / union.size).toFixed(1)}%`, coveredLines: union.size,
  core: core.size, coreSeconds: Math.round(coreTime), pinned: PINNED, extended, timings,
};
fs.writeFileSync(path.join(HERE, 'tiers.json'), JSON.stringify(result, null, 1) + '\n');
console.log(`core: ${core.size} files, ${result.coverage} of ${union.size} covered lines, ${Math.round(coreTime)} s of test time; extended: ${extended.length} files`);

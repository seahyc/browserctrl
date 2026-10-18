// Size caps for what browserctrl keeps on disk: traces, recordings and captured traffic each
// stay under a total, oldest removed first. BROWSERCTRL_<KIND>_MAX_MB overrides a cap.
import fs from 'node:fs';
import path from 'node:path';

export const CAPS_MB = { trace: 50, rec: 1000, capture: 200 };
export const capBytes = (kind) => (Number(process.env[`BROWSERCTRL_${kind.toUpperCase()}_MAX_MB`]) || CAPS_MB[kind]) * 1024 * 1024;

function sizeOf(p) {
  let st;
  try { st = fs.statSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of fs.readdirSync(p)) n += sizeOf(path.join(p, e));
  return n;
}

// Delete the oldest entries of dir (files or folders, by modification time) until the rest
// fit in maxBytes. Entries named in keep are never removed (the one being written).
export function prune(dir, maxBytes, { keep = [] } = {}) {
  let entries;
  try { entries = fs.readdirSync(dir).map(name => { const p = path.join(dir, name); return { name, p, mtime: fs.statSync(p).mtimeMs, size: sizeOf(p) }; }); }
  catch { return { removed: 0 }; }
  let total = entries.reduce((n, e) => n + e.size, 0), removed = 0;
  for (const e of entries.sort((a, b) => a.mtime - b.mtime)) {
    if (total <= maxBytes) break;
    if (keep.includes(e.name) || keep.includes(e.p)) continue;
    fs.rmSync(e.p, { recursive: true, force: true });
    total -= e.size; removed++;
  }
  return { removed, bytes: total };
}

// Keep the last part of a line log under maxBytes: drop whole lines from the front.
export function trimLog(file, maxBytes) {
  let size;
  try { size = fs.statSync(file).size; } catch { return false; }
  if (size <= maxBytes) return false;
  const text = fs.readFileSync(file, 'utf8');
  const cut = text.indexOf('\n', text.length - Math.floor(maxBytes / 2));
  fs.writeFileSync(file, cut >= 0 ? text.slice(cut + 1) : '');
  return true;
}

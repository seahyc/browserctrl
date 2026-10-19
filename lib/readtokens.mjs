// The snapshot an agent's refs belong to. `read` prints refs and a token; a later `do`,
// `--intent` read takes a new snapshot of the same page, and without the token a
// ref_61 would resolve against that newer one and point at a different element. `read`
// remembers its token per tab here, and ref commands without --token resolve against it.
// Commands whose output shows refs from their own snapshot (`do`, `--intent`) forget it,
// so the refs they print resolve against the latest snapshot as before.
import fs from 'node:fs';
import path from 'node:path';
import { setting } from './config.mjs';
import { STATE_DIR } from './state.mjs';

const FILE = () => setting('READ_TOKENS') || path.join(STATE_DIR, 'read-tokens.json');
const TTL_MS = 2 * 60 * 60 * 1000;

function load() {
  try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')) || {}; } catch { return {}; }
}
function save(all) {
  const now = Date.now();
  for (const [k, v] of Object.entries(all)) if (!v || now - v.at > TTL_MS) delete all[k];
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    const tmp = `${FILE()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all));
    fs.renameSync(tmp, FILE());
  } catch { /* a lost token only means the latest snapshot is used */ }
}
const key = (port, targetId) => `${port}:${targetId}`;

export function remember(port, targetId, token) {
  const all = load();
  all[key(port, targetId)] = { token, at: Date.now() };
  save(all);
}
export function recall(port, targetId) {
  const v = load()[key(port, targetId)];
  return v && Date.now() - v.at <= TTL_MS ? v.token : undefined;
}
export function forget(port, targetId) {
  const all = load();
  if (!all[key(port, targetId)]) return;
  delete all[key(port, targetId)];
  save(all);
}

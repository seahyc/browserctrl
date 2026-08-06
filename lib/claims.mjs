// Tab claims: stop two agents from driving the same tab.
//
// A claim is advisory and short-lived. Any mutating operation auto-claims the
// tab it touches; another agent touching that tab within the TTL is refused by
// name and told how to steal it. Read-only operations never claim.
import fs from 'fs';
import { CLAIMS_FILE, CLAIM_TTL_MS, agentId, agentLabel } from './env.mjs';

function readAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(CLAIMS_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeAll(claims) {
  const tmp = `${CLAIMS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(claims, null, 2));
  fs.renameSync(tmp, CLAIMS_FILE); // atomic on the same filesystem
}

function fresh(claims, now = Date.now()) {
  const out = {};
  for (const [k, v] of Object.entries(claims)) {
    if (v && now - v.ts < CLAIM_TTL_MS) out[k] = v;
  }
  return out;
}

const keyFor = (port, targetId) => `${port}:${targetId}`;

export function list(port = null) {
  const all = fresh(readAll());
  const rows = Object.entries(all).map(([k, v]) => {
    const [p, targetId] = [parseInt(k.split(':')[0], 10), k.slice(k.indexOf(':') + 1)];
    return { port: p, targetId, ...v, ageMs: Date.now() - v.ts };
  });
  return port ? rows.filter(r => r.port === port) : rows;
}

export function get(port, targetId) {
  return fresh(readAll())[keyFor(port, targetId)] ?? null;
}

export function claim(port, targetId, { steal = false } = {}) {
  const me = agentId();
  const claims = fresh(readAll());
  const key = keyFor(port, targetId);
  const held = claims[key];
  if (held && held.owner !== me && !steal) {
    const mins = Math.round((Date.now() - held.ts) / 60000);
    const err = new Error(
      `Tab ${targetId.slice(0, 8)} is claimed by ${held.label} (${held.owner}), last touched ${mins}m ago. ` +
        `Pass --steal to take it, or pick another tab with: cdp tabs --port ${port}`,
    );
    err.code = 'CLAIMED';
    throw err;
  }
  claims[key] = { owner: me, label: agentLabel(), ts: Date.now() };
  writeAll(claims);
  return claims[key];
}

export function release(port, targetId) {
  const claims = fresh(readAll());
  delete claims[keyFor(port, targetId)];
  writeAll(claims);
}

export function releaseMine() {
  const me = agentId();
  const claims = fresh(readAll());
  let n = 0;
  for (const [k, v] of Object.entries(claims)) {
    if (v.owner === me) {
      delete claims[k];
      n += 1;
    }
  }
  writeAll(claims);
  return n;
}

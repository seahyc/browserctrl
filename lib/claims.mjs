// Tab ownership leases. Every update locks the complete read-modify-write operation.
import fs from 'fs';
import { withFileLock } from './file-lock.mjs';
import { CLAIMS_FILE, CLAIM_TTL_MS, agentId, agentLabel } from './env.mjs';

function readAll() {
  let text;
  try {
    text = fs.readFileSync(CLAIMS_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        Object.values(raw).some(v => !v || typeof v.owner !== 'string' ||
          typeof v.label !== 'string' || !Number.isFinite(v.ts))) {
      throw new Error('Invalid claims record');
    }
    return raw;
  } catch (cause) {
    const error = new Error(`Cannot read claims file ${CLAIMS_FILE}: ${cause.message}`);
    error.code = 'INVALID_CLAIMS';
    throw error;
  }
}

function writeAll(claims) {
  const tmp = `${CLAIMS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(claims, null, 2));
  fs.renameSync(tmp, CLAIMS_FILE); // atomic on the same filesystem
}

// An owner like "pid:123" is a shell or harness process. When it is gone nobody can still
// be using the tab, so its claim is released at once instead of blocking the next command
// of an agent whose harness starts a new shell each time.
export function ownerGone(owner) {
  const m = /^pid:(\d+)$/.exec(owner);
  if (!m) return false;
  try { process.kill(Number(m[1]), 0); return false; } catch (error) { return error.code !== 'EPERM'; }
}

function fresh(claims, now = Date.now()) {
  const out = {};
  for (const [k, v] of Object.entries(claims)) {
    if (v && now - v.ts < CLAIM_TTL_MS && !ownerGone(v.owner)) out[k] = v;
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

function checkOwner(held, port, targetId, owner, steal = false) {
  if (held && held.owner !== owner && !steal) {
    const mins = Math.round((Date.now() - held.ts) / 60000);
    const err = new Error(
      `Tab ${targetId.slice(0, 8)} is claimed by ${held.label} (${held.owner}), last touched ${mins}m ago. ` +
        `Pass --steal to take it, or pick another tab with: cdp tabs --port ${port}`,
    );
    err.code = 'CLAIMED';
    throw err;
  }
}

export function assertAccess(port, targetId, { owner = agentId() } = {}) {
  checkOwner(get(port, targetId), port, targetId, owner);
}

export function claim(port, targetId, { steal = false, owner = agentId(), label = agentLabel() } = {}) {
  return withFileLock(`${CLAIMS_FILE}.lock`, () => {
    const claims = fresh(readAll());
    const key = keyFor(port, targetId);
    checkOwner(claims[key], port, targetId, owner, steal);
    claims[key] = { owner, label, ts: Date.now() };
    writeAll(claims);
    return claims[key];
  });
}

export function release(port, targetId, { owner = agentId(), steal = false } = {}) {
  return withFileLock(`${CLAIMS_FILE}.lock`, () => {
    const claims = fresh(readAll());
    const key = keyFor(port, targetId);
    checkOwner(claims[key], port, targetId, owner, steal);
    delete claims[key];
    writeAll(claims);
  });
}

export function releaseMine() {
  return withFileLock(`${CLAIMS_FILE}.lock`, () => {
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
  });
}

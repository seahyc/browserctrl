// Load the pages an agent will probably open next while it is still deciding. When a call
// ends on a list, the first few item links start loading in background tabs; `visit` takes
// a ready tab instead of loading the page again. Tabs nobody takes are closed after TTL_MS
// by a detached reaper, so they never linger. BROWSERCTRL_PREFETCH=0 turns it off.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ops from './ops.mjs';
import * as cooldown from './cooldown.mjs';

export const TTL_MS = 90_000;
const FILE = () => path.join(process.env.BROWSERCTRL_STATE_DIR || path.join(os.homedir(), '.local/share/browserctrl'), 'prefetch.json');
const owner = () => process.env.CDP_AGENT_ID || '';
const norm = (u) => { try { const x = new URL(u); x.hash = ''; return x.href; } catch { return u; } };

function load() { try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return []; } }
function save(rows) { try { fs.mkdirSync(path.dirname(FILE()), { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(rows)); } catch {} }

export const enabled = () => process.env.BROWSERCTRL_PREFETCH !== '0';

// Start loading up to `max` of these URLs (same host as the page, not already loading).
export async function start(conn, urls, { max = 3, staggerMs = 350 } = {}) {
  if (!enabled() || !urls.length) return [];
  const rows = load().filter(r => Date.now() - r.at < TTL_MS);
  const have = new Set(rows.map(r => r.url));
  const started = [];
  for (const u of urls) {
    if (started.length >= max) break;
    const url = norm(u);
    if (have.has(url)) continue;
    try { cooldown.guard(url, { action: 'open' }); } catch { break; } // a site cooling down gets no extra loads
    try {
      const { targetId } = await ops.newTab(conn, url);
      rows.push({ url, targetId, port: conn.port, owner: owner(), at: Date.now() });
      started.push(url);
      if (started.length < max) await new Promise(r => setTimeout(r, staggerMs));
    } catch { break; }
  }
  save(rows);
  if (started.length) reaperFor(started.length ? conn.port : null);
  return started;
}

// A prefetched tab for this URL, handed over (and forgotten) if this agent started it.
export function take(url) {
  const rows = load(), u = norm(url);
  const i = rows.findIndex(r => r.url === u && r.owner === owner() && Date.now() - r.at < TTL_MS);
  if (i < 0) return null;
  const [row] = rows.splice(i, 1);
  save(rows);
  return row.targetId;
}

// Close prefetched tabs older than TTL_MS (all, with { all: true }).
export async function reap(conn, { all = false } = {}) {
  const rows = load(), keep = [];
  for (const r of rows) {
    if (!all && Date.now() - r.at < TTL_MS) { keep.push(r); continue; }
    if (r.port === conn.port) await ops.closeTab(conn, r.targetId).catch(() => {});
    else keep.push(r);
  }
  save(keep);
}

// A detached process that waits out the TTL and closes what was not taken.
function reaperFor(port) {
  if (!port || process.env.BROWSERCTRL_PREFETCH_REAPER === '0') return;
  const me = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [me, 'reap', String(port)], {
    detached: true, stdio: 'ignore', env: { ...process.env, CDP_AGENT_ID: owner() },
  });
  child.unref();
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'reap') {
  const port = Number(process.argv[3]);
  setTimeout(async () => {
    try {
      const { connect } = await import('./daemon.mjs');
      const conn = await connect(port);
      await reap(conn);
      conn.close?.();
    } catch {}
    process.exit(0);
  }, TTL_MS + 2000);
}

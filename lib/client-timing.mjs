// Where one CLI process spends its wall time: startup, reaching the daemon (connect, status
// probes, spawn, upgrade), its IPC requests, and what runs after the command (a recording
// still, exit). For finding waits outside a command's own reported work, such as the bench's
// "harness stalls". Off unless BROWSERCTRL_CLIENT_TIMING is set: a file path appends one JSON
// line per process; `stderr` prints the same line to stderr.
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

// Clients only: the daemon imports the same client code but is not timed here.
const target = /daemon-run\.mjs$/.test(process.argv[1] || '') ? null : process.env.BROWSERCTRL_CLIENT_TIMING;
const now = () => Math.round(performance.now()); // ms since this process started
const row = target ? { pid: process.pid, argv: process.argv.slice(2, 4).join(' '), at: new Date(performance.timeOrigin).toISOString(), marks: {}, daemon: { attempts: 0, statusMs: 0, spawned: false, upgrade: false }, ipc: { count: 0, totalMs: 0, maxMs: 0, max: null } } : null;

export const enabled = Boolean(row);

// A named point in time, the first occurrence wins.
export function mark(name) {
  if (row && row.marks[name] === undefined) row.marks[name] = now();
}

export function daemonProbe(ms, { spawned = false, upgrade = false } = {}) {
  if (!row) return;
  row.daemon.attempts++;
  row.daemon.statusMs += Math.round(ms);
  if (spawned) row.daemon.spawned = true;
  if (upgrade) row.daemon.upgrade = true;
}

// One IPC round trip. prepMs, from the daemon, is the part spent before the browser got
// the method; the remainder is the browser's answer and the IPC itself.
export function ipc(op, method, ms, prepMs) {
  if (!row) return;
  row.ipc.count++;
  row.ipc.totalMs += Math.round(ms);
  if (Number.isFinite(prepMs)) row.ipc.prepMs = (row.ipc.prepMs || 0) + prepMs;
  if (ms > row.ipc.maxMs) {
    row.ipc.maxMs = Math.round(ms); row.ipc.max = method ? `${op} ${method}` : op;
    row.ipc.maxPrepMs = Number.isFinite(prepMs) ? prepMs : null;
  }
}

if (row) {
  process.on('exit', () => {
    row.marks.exit = now();
    const line = JSON.stringify(row) + '\n';
    try { target === 'stderr' ? process.stderr.write(`timing ${line}`) : fs.appendFileSync(target, line); } catch {}
  });
}

// Summarise usage records (see usage-log.mjs) for `browserctrl usage`.
const ACTIONS = new Set(['click', 'fill', 'select', 'check', 'hover', 'key', 'type', 'nav', 'open', 'upload', 'scroll']);
const OBSERVE = new Set(['read', 'text', 'shot', 'find', 'eval', 'items', 'fields', 'html', 'table']);
const WINDOW_S = 120;

function pct(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}
const count = (map, key) => map.set(key, (map.get(key) || 0) + 1);
const obj = map => Object.fromEntries([...map].sort((a, b) => b[1] - a[1]));
const ratio = (a, b) => (b ? a / b : null);
const isoDay = t => new Date(t * 1000).toISOString().slice(0, 10);

export function usageReport(records) {
  const rows = (Array.isArray(records) ? records : []).filter(r => r && typeof r === 'object');
  const report = { calls: rows.length, sessions: 0, range: null, harness: {}, commands: [], chains: null,
    actObserve: { actions: 0, observed: 0, share: null, withChange: 0, withChangeObserved: 0, withChangeShare: null },
    do: null, stops: {}, hosts: [], callsPerSession: { p50: null, p90: null } };
  if (!rows.length) return report;

  const times = rows.map(r => r.t).filter(Number.isFinite);
  if (times.length) report.range = { from: isoDay(Math.min(...times)), to: isoDay(Math.max(...times)) };
  const harness = new Map();
  for (const r of rows) count(harness, r.h || '?');
  report.harness = obj(harness);

  const bySession = new Map();
  for (const r of rows) {
    const key = r.s || '?';
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(r);
  }
  report.sessions = bySession.size;
  const perSession = [...bySession.values()].map(list => list.length);
  report.callsPerSession = { p50: pct(perSession, 0.5), p90: pct(perSession, 0.9) };

  const byCommand = new Map();
  for (const r of rows) {
    const c = r.c || '?';
    if (!byCommand.has(c)) byCommand.set(c, []);
    byCommand.get(c).push(r);
  }
  report.commands = [...byCommand].map(([c, list]) => {
    const bytes = list.map(r => r.o).filter(Number.isFinite);
    return { c, calls: list.length, share: list.length / rows.length,
      p50: pct(list.map(r => r.d).filter(Number.isFinite), 0.5), p90: pct(list.map(r => r.d).filter(Number.isFinite), 0.9),
      failRate: list.filter(r => r.x !== 0).length / list.length,
      meanOut: bytes.length ? bytes.reduce((a, b) => a + b, 0) / bytes.length : null };
  }).sort((a, b) => b.calls - a.calls);

  let chained = 0;
  const act = report.actObserve;
  for (const list of bySession.values()) {
    const ordered = list; // records arrive in time order; ties keep file order
    for (let i = 0; i < ordered.length; i++) {
      const r = ordered[i], prev = ordered[i - 1], next = ordered[i + 1];
      if (prev && r.pp !== undefined && prev.pp === r.pp) chained++;
      if (!ACTIONS.has(r.c)) continue;
      const seen = !!next && OBSERVE.has(next.c) && next.t - r.t <= WINDOW_S && (!r.tab || !next.tab || r.tab === next.tab);
      act.actions++; if (seen) act.observed++;
      if (r.then) act.withThen = (act.withThen || 0) + 1;
      if (r.ch > 0) { act.withChange++; if (seen) act.withChangeObserved++; }
    }
  }
  report.chains = { chained, share: chained / rows.length };
  act.share = ratio(act.observed, act.actions);
  act.withChangeShare = ratio(act.withChangeObserved, act.withChange);

  const doRows = rows.filter(r => r.c === 'do');
  if (doRows.length) {
    const stopped = doRows.filter(r => r.st);
    const codes = new Map(), then = new Map();
    for (const r of stopped) count(codes, r.st);
    for (const r of doRows) if (r.then) count(then, r.then);
    report.do = { calls: doRows.length, stepsP50: pct(doRows.map(r => r.n).filter(Number.isFinite), 0.5),
      stopRate: stopped.length / doRows.length, stopCodes: obj(codes),
      jevP50: pct(doRows.map(r => r.j || 0), 0.5), then: obj(then) };
  }

  const stops = new Map();
  for (const r of rows) if (r.st) count(stops, r.st);
  report.stops = obj(stops);

  const hosts = new Map();
  for (const r of rows) {
    if (!r.host) continue;
    const h = hosts.get(r.host) || { host: r.host, calls: 0, stops: 0 };
    h.calls++; if (r.st) h.stops++;
    hosts.set(r.host, h);
  }
  report.hosts = [...hosts.values()].sort((a, b) => b.calls - a.calls || a.host.localeCompare(b.host)).slice(0, 10)
    .map(h => ({ ...h, stopRate: h.stops / h.calls }));
  return report;
}

const p = v => (v === null || v === undefined ? '-' : `${Math.round(v * 100)}%`);
const n = v => (v === null || v === undefined ? '-' : String(Math.round(v)));

export function formatUsageReport(r) {
  if (!r.calls) return 'No usage recorded yet.';
  const L = [];
  L.push(`Usage ${r.range ? `${r.range.from} to ${r.range.to}` : ''}: ${r.calls} calls, ${r.sessions} sessions`);
  L.push(`Harness: ${Object.entries(r.harness).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  L.push(`Calls per session: p50 ${n(r.callsPerSession.p50)}, p90 ${n(r.callsPerSession.p90)}`);
  L.push(`Chained in one shell command: ${p(r.chains.share)} of calls`);
  L.push('');
  L.push('Command      calls  share   p50ms   p90ms  fail  out-bytes');
  for (const c of r.commands.slice(0, 15)) {
    L.push(`${c.c.padEnd(12)} ${String(c.calls).padStart(5)} ${p(c.share).padStart(6)} ${n(c.p50).padStart(7)} ${n(c.p90).padStart(7)} ${p(c.failRate).padStart(5)} ${n(c.meanOut).padStart(10)}`);
  }
  if (r.commands.length > 15) L.push(`... ${r.commands.length - 15} more commands`);
  L.push('');
  const a = r.actObserve;
  L.push(`Action then observation within ${WINDOW_S}s: ${p(a.share)} of ${a.actions} actions`);
  L.push(`  when the action reported a change: ${p(a.withChangeShare)} of ${a.withChange}`);
  L.push(`  looked in the same call (--then): ${p(ratio(a.withThen || 0, a.actions))} of ${a.actions}`);
  if (r.do) {
    const d = r.do;
    L.push('');
    L.push(`do: ${d.calls} calls, steps/plan p50 ${n(d.stepsP50)}, stopped ${p(d.stopRate)}, Jev calls p50 ${n(d.jevP50)}`);
    const fmt = o => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
    L.push(`  stop codes: ${fmt(d.stopCodes)}`);
    L.push(`  --then: ${fmt(d.then)}`);
  }
  L.push('');
  L.push(`Stops by code (all commands): ${Object.entries(r.stops).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  if (r.hosts.length) {
    L.push('Top hosts (calls, stop rate):');
    for (const h of r.hosts) L.push(`  ${h.host.padEnd(32)} ${String(h.calls).padStart(5)} ${p(h.stopRate).padStart(5)}`);
  }
  return L.join('\n');
}

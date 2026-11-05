import './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = fileURLToPath(new URL('../lib/usage-log.mjs', import.meta.url));
const REPORT = fileURLToPath(new URL('../lib/usage-report.mjs', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-usage-'));
process.env.BROWSERCTRL_USAGE_DIR = dir;
const log = await import('../lib/usage-log.mjs');
const { usageReport, formatUsageReport } = await import('../lib/usage-report.mjs');
const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const ymd = ms => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');

const fresh = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-usage-'));
  process.env.BROWSERCTRL_USAGE_DIR = d;
  log.resetUsage();
  return d;
};
const lines = d => fs.readdirSync(d).filter(n => n.endsWith('.jsonl')).flatMap(n => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean));

test('classifyStop maps each cause and keeps order', () => {
  const cases = {
    jev_unsure: ['Jev is unsure (p=0.4)', 'p=0.55 below the bar, require confirmation'],
    jev_none: ['Jev found no element', 'no element matching "Buy"', 'nothing matches'],
    covered: ['the button is covered by a banner', 'something covers it'],
    overlay: ['a dialog or popup is open', 'overlay present', 'blocking the page'],
    commit: ['this would commit the order'],
    timeout: ['timed out after 30s', 'deadline exceeded'],
    no_key: ['TypeSafe key missing', 'set your API key'],
    expect: ['the page did not show the total', 'not what it expected', 'expect a heading'],
    claim: ['tab claimed by another agent', 'owned by agent 2'],
    other: ['weird', '', undefined, 42],
  };
  for (const [code, msgs] of Object.entries(cases)) for (const m of msgs) assert.equal(log.classifyStop(m), code, String(m));
  assert.equal(log.classifyStop('unsure, would commit'), 'jev_unsure');
  assert.equal(log.classifyStop('covered by a dialog or popup'), 'covered');
});

test('flag values, positional args, URLs and stop text never reach the line', () => {
  const d = fresh();
  log.startUsage({ argv: ['click', 'Place the order now', '--text=hunter2secret', '--tab', 'ABCD1234EF', '-q', '--then', 'items', '--then'], env: { CLAUDECODE: '1', BROWSERCTRL_AGENT_ID: 'agent-xyz' }, now: NOW });
  log.noteUsage({ c: 'click', k: 'name', tab: 'ABCD1234EF99', url: 'https://shop.example.com:8443/cart/secret-path?token=abc123#frag', stop: 'Jev is unsure about "Place the order now" (p=0.40), require confirmation',
    br: 'dia', bogus: 'x', n: 'five', sp: 'a secret step text', then: 'evil', secret: 'leak' });
  process.stdout.write('hello');
  log.finishUsage(0, { now: NOW + 250 });
  const [line] = lines(d);
  for (const leak of ['hunter2secret', 'Place the order', 'secret-path', 'token', 'abc123', '8443', 'frag', 'agent-xyz', 'p=0.40', 'leak', 'evil', 'items']) assert.ok(!line.includes(leak), leak);
  const rec = JSON.parse(line);
  assert.equal(rec.host, 'shop.example.com');
  assert.equal(rec.st, 'jev_unsure');
  assert.equal(rec.tab, 'ABCD1234');
  assert.deepEqual(rec.f, ['q', 'tab', 'text', 'then']);
  assert.equal(rec.c, 'click'); assert.equal(rec.h, 'cc'); assert.equal(rec.d, 250);
  assert.equal(rec.x, 0); assert.match(rec.s, /^[0-9a-f]{10}$/);
  assert.ok(rec.o >= 5);
  assert.equal(rec.n, undefined); assert.equal(rec.sp, undefined); assert.equal(rec.then, undefined);
});

test('non-http hosts are dropped, finish is idempotent, disabled logging writes nothing', () => {
  const d = fresh();
  log.startUsage({ argv: ['--weird', 'Not A Command'], env: {}, now: NOW });
  log.noteUsage({ url: 'file:///etc/passwd' });
  assert.ok(log.finishUsage(1, { now: NOW }));
  assert.equal(log.finishUsage(1, { now: NOW }), null);
  const rec = JSON.parse(lines(d)[0]);
  assert.equal(rec.c, '?'); assert.equal(rec.host, undefined); assert.equal(rec.x, 1);
  const d2 = fresh();
  process.env.BROWSERCTRL_USAGE_LOG = '0';
  try {
    assert.equal(log.startUsage({ argv: ['read'], now: NOW }), null);
    log.noteUsage({ c: 'read' });
    assert.equal(log.finishUsage(0, { now: NOW }), null);
  } finally { delete process.env.BROWSERCTRL_USAGE_LOG; }
  assert.deepEqual(fs.readdirSync(d2), []);
});

test('a realistic do record fits in 200 bytes; the version rides on the first line of a day only', () => {
  const d = fresh();
  const run = extra => {
    log.startUsage({ argv: ['do', '--tab', 'x'], env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's1' }, now: NOW });
    log.noteUsage({ tab: '3F9A0C71D2E4B5A6', url: 'https://www.example.com/a/b', br: 'dia', n: 5, nd: 5, j: 2, ms_settle: 320, ms_jev: 1450, ...extra });
    return log.finishUsage(0, { now: NOW + 4200 });
  };
  const first = run({}), second = run({});
  assert.match(first, /"v":"/); assert.doesNotMatch(second, /"v":/);
  assert.ok(Buffer.byteLength(second) <= 200, `${Buffer.byteLength(second)} bytes: ${second}`);
  // Every optional field present at once stays modest.
  const full = run({ stop: 'covered by banner', sp: '4', then: 'items', ch: 2, un: true });
  assert.ok(Buffer.byteLength(full) <= 260, `${Buffer.byteLength(full)} bytes`);
});

test('two processes appending 200 lines each give 400 valid lines', () => {
  const d = fresh();
  const script = `import(${JSON.stringify(pathToFileURL(LIB).href)}).then(m => { for (let i = 0; i < 200; i++) { m.startUsage({ argv: ['read'], now: ${NOW} }); m.finishUsage(0, { now: ${NOW} }); } });`;
  const env = { ...process.env, BROWSERCTRL_USAGE_DIR: d };
  const { spawn } = awaitableSpawn();
  return Promise.all([spawn(script, env), spawn(script, env)]).then(() => {
    const all = lines(d);
    assert.equal(all.length, 400);
    for (const l of all) assert.equal(JSON.parse(l).c, 'read');
  });
});
function awaitableSpawn() {
  return { spawn: (script, env) => new Promise((resolve, reject) => {
    import('node:child_process').then(({ spawn }) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: 'inherit' });
      c.on('exit', code => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
    });
  }) };
}

const record = (t, extra = {}) => JSON.stringify({ t: Math.floor(t / 1000), d: 10, c: 'read', x: 0, ...extra }) + '\n';

test('compaction gzips only days older than yesterday and readUsage still sees everything', () => {
  const d = fresh();
  fs.writeFileSync(path.join(d, `usage-${ymd(NOW)}.jsonl`), record(NOW));
  fs.writeFileSync(path.join(d, `usage-${ymd(NOW - DAY)}.jsonl`), record(NOW - DAY));
  fs.writeFileSync(path.join(d, `usage-${ymd(NOW - 2 * DAY)}.jsonl`), record(NOW - 2 * DAY));
  fs.writeFileSync(path.join(d, `usage-${ymd(NOW - 3 * DAY)}.jsonl`), record(NOW - 3 * DAY));
  fs.writeFileSync(path.join(d, '.compacted-20200101'), '');
  log.startUsage({ argv: ['read'], now: NOW }); log.finishUsage(0, { now: NOW });
  const names = fs.readdirSync(d).sort();
  assert.ok(names.includes(`usage-${ymd(NOW - 3 * DAY)}.jsonl.gz`));
  assert.ok(names.includes(`usage-${ymd(NOW - 2 * DAY)}.jsonl.gz`));
  assert.ok(!names.includes(`usage-${ymd(NOW - 3 * DAY)}.jsonl`));
  assert.ok(names.includes(`usage-${ymd(NOW - DAY)}.jsonl`));
  assert.ok(names.includes(`usage-${ymd(NOW)}.jsonl`));
  assert.ok(names.includes(`.compacted-${ymd(NOW)}`) && !names.includes('.compacted-20200101'));
  assert.equal(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(d, `usage-${ymd(NOW - 3 * DAY)}.jsonl.gz`))).toString()).c, 'read');
  assert.equal(log.readUsage({ days: 7, dir: d, now: NOW }).length, 5);
  assert.equal(log.readUsage({ days: 2, dir: d, now: NOW }).length, 3); // today (two records) and yesterday
});

test('retention removes oldest first and never touches other files', () => {
  const d = fresh();
  process.env.BROWSERCTRL_USAGE_MAX_MB = '0.001';
  try {
    const big = record(NOW, { pad: randomBytes(900).toString('hex') });
    for (const age of [5, 4, 3]) fs.writeFileSync(path.join(d, `usage-${ymd(NOW - age * DAY)}.jsonl`), big);
    fs.writeFileSync(path.join(d, 'notes.txt'), 'x'.repeat(5000));
    fs.writeFileSync(path.join(d, 'usage-2020.jsonl'), 'keep');
    log.startUsage({ argv: ['read'], now: NOW }); log.finishUsage(0, { now: NOW });
    const names = fs.readdirSync(d);
    assert.ok(names.includes('notes.txt') && names.includes('usage-2020.jsonl'));
    assert.ok(names.includes(`usage-${ymd(NOW)}.jsonl`));
    assert.ok(!names.some(n => n.startsWith(`usage-${ymd(NOW - 5 * DAY)}`)));
    if (names.some(n => n.startsWith(`usage-${ymd(NOW - 4 * DAY)}`))) assert.ok(names.some(n => n.startsWith(`usage-${ymd(NOW - 3 * DAY)}`)), 'newer days outlive older ones');
    const kept = names.filter(n => /^usage-\d{8}\.jsonl(\.gz)?$/.test(n));
    const total = kept.reduce((s, n) => s + fs.statSync(path.join(d, n)).size, 0);
    assert.ok(total <= 0.001 * 1024 * 1024 || kept.length === 1, `${total} bytes in ${kept}`);
  } finally { delete process.env.BROWSERCTRL_USAGE_MAX_MB; }
  const d2 = fresh();
  process.env.BROWSERCTRL_USAGE_DAYS = '10';
  try {
    fs.writeFileSync(path.join(d2, `usage-${ymd(NOW - 20 * DAY)}.jsonl.gz`), zlib.gzipSync(record(NOW)));
    fs.writeFileSync(path.join(d2, `usage-${ymd(NOW - 5 * DAY)}.jsonl.gz`), zlib.gzipSync(record(NOW)));
    log.startUsage({ argv: ['read'], now: NOW }); log.finishUsage(0, { now: NOW });
    assert.ok(!fs.existsSync(path.join(d2, `usage-${ymd(NOW - 20 * DAY)}.jsonl.gz`)));
    assert.ok(fs.existsSync(path.join(d2, `usage-${ymd(NOW - 5 * DAY)}.jsonl.gz`)));
  } finally { delete process.env.BROWSERCTRL_USAGE_DAYS; }
});

test('a symlinked usage directory is refused and corrupt lines are skipped', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-usage-target-'));
  const link = path.join(os.tmpdir(), `bc-usage-link-${process.pid}`);
  fs.symlinkSync(target, link);
  process.env.BROWSERCTRL_USAGE_DIR = link; log.resetUsage();
  log.startUsage({ argv: ['read'], now: NOW });
  assert.equal(log.finishUsage(0, { now: NOW }), null);
  assert.deepEqual(fs.readdirSync(target), []);
  fs.unlinkSync(link);
  const d = fresh();
  fs.writeFileSync(path.join(d, `usage-${ymd(NOW)}.jsonl`), record(NOW) + 'not json\n{"t":\n' + record(NOW));
  assert.equal(log.readUsage({ dir: d, now: NOW }).length, 2);
});

test('stdout and stderr behave as before while being counted', () => {
  const script = `import(${JSON.stringify(pathToFileURL(LIB).href)}).then(m => { m.startUsage({ argv: ['read'] }); process.stdout.write('abc'); process.stderr.write('é\\n'); m.finishUsage(3); });`;
  const d = fresh();
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, BROWSERCTRL_USAGE_DIR: d }, encoding: 'utf8' });
  assert.equal(r.stdout, 'abc'); assert.equal(r.stderr, 'é\n');
  const rec = JSON.parse(lines(d)[0]);
  assert.equal(rec.o, 3); assert.equal(rec.e, 3); assert.equal(rec.x, 3);
});

test('report computes chains, act-then-observe, do stops and hosts', () => {
  const T = 1_700_000_000;
  const rec = (t, c, pp, extra = {}) => ({ t, d: 100, c, x: 0, s: 'aaaa', pp, o: 100, ...extra });
  const report = usageReport([
    rec(T, 'click', 1, { tab: 'AAAA', ch: 2, host: 'a.com' }),
    rec(T + 1, 'read', 1, { tab: 'AAAA', host: 'a.com' }),
    rec(T + 10, 'click', 2, { tab: 'AAAA', host: 'a.com' }),
    rec(T + 500, 'read', 3, { tab: 'AAAA' }),
    rec(T + 600, 'fill', 4, { tab: 'AAAA', ch: 1 }),
    rec(T + 601, 'read', 5, { tab: 'BBBB' }),
    rec(T + 700, 'do', 6, { n: 5, nd: 2, j: 1, st: 'covered', host: 'b.com', then: 'items', x: 1 }),
    rec(T + 800, 'do', 7, { n: 3, nd: 3, j: 0, host: 'b.com' }),
    { t: T, d: 5, c: 'read', x: 0, s: 'bbbb', pp: 9 },
  ]);
  assert.equal(report.calls, 9); assert.equal(report.sessions, 2);
  assert.equal(report.chains.chained, 1);
  assert.equal(report.actObserve.actions, 3);
  assert.equal(report.actObserve.observed, 1);
  assert.equal(report.actObserve.withChange, 2);
  assert.equal(report.actObserve.withChangeObserved, 1);
  assert.equal(report.do.calls, 2); assert.equal(report.do.stopRate, 0.5);
  assert.deepEqual(report.do.stopCodes, { covered: 1 });
  assert.deepEqual(report.do.then, { items: 1 });
  assert.equal(report.hosts[0].host, 'a.com');
  assert.equal(report.hosts.find(h => h.host === 'b.com').stopRate, 0.5);
  const text = formatUsageReport(report);
  assert.ok(text.split('\n').length < 60);
  assert.equal(formatUsageReport(usageReport([])), 'No usage recorded yet.');
});

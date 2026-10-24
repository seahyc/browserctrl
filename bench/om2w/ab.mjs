#!/usr/bin/env node
// A/B runs of browserctrl versions on om2w tasks. See "Quick A/B" in bench/om2w/README.md.
//
//   node bench/om2w/ab.mjs run --arms <ref> <ref> [...] [--tasks quick] [--repeats 3] [--gate 30]
//                              [--group <id>] [--judge] [--keep-worktrees] [--keep-profile] [--dry-run]
//   node bench/om2w/ab.mjs run --arms <ref> <ref> --quick   the 6 fastest quick.json tasks, 2 repeats
//   --tasks takes a set name (quick), a .json or .txt file, or comma-separated id prefixes,
//   so a subset is e.g. --tasks 99daaed9,512fd4de
//   node bench/om2w/ab.mjs run --group <id>           resume a group with its saved settings
//   node bench/om2w/ab.mjs judge --group <id> [--parallel 3]   quick-judge its runs afterwards
//   node bench/om2w/ab.mjs status --group <id>
//
// An arm is a commit (any ref; label=ref names it, so `--arms dev dev` is an A/A check). Each
// commit gets a detached worktree at .worktrees/bench-<sha>, removed when the group is done.
// The harness (this checkout's run.mjs and its prompt) is the same for every arm; each arm
// brings its own CLI, SKILL.md and BROWSERCTRL_HOME. Runs go round-robin: repeat by repeat,
// task by task, arm order rotated per task and repeat. Each run waits for the 1-minute load
// to drop under the gate, starts on a freshly wiped Chrome profile, and is retried once only
// when the harness failed (Codex or the browser never got going), never when the agent did.
// Everything lands in ~/.local/share/browserctrl-bench/results/: <group>.jsonl (one row per
// attempt), <group>.meta.json, and <group>/ (run folders, log); per-arm homes in ../homes/.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const checkout = path.resolve(here, '../..');
const RESULTS = path.join(os.homedir(), '.local/share/browserctrl-bench/results');
const PORT = process.env.OM2W_PORT || '9240';
const LAUNCH = path.join(here, 'launch-chrome.sh');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const mainRoot = path.dirname(path.resolve(checkout, git('rev-parse', '--git-common-dir')));
const load1 = () => os.loadavg()[0];
const stamp = () => new Date().toISOString().slice(11, 19);

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, dflt) => { const i = rest.indexOf(name); return i < 0 ? dflt : rest[i + 1]; };
const has = (name) => rest.includes(name);
const listFlag = (name) => { const i = rest.indexOf(name); if (i < 0) return null; const out = []; for (let j = i + 1; j < rest.length && !rest[j].startsWith('--'); j++) out.push(rest[j]); return out; };

const tasksFile = [process.env.OM2W_TASKS, path.join(here, 'tasks.json'), path.join(mainRoot, 'bench/om2w/tasks.json')].find((f) => f && fs.existsSync(f));

// Task set: quick (bench/om2w/<name>.json), a JSON file with tasks[].task_id, a text file of
// ids, or comma-separated id prefixes. Final and held-out tasks are refused.
function resolveTasks(spec) {
  const all = JSON.parse(fs.readFileSync(tasksFile, 'utf8')).map((t) => t.task_id);
  let ids;
  const named = path.join(here, `${spec}.json`);
  const file = fs.existsSync(named) ? named : fs.existsSync(spec) ? spec : null;
  if (file && file.endsWith('.json')) ids = JSON.parse(fs.readFileSync(file, 'utf8')).tasks.map((t) => t.task_id || t);
  else if (file) ids = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  else ids = spec.split(',');
  ids = ids.map((p) => { const m = all.filter((t) => t.startsWith(p)); if (m.length !== 1) throw new Error(`task ${p}: ${m.length} matches`); return m[0]; });
  const splits = JSON.parse(fs.readFileSync(path.join(here, 'splits.json'), 'utf8'));
  const held = new Set([...splits.final.tasks, ...(splits['heldout-2']?.tasks || []),
    ...fs.readFileSync(path.join(here, 'heldout.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))]);
  const bad = ids.filter((t) => held.has(t));
  if (bad.length && !has('--allow-heldout')) throw new Error(`final/held-out tasks are not for A/Bs: ${bad.join(' ')}`);
  return ids;
}

function resolveArms(specs) {
  const arms = specs.map((s) => {
    const [label, ref] = s.includes('=') ? s.split('=') : [null, s];
    const sha = git('rev-parse', '--verify', `${ref}^{commit}`);
    return { label, ref, sha };
  });
  // Unnamed arms are named by short sha; a repeated commit gets a/b suffixes (A/A checks).
  const counts = {};
  for (const a of arms) if (!a.label) counts[a.sha] = (counts[a.sha] || 0) + 1;
  const seen = {};
  for (const a of arms) if (!a.label) { const n = (seen[a.sha] = (seen[a.sha] || 0) + 1); a.label = a.sha.slice(0, 7) + (counts[a.sha] > 1 ? '-' + 'abcdefgh'[n - 1] : ''); }
  if (new Set(arms.map((a) => a.label)).size !== arms.length) throw new Error('arm labels must differ');
  return arms;
}

const worktreeOf = (sha) => path.join(mainRoot, '.worktrees', `bench-${sha.slice(0, 7)}`);
function ensureWorktree(sha, meta) {
  const dir = worktreeOf(sha);
  if (!fs.existsSync(dir)) {
    git('worktree', 'add', '--detach', dir, sha);
    meta.created_worktrees = [...new Set([...(meta.created_worktrees || []), dir])];
  }
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== sha) throw new Error(`${dir} is at ${head.slice(0, 7)}, not ${sha.slice(0, 7)}; remove it or pick another commit`);
  const nm = path.join(dir, 'node_modules');
  if (!fs.existsSync(nm) && fs.existsSync(path.join(mainRoot, 'node_modules'))) fs.symlinkSync(path.join(mainRoot, 'node_modules'), nm);
  return dir;
}

const groupFile = (g) => path.join(RESULTS, `${g}.jsonl`);
const metaFile = (g) => path.join(RESULTS, `${g}.meta.json`);
const groupDir = (g) => path.join(RESULTS, g);
const readRows = (g) => fs.existsSync(groupFile(g)) ? fs.readFileSync(groupFile(g), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const appendRow = (g, row) => fs.appendFileSync(groupFile(g), JSON.stringify(row) + '\n');
const saveMeta = ({ run_gate, ...meta }) => fs.writeFileSync(metaFile(meta.group), JSON.stringify(meta, null, 2) + '\n');

// Arm order rotates with the task and the repeat, so no arm always goes first.
function schedule(meta) {
  const jobs = [];
  const n = meta.arms.length;
  for (let r = 1; r <= meta.repeats; r++) {
    meta.tasks.forEach((task, i) => {
      for (let k = 0; k < n; k++) jobs.push({ repeat: r, task, arm: meta.arms[(i + r - 1 + k) % n].label });
    });
  }
  return jobs;
}
// A (arm, task, repeat) is done when it has a row that is not a harness error, or two harness errors.
function doneSet(rows) {
  const done = new Set(), errs = {};
  for (const r of rows) {
    const k = `${r.arm}\t${r.task_id}\t${r.repeat}`;
    if (r.status !== 'harness_error') done.add(k);
    else if ((errs[k] = (errs[k] || 0) + 1) >= 2) done.add(k);
  }
  return { done, errs };
}

function log(meta, line) {
  const l = `${stamp()} ${line}`;
  console.error(l);
  fs.appendFileSync(path.join(groupDir(meta.group), 'log.txt'), l + '\n');
}

async function waitForQuiet(meta) {
  let last = 0;
  while (load1() >= meta.run_gate) {
    if (Date.now() - last > 60_000) { log(meta, `waiting: load ${load1().toFixed(1)} >= gate ${meta.run_gate}`); last = Date.now(); }
    await sleep(15_000);
  }
}

// Codex's rollout for a run (its thread id is in the first event), for turns and stalls later.
function rolloutOf(runDir) {
  try {
    const m = fs.readFileSync(path.join(runDir, 'agent-events.jsonl'), 'utf8').match(/"thread_id":"([^"]+)"/);
    if (!m) return null;
    const sessions = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
    for (let d = 0; d < 3; d++) {
      const day = new Date(Date.now() - d * 864e5);
      const dir = path.join(sessions, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
      const f = fs.existsSync(dir) && fs.readdirSync(dir).find((x) => x.endsWith(`${m[1]}.jsonl`));
      if (f) return path.join(dir, f);
    }
  } catch {}
  return null;
}

// Harness error: no run folder or agent record, Codex exited non-zero without timing out, or
// its event stream reports a failed turn or no completed one (API, network, auth). Error
// events alone don't count: Codex reports reconnects that it then recovers from. A timeout, a wrong
// answer or a give-up is the agent's result and stands.
function classify(runDir, exitCode) {
  const runJson = runDir && path.join(runDir, 'run.json');
  if (!runJson || !fs.existsSync(runJson)) return { status: 'harness_error', why: `no run folder (run.mjs exit ${exitCode})` };
  const run = JSON.parse(fs.readFileSync(runJson, 'utf8'));
  if (!run.agent) return { status: 'harness_error', why: `agent never finished (run.mjs exit ${exitCode})`, run };
  if (run.agent.exit !== 0 && !run.agent.timed_out) return { status: 'harness_error', why: `codex exit ${run.agent.exit}`, run };
  const events = fs.existsSync(path.join(runDir, 'agent-events.jsonl')) ? fs.readFileSync(path.join(runDir, 'agent-events.jsonl'), 'utf8') : '';
  if (/"type":"turn\.failed"/.test(events)) return { status: 'harness_error', why: 'codex reported a failed turn', run };
  if (!/"type":"turn\.completed"/.test(events) && !run.agent.timed_out) return { status: 'harness_error', why: 'codex completed no turn', run };
  if (exitCode !== 0) return { status: 'harness_error', why: `run.mjs exit ${exitCode} after the agent ran`, run };
  return { status: run.agent.timed_out ? 'timeout' : 'ok', run };
}

// Each arm's BROWSERCTRL_HOME. Short on purpose: the daemon's socket lives inside it, and a
// Unix socket path over 104 bytes fails to connect (EINVAL).
const armHome = (meta, arm) => path.join(os.homedir(), '.local/share/browserctrl-bench/homes',
  createHash('sha256').update(`${meta.group}\t${arm.label}`).digest('hex').slice(0, 10));

function armEnv(meta, arm) {
  const env = { ...process.env };
  for (const k of ['BROWSERCTRL_AGENT_ID', 'BROWSERCTRL_BROWSER', 'BROWSERCTRL_PORT', 'BROWSERCTRL_HOME', 'CDP_AGENT_ID']) delete env[k];
  const jev = path.join(os.homedir(), '.config/browserctrl/jev.env');
  if (!env.BROWSERCTRL_JEV_ENV && fs.existsSync(jev)) env.BROWSERCTRL_JEV_ENV = jev;
  // browserctrl needs Node 22+: put the one running this first, then Homebrew's tools.
  env.PATH = [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/sbin', env.PATH].join(path.delimiter);
  Object.assign(env, {
    OM2W_PORT: PORT, OM2W_LAUNCH: LAUNCH, OM2W_TASKS: tasksFile,
    OM2W_BROWSERCTRL: worktreeOf(arm.sha), OM2W_BC_HOME: armHome(meta, arm),
    OM2W_VARIANT: `${meta.group}:${arm.label}`,
    OM2W_RUNS_DIR: path.join(groupDir(meta.group), 'runs'), OM2W_RESULTS: path.join(groupDir(meta.group), 'run-rows.jsonl'),
  });
  return env;
}

function sh(file, args, env, logFile) {
  return new Promise((resolve) => {
    const fd = fs.openSync(logFile, 'a');
    const p = spawn(file, args, { cwd: checkout, env, stdio: ['ignore', fd, fd] });
    p.on('close', (code) => { fs.closeSync(fd); resolve(code ?? 1); });
  });
}

async function stopDaemon(meta, arm) {
  const env = armEnv(meta, arm);
  env.BROWSERCTRL_HOME = env.OM2W_BC_HOME;
  await sh(process.execPath, [path.join(worktreeOf(arm.sha), 'bin/browserctrl.mjs'), 'stop', '--port', PORT], env, path.join(groupDir(meta.group), 'log.txt'));
}

async function runJob(meta, job, attempt) {
  const arm = meta.arms.find((a) => a.label === job.arm);
  const env = armEnv(meta, arm);
  const logFile = path.join(groupDir(meta.group), 'log.txt');
  const runsDir = env.OM2W_RUNS_DIR;
  fs.mkdirSync(runsDir, { recursive: true });
  await waitForQuiet(meta);
  // Same start for every run: a fresh Chrome profile (no cookies, cache, consent or history).
  const launched = await sh(LAUNCH, meta.keep_profile ? [] : ['--fresh'], env, logFile);
  if (launched !== 0) {
    const row = { group: meta.group, arm: arm.label, commit: arm.sha, task_id: job.task, repeat: job.repeat, attempt, status: 'harness_error', why: `launch-chrome.sh exit ${launched}`, at: new Date().toISOString() };
    appendRow(meta.group, row);
    log(meta, `end   r${job.repeat} ${job.task.slice(0, 8)} ${arm.label} harness_error (${row.why})`);
    return row;
  }
  const before = new Set(fs.readdirSync(runsDir));
  const startLoad = load1();
  log(meta, `start r${job.repeat} ${job.task.slice(0, 8)} ${arm.label} try ${attempt} load ${startLoad.toFixed(1)}`);
  const t0 = Date.now();
  const code = await sh(process.execPath, [path.join(here, 'run.mjs'), 'run', job.task, '--arm', 'D', '--notes', 'off', ...(meta.judge ? [] : ['--no-judge'])], env, logFile);
  await stopDaemon(meta, arm);
  const fresh = fs.readdirSync(runsDir).filter((d) => !before.has(d) && d.startsWith(job.task.slice(0, 8)));
  const runDir = fresh.length ? path.join(runsDir, fresh.sort().at(-1)) : null;
  const c = classify(runDir, code);
  const run = c.run;
  const row = {
    group: meta.group, arm: arm.label, commit: arm.sha, task_id: job.task, repeat: job.repeat, attempt, status: c.status, why: c.why || null,
    start_load: Math.round(startLoad * 10) / 10, gate: meta.run_gate, at: new Date(t0).toISOString(), harness_s: Math.round((Date.now() - t0) / 1000),
    run: run?.runId || null, run_dir: runDir, rollout: runDir ? rolloutOf(runDir) : null,
    seconds: run?.agent ? Math.round(run.agent.ms / 1000) : null, timed_out: run?.agent?.timed_out ?? null,
    tool_calls: run?.agent?.tools ?? null, tokens: run?.agent?.tokens ?? null, output_tokens: run?.agent?.output_tokens ?? null,
    answer: run?.answer?.answer ?? null, success: run?.judge?.success ?? null,
  };
  appendRow(meta.group, row);
  log(meta, `end   r${job.repeat} ${job.task.slice(0, 8)} ${arm.label} ${c.status}${c.why ? ` (${c.why})` : ''} agent ${row.seconds ?? '-'} s, ${row.tool_calls ?? '-'} tool calls`);
  return row;
}

function removeWorktrees(meta) {
  for (const dir of meta.created_worktrees || []) {
    if (!fs.existsSync(dir)) continue;
    try { fs.unlinkSync(path.join(dir, 'node_modules')); } catch {}
    try { git('worktree', 'remove', '--force', dir); log(meta, `removed worktree ${dir}`); } catch (e) { log(meta, `could not remove ${dir}: ${String(e.stderr || e).trim()}`); }
  }
  meta.created_worktrees = [];
  saveMeta(meta);
}

async function run() {
  fs.mkdirSync(RESULTS, { recursive: true });
  let meta;
  const group = flag('--group');
  if (group && fs.existsSync(metaFile(group))) {
    meta = JSON.parse(fs.readFileSync(metaFile(group), 'utf8'));
    if (listFlag('--arms') || flag('--tasks') || flag('--repeats') || has('--quick')) throw new Error(`group ${group} exists; resume it without --arms/--tasks/--repeats`);
  } else {
    const arms = resolveArms(listFlag('--arms') || []);
    if (arms.length < 2) throw new Error('--arms needs two or more commits');
    // --quick: the 6 tasks with the shortest past median in quick.json, 2 repeats (about 40 min).
    const quickSix = () => JSON.parse(fs.readFileSync(path.join(here, 'quick.json'), 'utf8')).tasks
      .sort((x, y) => x.past_median_s - y.past_median_s).slice(0, 6).map((t) => t.task_id).join(',');
    const taskSpec = flag('--tasks') || (has('--quick') ? quickSix() : 'quick');
    const tasks = resolveTasks(taskSpec);
    const id = group || `ab-${new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}-${arms.map((a) => a.label).join('-vs-')}`;
    meta = {
      group: id, created: new Date().toISOString(), arms, tasks, task_set: has('--quick') && !flag('--tasks') ? 'quick-6' : taskSpec, repeats: Number(flag('--repeats', has('--quick') ? 2 : 3)),
      gate: Number(flag('--gate', 30)), judge: has('--judge'), keep_profile: has('--keep-profile'), port: PORT,
      harness: { checkout, commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--', 'bench/om2w').length > 0 },
      model: process.env.OM2W_MODEL || 'gpt-6.1-sol', effort: process.env.OM2W_EFFORT || 'low', host: { cpus: os.cpus().length },
    };
  }
  // A --gate given on resume applies to this session only; the group's gate stays what
  // compare.py flags against, and each row records the gate it waited for.
  meta.run_gate = flag('--gate') ? Number(flag('--gate')) : meta.gate;
  if (has('--dry-run')) {
    console.log(`${meta.group}: ${meta.arms.map((a) => `${a.label}=${a.sha.slice(0, 7)}`).join(' ')}, ${meta.tasks.length} tasks x ${meta.repeats} repeats, gate ${meta.run_gate}`);
    for (const j of schedule(meta)) console.log(`r${j.repeat} ${j.task.slice(0, 8)} ${j.arm}`);
    return;
  }
  fs.mkdirSync(groupDir(meta.group), { recursive: true });
  if (!tasksFile) throw new Error('tasks.json not found (set OM2W_TASKS)');
  for (const a of meta.arms) ensureWorktree(a.sha, meta);
  saveMeta(meta);
  const jobs = schedule(meta);
  log(meta, `group ${meta.group}: ${meta.arms.map((a) => `${a.label}=${a.sha.slice(0, 7)}`).join(' ')}, ${meta.tasks.length} tasks x ${meta.repeats} repeats, gate ${meta.run_gate}`);
  for (const job of jobs) {
    const { done, errs } = doneSet(readRows(meta.group));
    const k = `${job.arm}\t${job.task}\t${job.repeat}`;
    if (done.has(k)) continue;
    let attempt = (errs[k] || 0) + 1;
    let row = await runJob(meta, job, attempt);
    if (row.status === 'harness_error' && attempt < 2) {
      await sleep(30_000);
      row = await runJob(meta, job, ++attempt);
    }
  }
  if (!meta.keep_profile) await sh(LAUNCH, ['stop'], armEnv(meta, meta.arms[0]), path.join(groupDir(meta.group), 'log.txt'));
  const { done } = doneSet(readRows(meta.group));
  if (jobs.every((j) => done.has(`${j.arm}\t${j.task}\t${j.repeat}`)) && !has('--keep-worktrees')) removeWorktrees(meta);
  log(meta, `done; compare with: python3 -I bench/om2w/compare.py --group ${meta.group}`);
}

// Quick judge for every final run of a group, a few at a time (no browser needed).
async function judgeGroup() {
  const g = flag('--group');
  const meta = JSON.parse(fs.readFileSync(metaFile(g), 'utf8'));
  const rows = readRows(g).filter((r) => r.status !== 'harness_error' && r.run && r.success == null);
  const n = Number(flag('--parallel', 3));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, rows.length) }, async () => {
    while (next < rows.length) {
      const r = rows[next++];
      const arm = meta.arms.find((a) => a.label === r.arm);
      await sh(process.execPath, [path.join(here, 'run.mjs'), 'judge', r.run], armEnv(meta, arm), path.join(groupDir(g), 'judge-log.txt'));
      const run = JSON.parse(fs.readFileSync(path.join(r.run_dir, 'run.json'), 'utf8'));
      appendRow(g, { ...r, success: run.judge?.success ?? null, judged_at: new Date().toISOString() });
      console.error(`${r.arm} ${r.task_id.slice(0, 8)} r${r.repeat}: ${run.judge?.success ? 'success' : 'failure'}`);
    }
  }));
}

function status() {
  const g = flag('--group');
  const meta = JSON.parse(fs.readFileSync(metaFile(g), 'utf8'));
  const rows = readRows(g);
  const { done } = doneSet(rows);
  const jobs = schedule(meta);
  const left = jobs.filter((j) => !done.has(`${j.arm}\t${j.task}\t${j.repeat}`));
  console.log(`${g}: ${jobs.length - left.length}/${jobs.length} done, ${rows.filter((r) => r.status === 'harness_error').length} harness errors, worktrees kept: ${(meta.created_worktrees || []).length}`);
}

if (cmd === 'run') await run();
else if (cmd === 'judge') await judgeGroup();
else if (cmd === 'status') status();
else { console.error('usage: ab.mjs run|judge|status (see the header)'); process.exit(1); }

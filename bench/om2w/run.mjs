#!/usr/bin/env node
// Online-Mind2Web runs for the browserctrl bench. See bench/om2w/README.md.
//
// Agents run on Codex (gpt-6.1-sol, low reasoning) in a separate, US-routed Chrome on
// CDP port 9230; every run is recorded and graded by a port of the benchmark's own
// WebJudge whose model calls also go through Codex.
//
//   node bench/om2w/run.mjs run <task_id> --arm <name> [--notes reflect|off] [--no-judge]
//   node bench/om2w/run.mjs start <task_id> --arm <name> [--notes reflect|off]   prepare, print the prompt
//   node bench/om2w/run.mjs agent <run>        run Codex on a started run
//   node bench/om2w/run.mjs finish <run>       stop recording, export for the judge, append the result row
//   node bench/om2w/run.mjs judge <run>        WebJudge (re-runnable; updates the row)
//   node bench/om2w/run.mjs batch <file> [--parallel N]   lines of "<task_id> <arm> [reflect|off]"
//   OM2W_JUDGE=quick (default: one call, last stills) or full (the WebJudge port)
//   node bench/om2w/run.mjs clean <url>      drop a site's cookies and storage in the bench browser (runs do this first)
//   node bench/om2w/run.mjs report
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runsDir = path.join(here, 'runs');
const resultsFile = path.join(here, 'results.jsonl');
const PORT = process.env.OM2W_PORT || '9230';
const MODEL = process.env.OM2W_MODEL || 'gpt-6.1-sol';
const EFFORT = process.env.OM2W_EFFORT || 'low';
const AGENT_TIMEOUT_MS = 15 * 60 * 1000;
const SCORE_THRESHOLD = 3; // WebJudge's default: stills scored 3+ go to the final judgment
const MAX_IMAGE = 50;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tasks = () => JSON.parse(fs.readFileSync(path.join(here, 'tasks.json'), 'utf8'));
const findTask = (id) => {
  const m = tasks().filter((t) => t.task_id === id || t.task_id.startsWith(id));
  if (m.length !== 1) throw new Error(`task ${id}: ${m.length} matches`);
  return m[0];
};
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const bc = (...args) => sh('browserctrl', [...args, '--port', PORT]);
const bcJson = (...args) => JSON.parse(bc(...args));
const runPath = (runId, ...p) => path.join(runsDir, runId, ...p);
const readRun = (runId) => JSON.parse(fs.readFileSync(runPath(runId, 'run.json'), 'utf8'));
const writeRun = (run) => fs.writeFileSync(runPath(run.runId, 'run.json'), JSON.stringify(run, null, 2));
const tabList = () => bcJson('tabs', '--json').map((t) => ({ id: (t.targetId || t.id).slice(0, 8), url: t.url || '' }));
const tabIds = () => tabList().map((t) => t.id);
// Registrable-ish site: last two labels, three under a country code's generic second level
// (gov.uk, co.jp, com.sg).
const SECOND_LEVEL = new Set(['co', 'com', 'gov', 'ac', 'org', 'net', 'edu']);
const siteKey = (url) => { try { const h = new URL(url).hostname.split('.'); return h.slice(h.at(-1).length === 2 && SECOND_LEVEL.has(h.at(-2)) && h.length > 2 ? -3 : -2).join('.'); } catch { return ''; } };

async function readyTab(url) {
  const { id } = bcJson('open', url);
  for (let i = 0; i < 30; i++) {
    if (i === 1) try { bc('wake', id); } catch {}
    await sleep(1000);
    try { if (Number(bc('eval', id, 'document.readyState === "complete" ? document.body.innerText.length : 0')) > 200) break; } catch {}
  }
  await sleep(1000);
  return id;
}

// Flow-note arms, as in bench/run.mjs: each arm keeps its own store, and the agent puts
// the arm's settings in front of every browserctrl command it runs.
const NOTE_ARMS = ['reflect', 'off'];
function notesEnv(notesArm) {
  if (!notesArm) return null;
  const dir = path.join(runsDir, `notes-${notesArm}`);
  return notesArm === 'reflect' ? { BROWSERCTRL_NOTES: 'on', BROWSERCTRL_NOTES_DIR: dir } : { BROWSERCTRL_NOTES: 'quiet', BROWSERCTRL_NOTES_DIR: dir };
}
function notesPrompt(notesArm, env) {
  if (!notesArm) return '';
  if (notesArm === 'off') return '';
  return `

Before planning, look the site up: browserctrl site <site or start URL>. It lists the site's recipes and its flow notes (facts earlier runs wrote about how the site works, with ids). Use the notes to pick your plan (recipes are off limits in this benchmark). open, nav, read and do also print the top ones as "hint:" lines.
When you have your answer, and before your final message, reflect: what would have saved you the most time on this site? Add up to 3 one-line facts about how the site works that would help a different task on it, never the answer or this task's values:
  browserctrl notes add <site or page URL> "<fact>"
If you saw where a page's data comes from (an API endpoint), add it with --api: notes add <site> --api "<data> comes from <endpoint>".
If the lesson is how to reach a control hidden behind another, write it so do runs it next time: notes add <site> --reveal "<the hidden control>" '<do step>'... "<fact>" (e.g. --reveal "Pets" 'click "Guests"'). If it is how to clear a recurring interruption: notes add <site> --on "<the situation>" '<do step>'... "<fact>" (e.g. --on "a cookie banner covers the page" 'click "Accept"'). Their steps only click, select, hover, press keys, scroll or wait.
Confirm each note you relied on that held (notes confirm <id>) and drop each one that was wrong (notes drop <id> --why "<what was wrong>").
Add "notes_added": <number of notes you added> to your JSON.`;
}

// D: do plans with Jev grounding (the default). A: plain browserctrl, the baseline the
// README's side-by-side compares against: read the page, act by ref, one action per call.
function methodText(arm, tab) {
  // native: Codex's own browser tool on the same browser (through the ChatGPT extension), the
  // baseline the README compares browserctrl against.
  if (arm === 'native') return 'Method: see and operate the page with your built-in browser tool (cua).';
  if (arm === 'A') return `Method: drive the page yourself with plain browserctrl (skill: ~/.agents/skills/browserctrl/SKILL.md): read the page with \`browserctrl read ${tab}\` (or text/items), then act by ref, one action per call, e.g. \`browserctrl click ${tab} --ref ref_12\`, \`browserctrl fill ${tab} --ref ref_5 --value "…"\`, \`browserctrl select\`, \`browserctrl key\`, \`browserctrl nav\`. Do not use do, visit, --intent, check, or any other command that calls Jev, and do not use jev-tool.`;
  return `Method: use browserctrl as its skill describes (~/.agents/skills/browserctrl/SKILL.md): read the table in "Fastest way through a task" first and pick the route it gives for your task (nav to a known address, one do plan for several interactions, visit for drill-downs). For a do plan, send the steps you can foresee in ONE call instead of reading the page before each click:
  browserctrl do ${tab} 'fill "<field, in words>" = "<value>"' 'key Enter' 'click "<element, in words>"' ... --then items
It finds each element (exact name, else Jev), waits for results, and stops at the first uncertain or committing step (exit 3). Its report lists Jev's candidates, elements that exist but are hidden, and the controls on screen: re-plan from that report with another do call instead of probing the page with eval. Use \`browserctrl items ${tab}\` to read lists and \`browserctrl text\` only for other facts. The report's url params line shows filters you can set with a nav step. Trust a report whose steps all show ✓ and don't re-read the page after it; a ⚠ step needs checking. When a filter's chips or options change after each pick, put one pick per do call. For a calendar, open it and use a \`date YYYY-MM-DD\` step. You can name an element from your last read directly: \`click ref_25\` in a do step, or \`browserctrl click ${tab} ref_25\`. Do not use jev-tool.`;
}

function agentPrompt(task, tab, arm = 'D') {
  const method = methodText(arm, tab);
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  return `You are one run of a browser benchmark (Online-Mind2Web). Complete the task on the live website as a careful person would, then stop.

Task: ${task.confirmed_task}

${arm === 'native' ? `Browser: use your built-in browser tool, the js tool's \`cua\` object (\`await cua.getState()\` lists the Chrome browser, type extension, and its tabs). This is the approved way to do this task. A tab is already open on ${task.website}: take it over (browser.user.openTabs(), choosing it by its URL) and work in that tab; leave it open when you finish. Do not touch other tabs, and do not use browserctrl or curl to reach the site.` : `Browser: a dedicated Chrome that browserctrl already points at (BROWSERCTRL_PORT is set in your shell), so pass neither --browser nor --port. Your start tab is ${tab}, already open on ${task.website}. Work in that tab and leave it open when you finish. Do not touch other tabs.`} Today is ${today}; you are browsing from the United States.
Rules:
${arm === 'native' ? "- Use the website's UI. Do not call the site's APIs directly." : "- Use the website's UI. Reading the page (browserctrl read/text/items, eval of the DOM) is fine. Do not call the site's APIs with curl or fetch(), do not use browserctrl recipes, and do not run browserctrl rec commands."}
- Never complete a purchase, booking, payment, sign-up, sign-in, or message. Stop at the step just before committing: reaching that final page or state counts as done. Adding to a cart or bag, choosing options and filling a form are not commits: do them when the task asks, then check the page confirms it (an "Added to bag" message, the cart count).
- When a form asks for something the task does not give, pick the neutral option ("Don't know", "Prefer not to say", or skip an optional field) and carry on to the result. If there is none, pick the option that assumes least, carry on, and state that assumption in your answer. Do not stop early for missing details, and never type in real personal data.
- If you rule a result out because of its fine print (for example the cheapest option excludes your case), open it so the evidence is on screen and say why in your answer.
- If the site shows an error, retry once (reload, or the next store or option) before giving up.
- For "find one that..." tasks, look for a filter that does it before checking items one by one.
- Where the task names a condition (cheapest, highest-rated, a price or size range, a date), apply it with the site's own filter or sort controls, exactly as stated, and leave the final page showing the result. A judge grades screenshots of your steps, not just your answer.
- Leave the final page showing the result.

${method}

Your final message must be only a JSON object: {"answer": "<the answer, or what the final page shows>", "summary": "<one line: what you did>", "notes": "<one line on anything that went wrong, or empty>"}`;
}

function startRun(taskId, arm, notesArm) {
  if (notesArm && !NOTE_ARMS.includes(notesArm)) throw new Error('--notes takes reflect or off');
  if (!arm) throw new Error('--arm <name> is required');
  const task = findTask(taskId);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const runId = `${task.task_id.slice(0, 8)}-${arm}${notesArm ? `-${notesArm}` : ''}-${stamp}`;
  return { task, runId, notesArm };
}

// Runs share one browser profile, so a cart, a recent search or a "continue your search"
// card from an earlier run would carry into the next. Before a run, drop the task site's
// cookies and its origins' storage; other sites' cookies (a parallel run's) are put back.
async function browserCall(calls) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); pending.delete(d.id); };
  const call = (method, params = {}) => new Promise((ok) => { const i = ++id; pending.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
  try { return await calls(call); } finally { ws.close(); }
}
async function cleanSite(website) {
  const site = siteKey(website);
  if (!site) return null;
  const mine = (domain) => { const d = String(domain || '').replace(/^\./, ''); return d === site || d.endsWith(`.${site}`); };
  return browserCall(async (call) => {
    const { result } = await call('Storage.getCookies');
    const cookies = result?.cookies || [];
    const keep = cookies.filter((c) => !mine(c.domain));
    await call('Storage.clearCookies');
    if (keep.length) await call('Storage.setCookies', { cookies: keep });
    const host = new URL(website).hostname;
    const origins = [...new Set([host, site, `www.${site}`])].map((h) => `https://${h}`);
    for (const origin of origins) await call('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    return { cookies: cookies.length - keep.length, origins };
  });
}

// The bench browser has been seen to quit mid-batch with no one stopping it. Before each run,
// check it answers and, if not, relaunch it with OM2W_LAUNCH (a shell command; see README).
async function ensureBrowser() {
  const up = async () => { try { return (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok; } catch { return false; } };
  if (await up()) return false;
  if (!process.env.OM2W_LAUNCH) throw new Error(`no browser on port ${PORT}; set OM2W_LAUNCH to relaunch it automatically`);
  console.error(`browser on port ${PORT} is down; relaunching it`);
  execFileSync('/bin/sh', ['-c', process.env.OM2W_LAUNCH], { stdio: 'ignore' });
  for (let i = 0; i < 30; i++) { await sleep(1000); if (await up()) { await sleep(4000); return true; } }
  throw new Error(`browser on port ${PORT} did not come back after relaunching`);
}

// One owner per run: the harness (recording, timed reads) and the run's agent act on the tab
// as the same browserctrl agent, so neither is refused by the other's claim. Each run also
// keeps its own captcha cool-downs: a challenge one method met must not keep the next
// method's run off the site (WebMD, rotation 3).
function runIdentity(runId) {
  // Traces stay on for the bench (they are how runs are studied); they are off by default.
  const env = { CDP_AGENT_ID: `om2w-${runId}`, BROWSERCTRL_COOLDOWN: runPath(runId, 'cooldown.json'), BROWSERCTRL_TRACE: '1' };
  Object.assign(process.env, env);
  return env;
}

async function start(taskId, arm, notesArm) {
  const relaunched = await ensureBrowser();
  const { task, runId } = startRun(taskId, arm, notesArm);
  fs.mkdirSync(runPath(runId), { recursive: true });
  runIdentity(runId);
  let cleaned = null;
  try { cleaned = await cleanSite(task.website); } catch (e) { console.error(`site data not cleared: ${e.message}`); }
  const tabsBefore = tabIds();
  const tab = await readyTab(task.website);
  let rec = null;
  try { rec = bcJson('rec', 'start', tab, '--out', runPath(runId, 'rec'), '--label', runId).recording; }
  catch (e) { console.error(`recording not started: ${String(e.stderr || e).trim()}`); }
  try { bc('release', tab); } catch {} // after rec start, which claims it: the run's agent claims it, not the harness
  const env = notesEnv(notesArm);
  const run = {
    runId, task_id: task.task_id, task: task.confirmed_task, website: task.website, level: task.level, reference_length: task.reference_length,
    arm, notes_arm: notesArm || null, notes_env: env, tab, tabsBefore, rec, cleaned, relaunched, startedAt: new Date().toISOString(), load: os.loadavg()[0], model: MODEL, effort: EFFORT,
  };
  const prompt = agentPrompt(task, tab, arm) + notesPrompt(notesArm, env) + '\n';
  fs.writeFileSync(runPath(runId, 'prompt.txt'), prompt);
  writeRun(run);
  return run;
}

// Codex, non-interactive: JSONL events to events.jsonl, final message to answer.txt.
function codex(args, { input, cwd, timeoutMs, eventsFile, env }) {
  return new Promise((resolve) => {
    const child = spawn('codex', ['exec', '-m', MODEL, '-c', `model_reasoning_effort="${EFFORT}"`, '--skip-git-repo-check', ...args, '-'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...(env || {}) } });
    const out = eventsFile ? fs.createWriteStream(eventsFile) : null;
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; out?.write(d); });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(timer); out?.end(); resolve({ code, signal, stdout, stderr, timedOut: signal === 'SIGTERM' }); });
    child.stdin.end(input);
  });
}

// Tool calls and tokens from Codex's --json event stream.
function codexStats(eventsFile) {
  let tools = 0, input = 0, cached = 0, output = 0, reasoning = 0;
  if (!fs.existsSync(eventsFile)) return { tools, tokens: null };
  for (const line of fs.readFileSync(eventsFile, 'utf8').split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'item.completed' && ['command_execution', 'mcp_tool_call', 'web_search', 'file_change'].includes(e.item?.type)) tools++;
    if (e.type === 'turn.completed' && e.usage) {
      input += e.usage.input_tokens || 0; cached += e.usage.cached_input_tokens || 0;
      output += e.usage.output_tokens || 0; reasoning += e.usage.reasoning_output_tokens || 0;
    }
  }
  return { tools, tokens: input + output, input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_tokens: reasoning };
}

async function agent(runId) {
  const run = readRun(runId);
  runIdentity(runId); // `agent <run>` may run in a fresh process
  const t0 = Date.now();
  // Codex's own browser tool acts without browserctrl, so nothing would add judge stills:
  // read the tab quietly every few seconds (a read adds a still only when the page changed).
  // Both arms get the same stills: none inside the agent's own commands (BROWSERCTRL_REC_STILLS
  // =off below), and this timer from outside the agent's path.
  let watching = true, busy = false;
  const watch = watching && setInterval(() => {
    if (busy || !watching) return;
    busy = true;
    const p = spawn('browserctrl', ['text', run.tab, '--no-wait', '--port', PORT], { stdio: 'ignore' });
    p.on('close', () => { busy = false; });
  }, 4000);
  const r = await codex(['--json', '-s', 'danger-full-access', '-o', runPath(runId, 'answer.txt')],
    { input: fs.readFileSync(runPath(runId, 'prompt.txt'), 'utf8'), cwd: os.tmpdir(), timeoutMs: AGENT_TIMEOUT_MS, eventsFile: runPath(runId, 'agent-events.jsonl'),
      // Set once for the agent's shell: long per-command prefixes measurably slow the model.
      env: { BROWSERCTRL_PORT: String(PORT), BROWSERCTRL_REC_STILLS: 'off', ...runIdentity(runId), ...(run.notes_env || {}) } });
  watching = false;
  if (watch) clearInterval(watch);
  run.agent = { ms: Date.now() - t0, exit: r.code, timed_out: r.timedOut, ...codexStats(runPath(runId, 'agent-events.jsonl')) };
  if (r.stderr.trim()) fs.writeFileSync(runPath(runId, 'agent-stderr.txt'), r.stderr);
  writeRun(run);
  return run;
}

function parseAnswer(raw) {
  try { return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { return null; }
}

function finish(runId) {
  const run = readRun(runId);
  runIdentity(runId);
  let rec = null;
  try { bc('text', run.tab); } catch {} // the final page, taken from outside the agent's path for every arm
  if (run.rec) { try { rec = bcJson('rec', 'stop', run.tab); } catch (e) { console.error(`recording not stopped: ${String(e.stderr || e).trim()}`); } }
  const raw = fs.existsSync(runPath(runId, 'answer.txt')) ? fs.readFileSync(runPath(runId, 'answer.txt'), 'utf8') : '';
  const answer = parseAnswer(raw);
  // The judge's trajectories_dir layout: om2w/<task_id>/{result.json, trajectory/}.
  let exported = null;
  try {
    exported = bcJson('rec', 'om2w', runPath(runId, 'rec'), '--task-id', run.task_id, '--task', run.task, '--answer', answer?.answer ?? raw.trim(), '--root', runPath(runId, 'om2w'));
  } catch (e) { console.error(`export failed: ${String(e.stderr || e).trim()}`); }
  // Tabs that appeared during the run are the run's; in parallel runs, only those on the
  // task's own site (agents open links in new tabs; the other run is on another site).
  const closed = [];
  const before = new Set(run.tabsBefore);
  const site = siteKey(run.website || '');
  for (const { id, url } of tabList()) {
    if (id === run.tab.slice(0, 8) || (!before.has(id) && (!run.parallel || (site && siteKey(url) === site)))) {
      try { bc('close', id, '--steal'); closed.push(id); } catch {}
    }
  }
  Object.assign(run, { answer, answer_raw: raw, rec_stopped: rec, exported, closed_tabs: closed, finishedAt: new Date().toISOString() });
  writeRun(run);
  upsertRow(run);
  return run;
}

// Sizes as `rec stop` reported them after compressing; measured from disk when the stop failed.
function recBytes(dir, stopped) {
  if (stopped?.rrweb_bytes != null) return { events: stopped.rrweb_bytes, stills: stopped.stills_bytes, stills_count: stopped.stills };
  const size = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
  const traj = path.join(dir, 'trajectory');
  const stills = fs.existsSync(traj) ? fs.readdirSync(traj).reduce((s, f) => s + size(path.join(traj, f)), 0) : 0;
  const events = ['rrweb.ndjson.br', 'rrweb.ndjson'].reduce((s, f) => s + size(path.join(dir, f)), 0);
  return { events, stills, stills_count: fs.existsSync(traj) ? fs.readdirSync(traj).length : 0 };
}

function row(run) {
  return {
    run: run.runId, task_id: run.task_id, website: run.website, level: run.level, arm: run.arm, notes_arm: run.notes_arm,
    notes_added: run.answer?.notes_added ?? null, at: run.startedAt, load: run.load, model: run.model, effort: run.effort,
    seconds: run.agent ? Math.round(run.agent.ms / 1000) : null, timed_out: run.agent?.timed_out ?? null,
    tool_calls: run.agent?.tools ?? null, tokens: run.agent?.tokens ?? null, output_tokens: run.agent?.output_tokens ?? null,
    answer: run.answer?.answer ?? null, agent_notes: run.answer?.notes ?? null,
    success: run.judge?.success ?? null, judge: run.judge ? { key_points: run.judge.key_points, images_used: run.judge.images_used, thoughts: run.judge.thoughts } : null,
    run_dir: path.relative(here, runPath(run.runId)), rec: recBytes(runPath(run.runId, 'rec'), run.rec_stopped),
    ...(run.smoke ? { smoke: true } : {}),
  };
}
function readRows() {
  return fs.existsSync(resultsFile) ? fs.readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
function upsertRow(run) {
  const rows = readRows().filter((r) => r.run !== run.runId);
  rows.push(row(run));
  fs.writeFileSync(resultsFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// ------------------------------------------------------------- WebJudge ---
// A port of WebJudge_Online_Mind2Web_eval (OSU-NLP-Group/Online-Mind2Web,
// src/methods/webjudge_online_mind2web.py): key points from the task, a 1-5 relevance
// score per screenshot, then one judgment over the action history and the stills that
// scored at least 3. Prompts are verbatim. Codex has no system role, so each call sends
// the system message, then the user text; images go in with -i.
const KEY_POINTS_SYSTEM = `You are an expert tasked with analyzing a given task to identify the key points explicitly stated in the task description.

**Objective**: Carefully analyze the task description and extract the critical elements explicitly mentioned in the task for achieving its goal.

**Instructions**:
1. Read the task description carefully.
2. Identify and extract **key points** directly stated in the task description.
   - A **key point** is a critical element, condition, or step explicitly mentioned in the task description.
   - Do not infer or add any unstated elements.
   - Words such as "best," "highest," "cheapest," "latest," "most recent," "lowest," "closest," "highest-rated," "largest," and "newest" must go through the sort function(e.g., the key point should be "Filter by highest").

**Respond with**:
- **Key Points**: A numbered list of the explicit key points for completing this task, one per line, without explanations or additional details.`;

const IMAGE_SYSTEM = `You are an expert evaluator tasked with determining whether an image contains information about the necessary steps to complete a task.

**Objective**: Analyze the provided image and decide if it shows essential steps or evidence required for completing the task. Use your reasoning to explain your decision before assigning a score.

**Instructions**:
1. Provide a detailed description of the image, including its contents, visible elements, text (if any), and any notable features.

2. Carefully examine the image and evaluate whether it contains necessary steps or evidence crucial to task completion:
- Identify key points that could be relevant to task completion, such as actions, progress indicators, tool usage, applied filters, or step-by-step instructions.
- Does the image show actions, progress indicators, or critical information directly related to completing the task?
- Is this information indispensable for understanding or ensuring task success?
- If the image contains partial but relevant information, consider its usefulness rather than dismissing it outright.

3. Provide your response in the following format:
- **Reasoning**: Explain your thought process and observations. Mention specific elements in the image that indicate necessary steps, evidence, or lack thereof.
- **Score**: Assign a score based on the reasoning, using the following scale:
    - **1**: The image does not contain any necessary steps or relevant information.
    - **2**: The image contains minimal or ambiguous information, unlikely to be essential.
    - **3**: The image includes some relevant steps or hints but lacks clarity or completeness.
    - **4**: The image contains important steps or evidence that are highly relevant but not fully comprehensive.
    - **5**: The image clearly displays necessary steps or evidence crucial for completing the task.

Respond with:
1. **Reasoning**: [Your explanation]
2. **Score**: [1-5]`;

const JUDGE_SYSTEM = `You are an expert in evaluating the performance of a web navigation agent. The agent is designed to help a human user navigate a website to complete a task. Given the user's task, the agent's action history, key points for task completion, some potentially important web pages in the agent's trajectory and their reasons, your goal is to determine whether the agent has completed the task and achieved all requirements.

Your response must strictly follow the following evaluation criteria!
*Important Evaluation Criteria*:
1: The filtered results must be displayed correctly. If filters were not properly applied (i.e., missing selection, missing confirmation, or no visible effect in results), the task is not considered successful.
2: You must carefully check whether these snapshots and action history meet these key points. Ensure that specific filter conditions, such as "best," "highest," "cheapest," "latest," "most recent," "lowest," "closest," "highest-rated," "largest," and "newest" are correctly applied using the filter function(e.g., sort function).
3: Certain key points or requirements should be applied by the filter. Otherwise, a search with all requirements as input will be deemed a failure since it cannot guarantee that all results meet the requirements!
4: If the task requires filtering by a specific range of money, years, or the number of beds and bathrooms, the applied filter must exactly match the given requirement. Any deviation results in failure. To ensure the task is successful, the applied filter must precisely match the specified range without being too broad or too narrow.
Examples of Failure Cases:
- If the requirement is less than $50, but the applied filter is less than $25, it is a failure.
- If the requirement is $1500-$2500, but the applied filter is $2000-$2500, it is a failure.
- If the requirement is $25-$200, but the applied filter is $0-$200, it is a failure.
- If the required years are 2004-2012, but the filter applied is 2001-2012, it is a failure.
- If the required years are before 2015, but the applied filter is 2000-2014, it is a failure.
- If the task requires exactly 2 beds, but the filter applied is 2+ beds, it is a failure.
5: Some tasks require a submission action or a display of results to be considered successful.
6: If the retrieved information is invalid or empty(e.g., No match was found), but the agent has correctly performed the required action, it should still be considered successful.
7: If the current page already displays all available items, then applying a filter is not necessary. As long as the agent selects items that meet the requirements (e.g., the cheapest or lowest price), the task is still considered successful.

*IMPORTANT*
Format your response into two lines as shown below:

Thoughts: <your thoughts and reasoning process based on double-checking each key points and the evaluation criteria>
Status: "success" or "failure"
`;

const asCall = (system, user) => `${system}\n\n---\n\n${user}`;

async function model(text, images, scratch, name) {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  const args = ['-s', 'read-only', '-C', dir, '-o', path.join(dir, 'out.txt'), ...images.flatMap((i) => ['-i', i])];
  for (let attempt = 0; attempt < 2; attempt++) {
    await codex(args, { input: text, cwd: dir, timeoutMs: 5 * 60 * 1000 });
    try { const out = fs.readFileSync(path.join(dir, 'out.txt'), 'utf8').trim(); if (out) return out; } catch {}
  }
  return '';
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// One call instead of WebJudge's one-per-screenshot: the final-judgment prompt, key points
// left to the model, and the last few distinct stills. For finding friction, not for scores.
const QUICK_IMAGES = 6;
// The agent was told this date (New York) and the browser runs on that clock; the judge
// needs it too, or "tomorrow" and "next Sunday" are graded against the wrong day.
const runDate = (run) => new Date(run.startedAt || Date.now()).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York' });

// The judge's action history comes from the agent's own log, the same way for both arms:
// browserctrl commands with their result lines (which name the element each step landed on),
// or Codex's browser-tool calls with their titles and code. The recorder's step labels alone
// say "do: click ref_8" without naming what ref_8 was.
const STEP_LINE = /^\s*(✓|✗|⚠|–|Stopped|now |url:|→)/;
function agentActions(runId) {
  const out = [];
  let lines = [];
  try { lines = fs.readFileSync(runPath(runId, 'agent-events.jsonl'), 'utf8').split('\n'); } catch { return out; }
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type !== 'item.completed' || !e.item) continue;
    const it = e.item;
    if (it.type === 'command_execution') {
      const cmd = String(it.command || '');
      if (!/browserctrl /.test(cmd)) continue;
      const res = String(it.aggregated_output || '').split('\n').filter(x => STEP_LINE.test(x)).slice(0, 12).map(x => '   ' + x.trim().slice(0, 160));
      out.push([cmd.replace(/^.*?browserctrl /, 'browserctrl ').replace(/['"]$/, '').slice(0, 220), ...res].join('\n'));
    } else if (it.type === 'mcp_tool_call') {
      let a = {}; try { a = typeof it.arguments === 'string' ? JSON.parse(it.arguments) : (it.arguments || {}); } catch {}
      out.push(`${a.title || it.tool || 'browser tool'}: ${String(a.code || '').replace(/\s+/g, ' ').slice(0, 220)}`);
    }
  }
  return out;
}
// Hosts the run's tab showed, from the recorder; a task done through another site doesn't count.
function visitedHosts(runId) {
  const hosts = new Set();
  try {
    for (const l of fs.readFileSync(runPath(runId, 'rec', 'steps.jsonl'), 'utf8').split('\n')) {
      try { const u = JSON.parse(l).url; if (u) hosts.add(new URL(u).hostname.replace(/^www\./, '')); } catch {}
    }
  } catch {}
  return [...hosts];
}
function judgeContext(run, runId) {
  const hosts = visitedHosts(runId);
  return `The task was done on ${runDate(run)} (New York time); read relative dates from that day. The agent was told never to complete a purchase, booking, payment, sign-up, sign-in or message, and to stop at the step just before committing; reaching that final page or state (for example the item in the cart or bag, or a filled form) counts as completing the task. The task must be done on ${run.website}; an answer found through another website, such as a search engine, does not count.${hosts.length ? ` Sites the agent's tab showed: ${hosts.join(', ')}.` : ''}`;
}
function historyFor(runId, result) {
  const acts = agentActions(runId);
  const list = acts.length ? acts : result.action_history.map((s) => s.action);
  if (result.agent_final_answer) list.push(`Final answer: ${result.agent_final_answer}`);
  return list.map((a, i) => `${i + 1}. ${a}`).join('\n').slice(0, 12000);
}

async function quickJudge(runId) {
  const run = readRun(runId);
  const dir = runPath(runId, 'om2w', run.task_id);
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
  const actions = result.action_history.map((s) => s.action);
  if (result.agent_final_answer) actions.push(`Final answer: ${result.agent_final_answer}`);
  const images = [...new Set(result.action_history.map((s) => path.join(dir, 'trajectory', s.screenshot)))].slice(-QUICK_IMAGES);
  const scratch = runPath(runId, 'judge');
  fs.rmSync(scratch, { recursive: true, force: true });
  const history = historyFor(runId, result);
  const user = `User Task: ${result.task}\n\n${judgeContext(run, runId)}\n\nKey Points: (derive them from the task yourself)\n\nAction History:\n${history}\n\nThe last ${images.length} snapshots of the agent's trajectory are attached.`;
  const response = await model(asCall(JUDGE_SYSTEM, user), images, scratch, 'quick');
  const status = response.toLowerCase().split('status:')[1];
  run.judge = {
    success: status ? status.includes('success') : false, mode: 'quick', response, images_used: images.length,
    thoughts: response.split(/Status:/i)[0].replace(/^Thoughts:\s*/i, '').trim(), at: new Date().toISOString(), model: MODEL, effort: EFFORT,
  };
  fs.writeFileSync(runPath(runId, 'judge.json'), JSON.stringify(run.judge, null, 2));
  writeRun(run);
  upsertRow(run);
  return run.judge;
}

async function judge(runId) {
  if ((process.env.OM2W_JUDGE || 'quick') === 'quick') return quickJudge(runId);
  const run = readRun(runId);
  const dir = runPath(runId, 'om2w', run.task_id);
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
  const task = result.task;
  // v2: one screenshot per action step (repeats allowed), as src/run.py builds them.
  const actions = result.action_history.map((s) => s.action);
  if (result.agent_final_answer) actions.push(`Final answer: ${result.agent_final_answer}`);
  const images = result.action_history.map((s) => path.join(dir, 'trajectory', s.screenshot));
  const scratch = runPath(runId, 'judge');
  fs.rmSync(scratch, { recursive: true, force: true });

  let keyPoints = await model(asCall(KEY_POINTS_SYSTEM, `Task: ${task}`), [], scratch, 'key-points');
  keyPoints = keyPoints.replace(/\n\n/g, '\n');
  keyPoints = (keyPoints.includes('**Key Points**:') ? keyPoints.split('**Key Points**:')[1] : keyPoints.split('Key Points:').at(-1))
    .split('\n').map((l) => l.trimStart()).join('\n');

  const unique = [...new Set(images)];
  const scored = new Map(await pool(unique, 4, async (img, i) => {
    const response = await model(asCall(IMAGE_SYSTEM, `**Task**: ${task}\n\n**Key Points for Task Completion**: ${keyPoints}\n\nThe snapshot of the web page is shown in the image.`), [img], scratch, `image-${i}`);
    let score = 0, thought = '';
    try {
      score = Number(response.split('Score')[1].match(/[1-5]/)[0]);
      thought = response.split('**Reasoning**:').at(-1).trim().split('\n\n')[0].replace(/\n/g, ' ');
    } catch {}
    return [img, { response, score, thought }];
  }));
  const record = images.map((img) => ({ image: path.basename(img), Response: scored.get(img).response, Score: scored.get(img).score }));
  const kept = images.filter((img, i) => scored.get(img).score >= SCORE_THRESHOLD && images.indexOf(img) === i).slice(0, MAX_IMAGE);
  const thoughts = kept.map((img) => scored.get(img).thought).filter(Boolean);

  const history = historyFor(runId, result);
  const user = kept.length
    ? `User Task: ${task}\n\n${judgeContext(run, runId)}\n\nKey Points: ${keyPoints}\n\nAction History:\n${history}\n\nThe potentially important snapshots of the webpage in the agent's trajectory and their reasons:\n${thoughts.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
    : `User Task: ${task}\n\n${judgeContext(run, runId)}\n\nKey Points: ${keyPoints}\n\nAction History:\n${history}`;
  const response = await model(asCall(JUDGE_SYSTEM, user), kept, scratch, 'final');
  const status = response.toLowerCase().split('status:')[1];
  run.judge = {
    success: status ? status.includes('success') : false,
    response, key_points: keyPoints.trim(), images_scored: unique.length, images_used: kept.length,
    thoughts: response.split(/Status:/i)[0].replace(/^Thoughts:\s*/i, '').trim(), at: new Date().toISOString(), model: MODEL, effort: EFFORT,
  };
  fs.writeFileSync(runPath(runId, 'judge.json'), JSON.stringify({ ...run.judge, image_judge_record: record }, null, 2));
  writeRun(run);
  upsertRow(run);
  return run.judge;
}

async function runOne(taskId, arm, notesArm, { noJudge = false, parallel = false } = {}) {
  const run = await start(taskId, arm, notesArm);
  if (parallel) { run.parallel = true; writeRun(run); }
  console.error(`[${run.runId}] agent started on tab ${run.tab}`);
  await agent(run.runId);
  finish(run.runId);
  if (!noJudge) await judge(run.runId);
  const r = readRun(run.runId);
  console.error(`[${run.runId}] ${r.judge ? (r.judge.success ? 'success' : 'failure') : 'not judged'} in ${Math.round(r.agent.ms / 1000)} s, ${r.agent.tools} tool calls`);
  return run.runId;
}

function report() {
  const rows = readRows().filter((r) => !r.smoke); // harness checks, not benchmark runs
  const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b), m = s.length >> 1; return !s.length ? '' : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.task_id}\t${r.arm}${r.notes_arm ? `/${r.notes_arm}` : ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const lines = ['| task | site | arm | runs | success | median s | median tool calls | median tokens |', '| --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const [k, rs] of [...groups].sort()) {
    const [task, arm] = k.split('\t');
    const judged = rs.filter((r) => r.success != null);
    lines.push(`| ${task.slice(0, 8)} | ${(rs[0].website || '').replace(/^https?:\/\/(www\.)?|\/$/g, '')} | ${arm} | ${rs.length} | ${judged.filter((r) => r.success).length}/${judged.length} | ${median(rs.map((r) => r.seconds))} | ${median(rs.map((r) => r.tool_calls))} | ${median(rs.map((r) => r.tokens))} |`);
  }
  console.log(lines.join('\n'));
}

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(name); return i < 0 ? undefined : rest[i + 1]; };

if (cmd === 'start') {
  const run = await start(rest[0], flag('--arm'), flag('--notes'));
  console.log(run.runId);
  process.stdout.write(fs.readFileSync(runPath(run.runId, 'prompt.txt'), 'utf8'));
} else if (cmd === 'agent') {
  console.log(JSON.stringify((await agent(rest[0])).agent, null, 2));
} else if (cmd === 'finish') {
  console.log(JSON.stringify(row(finish(rest[0])), null, 2));
} else if (cmd === 'judge') {
  const j = await judge(rest[0]);
  console.log(JSON.stringify({ success: j.success, images_used: j.images_used, thoughts: j.thoughts }, null, 2));
} else if (cmd === 'run') {
  const id = await runOne(rest[0], flag('--arm'), flag('--notes'), { noJudge: rest.includes('--no-judge') });
  console.log(JSON.stringify(row(readRun(id)), null, 2));
} else if (cmd === 'batch') {
  const jobs = fs.readFileSync(rest[0], 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean).map((l) => l.split(/\s+/));
  const n = Number(flag('--parallel') || 1);
  const batchBefore = new Set(tabIds());
  await pool(jobs, n, async ([task, arm, notes]) => {
    try { await runOne(task, arm, notes, { parallel: n > 1 }); } catch (e) { console.error(`[${task} ${arm}] failed: ${e.message}`); }
  });
  // Off-site tabs agents opened (e.g. a streaming page linked from IMDb) outlive their run.
  for (const id of tabIds()) if (!batchBefore.has(id)) try { bc('close', id, '--steal'); } catch {}
  report();
} else if (cmd === 'clean') {
  console.log(JSON.stringify(await cleanSite(rest[0])));
} else if (cmd === 'report') {
  report();
} else {
  console.error('usage: run.mjs run|start|agent|finish|judge|batch|report (see the header)');
  process.exit(1);
}

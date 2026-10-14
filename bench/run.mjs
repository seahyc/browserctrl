#!/usr/bin/env node
// Jev benchmark harness. See bench/README.md for the protocol.
//   node bench/run.mjs start <task> <A|B> <n> [--tab ID]   prepare a run, print the agent prompt
//   node bench/run.mjs finish <run> <answer.json> --ms N --tokens N --tools N
//   node bench/run.mjs report
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runsDir = path.join(here, 'runs');
const resultsFile = path.join(here, 'results.jsonl');
const tasks = JSON.parse(fs.readFileSync(path.join(here, 'tasks.json'), 'utf8'));
const fixtures = JSON.parse(fs.readFileSync(path.join(here, 'fixtures.json'), 'utf8'));
const JEV_DIR = path.join(os.homedir(), 'Code/jev-ultrafast');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const bc = (...args) => sh('browserctrl', [...args, '--browser', 'dia']);
const bcJson = (...args) => JSON.parse(bc(...args));
const recipe = (...args) => { try { return JSON.parse(bc('recipe', 'run', ...args)); } catch { return JSON.parse(bc('recipe', 'run', ...args)); } };
const gitlab = (p) => JSON.parse(sh('glab', ['api', p], { env: { ...process.env, GITLAB_HOST: 'gitlab.glints.com' } }));
const gh = (...args) => JSON.parse(sh('gh', args));

const fill = (s) => s.replace(/FIXTURE:(\w+)/g, (_, k) => fixtures[k]);
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const tabIds = () => bcJson('tabs', '--json').map((t) => t.targetId || t.id);

async function pageText(url, waitMs = 6000) {
  const { id } = bcJson('open', url);
  try {
    await sleep(waitMs);
    return bc('text', id, '--max-text', '60000');
  } finally {
    try { bc('close', id); } catch {}
  }
}

// Hand over a tab only once it has rendered: Shopee's purchase page stays blank for seconds.
async function readyTab(url) {
  const { id } = bcJson('open', url);
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    try { if (Number(bc('eval', id, 'document.readyState === "complete" ? document.body.innerText.length : 0')) > 300) break; } catch {}
  }
  await sleep(1000);
  return id;
}

// Each check returns [{name, ok, detail}]. Truth is read live, before and after the run when it can drift.
const checks = {
  async 'carousell-search'(a) {
    const out = [{ name: 'five listings', ok: a.listings?.length === 5 }];
    for (const l of a.listings ?? []) {
      const text = await pageText(l.url);
      const price = Number(l.price_sgd);
      out.push({ name: `listing ${l.url}`, ok: /carousell\.sg\/p\//.test(l.url) && /aeron/i.test(text) && price <= 600 && text.includes(`S$${price.toLocaleString('en-US')}`) && norm(text).includes(norm(l.seller)), detail: { price, seller: l.seller } });
    }
    return out;
  },
  async 'shopee-compare'(a) {
    const urls = new Set((a.listings ?? []).map((l) => l.url));
    const out = [{ name: 'three distinct listings', ok: a.listings?.length === 3 && urls.size === 3 }];
    for (const l of a.listings ?? []) {
      const text = await pageText(l.url, 8000);
      out.push({ name: `listing ${l.url}`, ok: /anker/i.test(l.title) && /anker/i.test(text) && text.includes(`$${Number(l.price_sgd).toFixed(2)}`), detail: { price: l.price_sgd } });
    }
    return out;
  },
  async 'shopee-cart'(a, run) {
    const rows = await cartRows();
    const hit = rows.some((r) => r.includes(norm(fixtures.shopee_cart_title)) && r.includes(norm(fixtures.shopee_cart_variation_text)));
    return [
      { name: 'fixture not in cart before', ok: !run.pre.inCart },
      { name: 'fixture variation in cart', ok: hit },
      { name: 'agent reports added', ok: a.added === true },
    ];
  },
  async 'carousell-reply-draft'(a, run) {
    const box = bc('eval', run.tab, 'document.querySelector("textarea")?.value ?? null').trim();
    const sentNow = sentCount();
    return [
      { name: 'draft typed', ok: box === 'Thank you!', detail: box },
      { name: 'nothing sent', ok: sentNow === run.pre.sent, detail: { before: run.pre.sent, after: sentNow } },
      { name: 'right chat', ok: bc('eval', run.tab, 'location.href').includes(fixtures.carousell_offer_id) },
    ];
  },
  async 'taobao-sku'(a) {
    const out = [{ name: 'has sku groups', ok: a.sku_groups?.length > 0 }];
    let text = '';
    try { text = bc('text', a.tab, '--max-text', '80000'); } catch (e) { return [...out, { name: 'reported tab readable', ok: false, detail: String(e).slice(0, 200) }]; }
    out.push({ name: 'title on page', ok: norm(text).includes(norm(a.title).slice(0, 20)) });
    for (const g of a.sku_groups ?? []) out.push({ name: `sku ${g.name}`, ok: g.values.every((v) => text.includes(v)), detail: g.values.filter((v) => !text.includes(v)) });
    return out;
  },
  async 'shopee-refund'(a) {
    const orders = recipe('shopee.sg/orders', 'limit=20', '--max-pages', '1');
    const done = orders.find((o) => /completed/i.test(o.status));
    const detail = done ? await pageText(`https://shopee.sg/user/purchase/order/${done.order_id}`, 8000) : '';
    return [
      { name: 'order id', ok: Boolean(a.order_id) && detail.includes(String(a.order_id)), detail: { internal: done?.order_id, got: a.order_id } },
      { name: 'shop', ok: norm(a.shop) === norm(done?.shop) },
      { name: 'total', ok: Math.abs(Number(a.total_sgd) * 100000 - Number(done?.total_cents)) < 1000, detail: { truth: done?.total_cents } },
      { name: 'refund fields present', ok: typeof a.refund_available === 'boolean', detail: { refund_available: a.refund_available, deadline: a.refund_deadline, review: 'manual' } },
    ];
  },
  async 'github-prs'(a) {
    const prs = gh('pr', 'list', '-R', 'ModelMonkeys/modelmonkey', '--state', 'merged', '--limit', '500', '--json', 'number,mergedAt');
    const inDec = (iso) => iso.startsWith('2025-12');
    const truth = new Set(prs.filter((p) => inDec(p.mergedAt)).map((p) => p.number));
    const got = new Set((a.prs ?? []).map((p) => Number(p.number)));
    const missing = [...truth].filter((n) => !got.has(n));
    const extra = [...got].filter((n) => !truth.has(n));
    return [{ name: 'exact PR set', ok: !missing.length && !extra.length, detail: { missing, extra } }];
  },
  async 'gitlab-mrs'(a) {
    const truth = gitlab('projects/19/merge_requests?state=closed&per_page=100');
    const byIid = new Map(truth.map((m) => [m.iid, m]));
    const got = (a.mrs ?? []).map((m) => Number(m.iid));
    const missing = [...byIid.keys()].filter((n) => !got.includes(n));
    const extra = got.filter((n) => !byIid.has(n));
    const top = truth.reduce((x, y) => (y.iid > x.iid ? y : x));
    return [
      { name: 'exact closed MR set', ok: !missing.length && !extra.length, detail: { missing, extra } },
      { name: 'authors', ok: (a.mrs ?? []).every((m) => norm(m.author) === norm(byIid.get(Number(m.iid))?.author.username)) },
      { name: 'highest IID source branch', ok: a.highest_iid_source_branch === top.source_branch, detail: top.source_branch },
    ];
  },
};

function sentCount() {
  const items = recipe('carousell.sg/messages', `offer_id=${fixtures.carousell_offer_id}`);
  return items.filter((m) => norm(m.from) === norm(fixtures.carousell_me)).length;
}

async function cartRows() {
  const text = await pageText('https://shopee.sg/cart', 8000);
  return norm(text).split(/delete/).map((r) => r);
}

// Run before the agent, so checks and undo have a baseline.
const prepare = {
  async 'shopee-cart'() { const rows = await cartRows(); return { inCart: rows.some((r) => r.includes(norm(fixtures.shopee_cart_title)) && r.includes(norm(fixtures.shopee_cart_variation_text))) }; },
  async 'carousell-reply-draft'() { return { sent: sentCount() }; },
};

const undo = {
  async 'shopee-cart'(run) {
    if (run.pre.inCart) return 'skipped: was in cart before';
    const id = await readyTab('https://shopee.sg/cart');
    try {
      for (let i = 0; i < 3; i++) {
        const snap = bc('read', id);
        const lines = snap.split('\n');
        const at = lines.findIndex((l) => /button\s+Variations:/.test(l) && norm(l).includes(norm(fixtures.shopee_cart_variation_text)));
        if (at < 0) return i ? 'removed' : 'not in cart';
        const del = lines.slice(at).find((l) => /button\s+Delete/.test(l));
        bc('click', id, '--ref', del.trim().split(/\s+/)[0]);
        await sleep(3000);
      }
      return 'still in cart after 3 deletes';
    } finally { try { bc('close', id); } catch {} }
  },
  async 'carousell-reply-draft'(run) {
    bc('eval', run.tab, `(() => { const t = document.querySelector('textarea'); if (!t) return 'no box'; t.focus(); document.execCommand('selectAll'); document.execCommand('delete'); return t.value; })()`);
    return 'cleared';
  },
};

function agentPrompt(task, arm, tab) {
  const allow = task.jev_allow_controls.map((c) => ` --allow-control '${JSON.stringify(c)}'`).join('');
  const common = `You are one run of a timed browser benchmark. Work quickly and stop as soon as you have a verified answer.

Task: ${fill(task.goal)}

Browser: the user's Dia, always with --browser dia. Your start tab is ${tab}, already open on the task's start page. Leave it open when you finish.
Use the website's UI only. Do not use browserctrl recipes, gh, glab, curl, or fetch() calls to the site's APIs. Reading the page (browserctrl read/text/html/eval of DOM) is fine. Do not touch other tabs.

Your final message must be only a JSON object of this shape: ${task.answer}
Add "notes": a one-line string on anything that went wrong.`;
  if (arm === 'A') return `${common}

Method: drive the page yourself with browserctrl (skill: ~/.agents/skills/browserctrl/SKILL.md). Do not use Jev.`;
  return `${common}

Method: use Jev for the navigation (skill: ~/.agents/skills/jev-browser/SKILL.md). Start with one bounded run:
  cd ${JEV_DIR} && uv run jev-tool --browser dia --tab ${tab} --goal '<the task, in your words>' --run --max-steps 15 --max-seconds 180${allow}
Then read the page with browserctrl to extract and verify the answer. If Jev paused, failed or stopped early, finish the task with browserctrl or a persistent Jev session, as the skill describes. Do not relaunch the same failing goal.
Add to your JSON "jev": {"runs": n, "predictions": n, "exit_codes": [..], "finished_by": "jev" | "agent"}.`;
}

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(name); return i < 0 ? undefined : rest[i + 1]; };

if (cmd === 'start') {
  const [taskId, arm, n] = rest;
  const task = tasks.find((t) => t.id === taskId);
  if (!task || !['A', 'B'].includes(arm)) throw new Error('usage: start <task> <A|B> <n> [--tab ID]');
  const runId = `${taskId}-${arm}-${n}`;
  const pre = (await prepare[taskId]?.()) ?? {};
  let tab = flag('--tab');
  if (!tab) {
    if (task.start_url.startsWith('HANDOFF:')) throw new Error('this task needs --tab <a tab the user opened>');
    tab = await readyTab(fill(task.start_url));
    bc('release', tab); // the run's agent claims it, not the harness
  }
  const run = { runId, task: taskId, arm, n: Number(n), tab, tabsBefore: tabIds(), pre, startedAt: new Date().toISOString(), load: os.loadavg()[0] };
  fs.mkdirSync(path.join(runsDir, runId), { recursive: true });
  fs.writeFileSync(path.join(runsDir, runId, 'run.json'), JSON.stringify(run, null, 2));
  process.stdout.write(agentPrompt(task, arm, tab) + '\n');
} else if (cmd === 'finish') {
  const [runId, answerFile] = rest;
  const run = JSON.parse(fs.readFileSync(path.join(runsDir, runId, 'run.json'), 'utf8'));
  const raw = fs.readFileSync(answerFile, 'utf8');
  fs.writeFileSync(path.join(runsDir, runId, 'answer.txt'), raw);
  let answer;
  try { answer = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { answer = null; }
  const results = answer ? await checks[run.task](answer, run) : [{ name: 'answer is JSON', ok: false }];
  const undone = undo[run.task] ? await undo[run.task](run) : null;
  const handoff = tasks.find((t) => t.id === run.task).start_url.startsWith('HANDOFF:');
  const closed = [];
  for (const id of tabIds()) {
    if (handoff ? !run.tabsBefore.includes(id) : (id === run.tab || !run.tabsBefore.includes(id))) {
      try { bc('close', id); closed.push(id); } catch {}
    }
  }
  const row = {
    run: runId, task: run.task, arm: run.arm, n: run.n, at: run.startedAt, load: run.load,
    pass: results.every((r) => r.ok), checks: results,
    agent_ms: Number(flag('--ms')), agent_tokens: Number(flag('--tokens')), tool_uses: Number(flag('--tools')),
    jev: answer?.jev ?? null, notes: answer?.notes ?? null, undo: undone, closed_tabs: closed.length,
  };
  fs.appendFileSync(resultsFile, JSON.stringify(row) + '\n');
  console.log(JSON.stringify({ run: runId, pass: row.pass, failed: results.filter((r) => !r.ok), undo: undone }, null, 2));
} else if (cmd === 'report') {
  const rows = fs.existsSync(resultsFile) ? fs.readFileSync(resultsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };
  const lines = ['| task | arm | runs | pass | median s (passing) | median tokens | median tools | verdict |', '| --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const t of tasks) {
    const stat = {};
    for (const arm of ['A', 'B']) {
      const rs = rows.filter((r) => r.task === t.id && r.arm === arm && r.n > 0);
      const ok = rs.filter((r) => r.pass);
      stat[arm] = { n: rs.length, pass: ok.length, ms: median(ok.map((r) => r.agent_ms)), tokens: median(rs.map((r) => r.agent_tokens)), tools: median(rs.map((r) => r.tool_uses)) };
    }
    const { A, B } = stat;
    // Pre-registered rule: B wins a task if it is >=30% faster to a verified answer and no less successful.
    const verdict = A.n < 3 || B.n < 3 ? 'incomplete' : B.pass >= A.pass && B.pass > 0 && B.ms <= 0.7 * A.ms ? 'Jev wins' : 'agent';
    for (const arm of ['A', 'B']) {
      const s = stat[arm];
      lines.push(`| ${t.id} | ${arm} | ${s.n} | ${s.pass}/${s.n} | ${(s.ms / 1000).toFixed(0)} | ${s.tokens} | ${s.tools} | ${arm === 'B' ? verdict : ''} |`);
    }
  }
  console.log(lines.join('\n'));
} else {
  console.error('usage: run.mjs start|finish|report');
  process.exit(1);
}

// How long do steps wait for the page to settle? Runs the step fixtures' plans (exact names,
// no model) in a headless browser and prints each step's settle time, then the median and
// p90. Point it at another checkout to compare implementations:
//   node bench/settle-timing.mjs [repo root] [rounds]
// It starts its own fixture server and headless Chrome on BROWSERCTRL_TEST_PORT (9333 by
// default) and reads the code to time from the given root (this checkout by default).
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(process.argv[2] || here);
const rounds = Number(process.argv[3] || 3);
const load = (p) => import(pathToFileURL(path.join(root, p)).href);
const { connect } = await load('lib/daemon.mjs');
const ops = await load('lib/ops.mjs');
const { runSteps, settle } = await load('lib/steps.mjs');
const { startFixtureServer, startHeadlessBrowser, TEST_PORT } = await import(pathToFileURL(path.join(here, 'test/helpers.mjs')).href);

process.env.BROWSERCTRL_NOTES = 'off';
// Jev answers "none" and "no" to everything: only exact names act, so every run is the same.
const noJev = {
  cfg: { key: 'fake', model: 'fake' },
  fetchImpl: async (url, init) => {
    const answers = {};
    for (const [id, q] of Object.entries(JSON.parse(init.body).questions)) {
      if (q.type === 'noul') answers[id] = { type: 'noul', noul: 0.04 };
      else { const keys = Object.keys(q.criteria); answers[id] = { type: 'choice', choice: 'none', probabilities: Object.fromEntries(keys.map(k => [k, k === 'none' ? 0.9 : 0.1 / (keys.length - 1)])), confidence: 0.9 }; }
    }
    return { ok: true, status: 200, json: async () => ({ answers, model: 'fake' }) };
  },
};

const PLANS = [
  ['steps-friction5.html', ['fill "Search" = "chef"', 'click "Search"']],
  ['steps-friction5.html', ['click "Salary"', 'click "Middle Income Jobs ($30K-$49K)"']],
  ['steps-friction5.html', ['click "Salary"', 'click "Gym"', 'select "State" = "OH"', 'scroll down']],
  ['steps-friction.html', ['fill "SEND-TO EMAIL" = gift@example.com', 'fill "Search for parking" = SFMOMA', 'click "Increase Children"', 'click "Increase Children"', 'click "Decrease Children"']],
  ['steps-friction4.html', ['click "Gym"', 'click "Washer"', 'click "Increase Pets"']],
  ['steps-shop.html', ['fill Search = aeron', 'key Enter']],
  ['steps-form.html', ['type "hello"', 'key Tab']],
];

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : NaN; };

const fixture = await startFixtureServer();
const browser = await startHeadlessBrowser(TEST_PORT);
const conn = await connect(TEST_PORT);
const all = [], whys = {}, plans = [];
try {
  for (let k = 0; k < rounds; k++) {
    for (const [file, lines] of PLANS) {
      const id = (await ops.newTab(conn, `${fixture.url}fixtures/${file}`)).targetId;
      await ops.waitForReady(conn, id, { waitUntil: 'load' });
      const t0 = Date.now();
      const r = await runSteps(conn, id, lines, { jev: noJev, noNotes: true, traceRun: false, prefetch: false });
      plans.push(Date.now() - t0);
      for (const row of r.steps) {
        if (row.settle_ms == null) continue;
        all.push(row.settle_ms);
        const why = String(row.settle_why || '').replace(/^cap: .*/, 'cap');
        whys[why] = (whys[why] || 0) + 1;
        if (k === 0) console.log(`${file.padEnd(22)} ${row.do.slice(0, 44).padEnd(44)} ${String(row.settle_ms).padStart(5)} ms  ${row.settle_why}${row.stopped ? '  (stopped)' : ''}`);
      }
      // A page already still: the cost of settling when nothing happens.
      const t1 = Date.now();
      await settle(conn, id, {});
      all.idle = (all.idle || []).concat(Date.now() - t1);
      await ops.closeTab(conn, id).catch(() => {});
    }
  }
} finally {
  conn.close?.();
  await browser?.close();
  await fixture.close();
}
console.log(`\n${root}`);
console.log(`steps: ${all.length} over ${rounds} rounds; settle per step: median ${pct(all, 0.5)} ms, p90 ${pct(all, 0.9)} ms, mean ${Math.round(all.reduce((a, b) => a + b, 0) / all.length)} ms`);
console.log(`settle on a still page: median ${pct(all.idle, 0.5)} ms, p90 ${pct(all.idle, 0.9)} ms`);
console.log(`plan wall time: median ${pct(plans, 0.5)} ms, p90 ${pct(plans, 0.9)} ms`);
console.log(`ended by: ${Object.entries(whys).map(([k, v]) => `${k} ${v}`).join(', ')}`);
process.exit(0);

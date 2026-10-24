#!/usr/bin/env node
// Static-ish server for the feature bench's local sites (site.mjs). run.mjs starts one per
// run and stops it after; it listens on 127.0.0.1 only.
//
//   node bench/om2w/features/server.mjs [--port 9250]
//   node bench/om2w/features/server.mjs --selftest     answers computed from the data vs tasks.json
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { route, answers, jobs } from './site.mjs';
import { checkAnswer } from './check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

if (args.includes('--selftest')) {
  const tasks = JSON.parse(fs.readFileSync(path.join(here, 'tasks.json'), 'utf8')).tasks;
  const a = answers();
  let bad = 0;
  const ids = jobs().map((j) => j.id);
  if (new Set(ids).size !== ids.length) { console.log('job ids collide'); bad++; }
  for (const t of tasks) {
    const want = a[t.task_id];
    const got = t.expect.value;
    const same = typeof want === 'number' ? Math.abs(want - got) < 1e-9 : want === got;
    const right = checkAnswer(t, String(want)).success;
    console.log(`${same && right ? 'ok ' : 'BAD'} ${t.task_id}: data ${JSON.stringify(want)}, tasks.json ${JSON.stringify(got)}, checker ${right}`);
    for (const w of t.expect.wrong || []) if (checkAnswer(t, String(w)).success) { console.log(`BAD ${t.task_id}: wrong answer ${w} passes`); bad++; }
    if (!same || !right) bad++;
  }
  console.log('stays by total:', a._stays.join(' | '));
  process.exit(bad ? 1 : 0);
}

const i = args.indexOf('--port');
const port = Number(i >= 0 ? args[i + 1] : process.env.OM2W_FIXTURE_PORT || 9250);
if (port === 9222 || port === 9223) throw new Error('ports 9222/9223 belong to the user\'s browser');
const server = http.createServer((req, res) => {
  const r = route(req.url);
  res.writeHead(r.status, { 'content-type': r.type, 'cache-control': 'no-store', ...(r.headers || {}) });
  res.end(r.body);
});
server.listen(port, '127.0.0.1', () => console.log(`feature sites on http://127.0.0.1:${port}/`));
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => server.close(() => process.exit(0)));

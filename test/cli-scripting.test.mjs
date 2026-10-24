// The CLI as a Unix tool, run as a binary: exit codes, -q, data on stdout and reports on
// stderr, grep-like find and text --match, plans from stdin, and --repeat … --collect
// streaming every page of a 40-page log table to a file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';
import { fakeJev } from './fake-jev.mjs';
import { exitCodeFor, EXIT } from '../lib/exit-codes.mjs';
import { connect } from '../lib/daemon.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-cli-scripting-'));
const BASE_ENV = {
  ...process.env, CDP_AGENT_ID: 'test-cli-scripting', BROWSERCTRL_NOTIFY: '0', BROWSERCTRL_NOTES: 'off',
  BROWSERCTRL_JEV_ENV: path.join(TMP, 'no-such-jev.env'), BROWSERCTRL_TRACES: path.join(TMP, 'traces'),
};
delete BASE_ENV.TYPESAFE_API_KEY;
delete BASE_ENV.BROWSERCTRL_BROWSER;
delete BASE_ENV.BROWSERCTRL_PORT;

// Run the binary; resolve with its exit code and both streams, whatever the code.
function run(args, { input, env = {}, port = TEST_PORT, timeout = 240000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/browserctrl.mjs'), ...args, ...(port ? ['--port', String(port)] : [])],
      { env: { ...BASE_ENV, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

const haveBrowser = Boolean(chromeBinary());
const t = (name, fn) => test(name, { skip: !haveBrowser && 'no Chromium-family browser' }, fn);
let fixture, browser;
before(async () => {
  if (!haveBrowser) return;
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(TEST_PORT);
});
after(async () => {
  if (haveBrowser) await run(['stop']).catch(() => {});
  await browser?.close();
  await fixture?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function open(page) {
  const r = await run(['open', `${fixture.url}fixtures/${page}`]);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout).id;
}

test('errors map to the documented exit codes', () => {
  assert.equal(exitCodeFor(new Error('Usage: browserctrl find <tab> "<text or regex>"')), EXIT.USAGE);
  assert.equal(exitCodeFor(new Error('step 2, line 1, column 7: unknown action')), EXIT.USAGE);
  assert.equal(exitCodeFor(Object.assign(new Error('Tab 1234abcd is claimed by x (y)'), { code: 'CLAIMED' })), EXIT.REFUSED);
  assert.equal(exitCodeFor(new Error('tab_tainted: a protected vault field was filled in this tab.')), EXIT.REFUSED);
  assert.equal(exitCodeFor(new Error('example.com is cooling down after a challenge at 10:00: refusing to open it')), EXIT.REFUSED);
  assert.equal(exitCodeFor(new Error('No browser is debuggable on port 9999.')), EXIT.UNAVAILABLE);
  assert.equal(exitCodeFor(new Error('Timed out waiting for the tab')), EXIT.FAILED);
  assert.equal(exitCodeFor(Object.assign(new Error('x'), { exitCode: 1 })), 1);
});

test('usage errors exit 2 and a missing browser exits 4, before any page is touched', async () => {
  const unknown = await run(['fnd'], { port: null });
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Did you mean "find"/);
  assert.equal(unknown.stdout, '');
  const none = await run(['tabs'], { port: 1 });
  assert.equal(none.code, 4, none.stderr);
  assert.match(none.stderr, /No browser is debuggable on port 1/);
});

t('find is grep-like: exit 1 on no match, -q prints nothing, --count and --enabled', async () => {
  const tab = await open('log-table.html?pages=3');
  const hit = await run(['find', tab, 'Go to next page']);
  assert.equal(hit.code, 0, hit.stderr);
  assert.match(hit.stdout, /Go to next page/);
  const miss = await run(['find', tab, 'Download everything']);
  assert.equal(miss.code, 1);
  assert.equal(miss.stdout, '', 'no match: nothing on stdout');
  assert.match(miss.stderr, /Nothing on the page matches/);
  const quiet = await run(['find', tab, 'Download everything', '-q']);
  assert.deepEqual([quiet.code, quiet.stdout, quiet.stderr], [1, '', '']);
  const quietHit = await run(['find', '-q', tab, 'Go to next page']);
  assert.deepEqual([quietHit.code, quietHit.stdout, quietHit.stderr], [0, '', '']);
  const count = await run(['find', tab, 'Go to (next|previous) page', '--count']);
  assert.deepEqual([count.code, count.stdout.trim()], [0, '2']);
  // On page 1 the previous-page button is disabled: it is found, but not --enabled.
  const disabled = await run(['find', tab, 'Go to previous page', '--enabled']);
  assert.equal(disabled.code, 1, disabled.stdout);
  const lines = await run(['find', tab, 'Go to (next|previous) page', '--jsonl']);
  assert.equal(lines.code, 0, lines.stderr);
  assert.deepEqual(lines.stdout.trim().split('\n').map(l => JSON.parse(l).name).sort(), ['Go to next page', 'Go to previous page']);
});

t('text --match exits 1 when no line matches; wait exits 1 when its condition never holds', async () => {
  const tab = await open('log-table.html?pages=3');
  const hit = await run(['text', tab, '--match', 'Page \\d+ of 3']);
  assert.equal(hit.code, 0, hit.stderr);
  assert.match(hit.stdout.trim(), /^\S* ?Page 1 of 3 ?\S*$/);
  const miss = await run(['text', tab, '--match', 'Page 9 of']);
  assert.equal(miss.code, 1);
  assert.equal(miss.stdout, '');
  assert.match(miss.stderr, /No line of the page matches/);
  const quiet = await run(['text', tab, '--match', 'Page 1 of', '-q']);
  assert.deepEqual([quiet.code, quiet.stdout, quiet.stderr], [0, '', '']);
  const count = await run(['text', tab, '--match', 'SELECT', '--count']);
  assert.deepEqual([count.code, count.stdout.trim()], [0, '25']);
  const wait = await run(['wait', tab, '--text', 'never shown', '--timeout', '600']);
  assert.equal(wait.code, 1, wait.stderr);
  assert.equal(JSON.parse(wait.stdout).matched, false);
  const waitQuiet = await run(['wait', tab, '--text', 'Page 1 of 3', '-q']);
  assert.deepEqual([waitQuiet.code, waitQuiet.stdout], [0, '']);
});

t('tabs --jsonl and --ids print one tab per line for scripts', async () => {
  const tab = await open('log-table.html?pages=2');
  const jsonl = await run(['tabs', '--jsonl']);
  assert.equal(jsonl.code, 0, jsonl.stderr);
  const rows = jsonl.stdout.trim().split('\n').map(l => JSON.parse(l));
  assert.ok(rows.some(r => r.id === tab));
  const ids = await run(['tabs', '--ids']);
  assert.equal(ids.code, 0, ids.stderr);
  assert.deepEqual(ids.stdout.trim().split('\n'), rows.map(r => r.id));
});

t('a claimed tab is refused with exit 5', async () => {
  const tab = await open('log-table.html?pages=2');
  const mine = await run(['key', tab, 'Shift']);
  assert.equal(mine.code, 0, mine.stderr);
  const theirs = await run(['key', tab, 'Shift'], { env: { CDP_AGENT_ID: 'another-agent' } });
  assert.equal(theirs.code, 5, theirs.stderr);
  assert.match(theirs.stderr, /is claimed by/);
});

t('do - reads the plan from stdin, one step per line, skipping blanks and # comments', async () => {
  const tab = await open('log-table.html?pages=5');
  const r = await run(['do', tab, '-'], { input: 'click "Go to next page"\n\n# then once more\nclick "Go to next page"\n' });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /✓ done: 2\/2 steps/);
  const page = await run(['text', tab, '--match', 'Page \\d of 5']);
  assert.match(page.stdout, /Page 3 of 5/);
  const plan = path.join(TMP, 'plan.txt');
  fs.writeFileSync(plan, 'click "Go to previous page"\n');
  const fromFile = await run(['do', tab, '--file', plan, '-q']);
  assert.deepEqual([fromFile.code, fromFile.stdout], [0, ''], fromFile.stderr);
  assert.match((await run(['text', tab, '--match', 'Page \\d of 5'])).stdout, /Page 2 of 5/);
  const bad = await run(['do', tab, '-'], { input: '\n# nothing\n' });
  assert.equal(bad.code, 2, bad.stderr);
});

t('--collect rows --out FILE streams all 40 pages of a log table, every row once, and ends at the last page', async () => {
  const tab = await open('log-table.html');
  const file = path.join(TMP, 'rows.jsonl');
  const r = await run(['do', tab, '--repeat', 'click "Go to next page"', '--collect', 'rows', '--out', file]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '', 'the report goes to stderr when --out is used');
  assert.match(r.stderr, /collected 1000 rows over 40 pages into /);
  assert.match(r.stderr, /repeated over 40 pages, ended by "Go to next page" is disabled \(the last page\)/);
  const pages = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(pages.map(p => p.page), Array.from({ length: 40 }, (_, i) => i + 1));
  assert.deepEqual(pages[0].columns, ['Time', 'Duration (ms)', 'Query', 'Rows']);
  assert.ok(pages.every(p => p.url.includes('log-table.html')));
  const rows = pages.flatMap(p => p.rows);
  assert.equal(rows.length, 1000);
  const ids = rows.map(row => Number(/id = (\d+)$/.exec(row.Query)?.[1]));
  assert.deepEqual(ids, Array.from({ length: 1000 }, (_, i) => i + 1), 'every row once, in order, no loading rows');
  assert.equal(new Set(rows.map(row => row.Time)).size, 1000);
});

t('--collect text --out - streams JSON lines on stdout with no total cap; a Next that stays enabled ends at the unchanged page', async () => {
  const tab = await open('log-table.html?per=40');
  const r = await run(['do', tab, '--repeat', 'click "Go to next page"', '--collect', 'text', '--out', '-', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const pages = r.stdout.trim().split('\n').map(l => JSON.parse(l));
  assert.equal(pages.length, 40);
  const all = pages.map(p => p.text).join('\n');
  assert.ok(all.length > 20000, `more than the old 20000-character cap: ${all.length}`);
  const seen = new Set([...all.matchAll(/WHERE id = (\d+)/g)].map(m => Number(m[1])));
  for (let i = 1; i <= 1600; i++) assert.ok(seen.has(i), `row ${i} in the text`);
  const report = JSON.parse(r.stderr.slice(r.stderr.indexOf('{')));
  assert.equal(report.done, true);
  assert.equal(report.collected.pages, 40);

  const keep = await open('log-table.html?pages=4&keepnext=1');
  const k = await run(['do', keep, '--repeat', 'click "Go to next page"', '--collect', 'rows', '--out', path.join(TMP, 'keep.jsonl'), '-q']);
  assert.deepEqual([k.code, k.stdout, k.stderr], [0, '', ''], k.stderr);
  const kept = fs.readFileSync(path.join(TMP, 'keep.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(kept.length, 4);
  assert.equal(kept.flatMap(p => p.rows).length, 100);
});

t('a plan stopped by a dialog exits 3, names the dialog and prints the retry with --dismiss', async () => {
  // Jev, as a local endpoint: it sees a blocking overlay.
  const jev = fakeJev({ noul: (q, id) => (id === 'blocker' ? 0.95 : 0.04) });
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const r = await jev.fetchImpl(req.url, { body, headers: req.headers['typesafe-danger-zone-images'] ? { 'TypeSafe-Danger-Zone-Images': 'true' } : {} });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(await r.json()));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const tab = await open('log-table.html?pages=3&modal=1');
    const env = { TYPESAFE_API_KEY: 'fake', BROWSERCTRL_JEV_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1/systemone` };
    const r = await run(['do', tab, '--repeat', 'click "Go to next page"', '--collect', 'rows'], { env });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /Export settings/);
    assert.match(r.stdout, /^retry: browserctrl do \w+ --repeat 'click "Go to next page"' --collect rows --port \d+ --dismiss 'Export settings dialog'/m);
    const q = await run(['do', tab, 'click "Go to next page"', '-q'], { env });
    assert.equal(q.code, 3);
    assert.equal(q.stdout, '');
    assert.match(q.stderr, /✗ stopped at step 1: .*Export settings[\s\S]*retry: .*--dismiss 'Export settings dialog'/);
  } finally { server.close(); }
});

// Phase 2: what real agents kept doing by hand (refs grepped from read, sed over text,
// querySelectorAll in eval, ids cut out of open's JSON, download polling, scrollTop evals).

t('click, fill, select, hover and check take the name a person sees, as a do step finds it', async () => {
  const tab = await open('cli-panes.html');
  const click = await run(['click', tab, 'Save']);
  assert.equal(click.code, 0, click.stdout + click.stderr);
  const r = JSON.parse(click.stdout);
  assert.equal(r.acted, true);
  assert.match(r.target, /button "Save"/);
  assert.match((await run(['text', tab, '--match', '^Saved$'])).stdout, /Saved/);
  const fill = await run(['fill', tab, 'Search', 'aeron chair']);
  assert.equal(fill.code, 0, fill.stdout + fill.stderr);
  const select = await run(['select', tab, 'Country', 'Singapore']);
  assert.equal(select.code, 0, select.stdout + select.stderr);
  const check = await run(['check', tab, 'Remember me']);
  assert.equal(check.code, 0, check.stdout + check.stderr);
  assert.equal(JSON.parse(check.stdout).checked, true);
  const values = await run(['eval', tab, 'JSON.stringify([q.value, country.value, remember.checked])']);
  assert.deepEqual(JSON.parse(values.stdout.trim()), ['aeron chair', 'Singapore', true]);
  // Refs and selectors still work.
  const css = await run(['click', tab, '#remember']);
  assert.equal(css.code, 0, css.stderr);
  // No such control, and no Jev key: the step stops as in do (exit 3) with what is there.
  const missing = await run(['click', tab, 'Export everything']);
  assert.equal(missing.code, 3, missing.stdout + missing.stderr);
  assert.equal(JSON.parse(missing.stdout).acted, false);
  // A control that commits is refused (5) unless --commit.
  const del = await run(['click', tab, 'Delete account']);
  assert.equal(del.code, 5, del.stdout + del.stderr);
  assert.match((await run(['text', tab, '--match', 'deleted|Saved'])).stdout, /^Saved$/m);
  const commit = await run(['click', tab, 'Delete account', '--commit']);
  assert.equal(commit.code, 0, commit.stdout + commit.stderr);
  assert.match((await run(['text', tab, '--match', 'Account deleted'])).stdout, /Account deleted/);
  // An unset shell variable: a usage error, not a click somewhere.
  const empty = await run(['click', tab, '']);
  assert.equal(empty.code, 2, empty.stderr);
  assert.match(empty.stderr, /target is empty/);
});

t('text --region, --from/--to and --tail cut the page text without sed', async () => {
  const tab = await open('cli-panes.html');
  const section = await run(['text', tab, '--region', 'Policy Document']);
  assert.equal(section.code, 0, section.stderr);
  assert.match(section.stdout.trim(), /^Policy Document\nVersion: 1\nStatement: Allow ecs:Describe\*$/);
  assert.match(section.stderr, /heading "policy document"/);
  const main = await run(['text', tab, '--region', 'main']);
  assert.match(main.stdout, /Settings/);
  assert.doesNotMatch(main.stdout, /Footer text|Console home/);
  const range = await run(['text', tab, '--from', 'policy document', '--to', 'Granted to']);
  assert.equal(range.stdout.trim().split('\n').filter(l => l.trim()).length, 5, range.stdout);
  assert.match(range.stdout.trim(), /^Policy Document[\s\S]*Granted to: ops-team$/);
  const tail = await run(['text', tab, '--region', 'Log output', '--tail', '2']);
  assert.equal(tail.stdout.trim(), 'log line 199\nlog line 200');
  const none = await run(['text', tab, '--region', 'Billing history']);
  assert.equal(none.code, 1);
  assert.equal(none.stdout, '');
  assert.match(none.stderr, /Headings: .*"policy document"/);
  const from = await run(['text', tab, '--from', 'no such line', '-q']);
  assert.deepEqual([from.code, from.stdout, from.stderr], [1, '', '']);
});

t('table prints header-keyed rows of div grids and fixed-header tables as TSV, CSV, JSON or JSON lines', async () => {
  const tab = await open('cli-panes.html');
  const tsv = await run(['table', tab]);
  assert.equal(tsv.code, 0, tsv.stderr);
  assert.equal(tsv.stdout.trim(), 'User\tRole\tLast login\nalice\tAdmin\t2026-10-20\nbob\tViewer\t2026-10-21\ncarol\tEditor, Billing\t2026-10-22');
  const csv = await run(['table', tab, '--csv']);
  assert.match(csv.stdout, /^carol,"Editor, Billing",2026-10-22$/m);
  const jsonl = await run(['table', tab, '--jsonl']);
  assert.deepEqual(JSON.parse(jsonl.stdout.trim().split('\n')[1]), { User: 'bob', Role: 'Viewer', 'Last login': '2026-10-21' });
  const log = await open('log-table.html?pages=2&per=5');
  const json = await run(['table', log, '--json']);
  const t2 = JSON.parse(json.stdout);
  assert.deepEqual(t2.columns, ['Time', 'Duration (ms)', 'Query', 'Rows']);
  assert.equal(t2.rows.length, 5);
  assert.equal(t2.rows[4].Query, 'SELECT * FROM orders WHERE id = 5');
  const blank = await open('log-table.html?pages=1&per=0');
  const no = await run(['table', blank, '--selector', '#nothing-here']);
  assert.equal(no.code, 1, no.stdout);
});

t('open --id prints only the id; screenshot, navigate and list are aliases', async () => {
  const id = await run(['open', `${fixture.url}fixtures/cli-panes.html`, '--id']);
  assert.equal(id.code, 0, id.stderr);
  assert.match(id.stdout, /^[0-9A-F]{8}\n$/);
  const tab = id.stdout.trim();
  const file = path.join(TMP, 'shot.png');
  const shot = await run(['screenshot', tab, file]);
  assert.equal(shot.code, 0, shot.stderr);
  assert.ok(fs.statSync(file).size > 1000);
  const nav = await run(['navigate', tab, `${fixture.url}fixtures/log-table.html?pages=1`]);
  assert.equal(nav.code, 0, nav.stderr);
  const list = await run(['list', '--ids']);
  assert.ok(list.stdout.split('\n').includes(tab), list.stdout);
});

t('wait --download prints the path of the file a click downloaded; nothing new exits 1', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'dl-'));
  process.env.CDP_AGENT_ID = BASE_ENV.CDP_AGENT_ID;
  const conn = await connect(TEST_PORT);
  try { await conn.browser('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir }); } finally { conn.close(); }
  const tab = await open('cli-panes.html');
  const click = await run(['click', tab, 'Download CSV']);
  assert.equal(click.code, 0, click.stdout + click.stderr);
  const wait = await run(['wait', '--download', dir, '--timeout', '20000'], { port: null });
  assert.equal(wait.code, 0, wait.stderr);
  assert.equal(wait.stdout.trim(), path.join(dir, 'export.csv'));
  assert.match(fs.readFileSync(wait.stdout.trim(), 'utf8'), /alice,Admin/);
  const none = await run(['wait', '--download', fs.mkdtempSync(path.join(TMP, 'empty-')), '--timeout', '700'], { port: null });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /No download finished/);
});

t('scroll --in scrolls a pane inside the page by its name', async () => {
  const tab = await open('cli-panes.html');
  const down = await run(['scroll', tab, '--in', 'Log output']);
  assert.equal(down.code, 0, down.stderr);
  const d = JSON.parse(down.stdout);
  assert.ok(d.moved > 50 && !d.atEnd, down.stdout);
  const end = JSON.parse((await run(['scroll', tab, '--in', 'Log output', 'end'])).stdout);
  assert.equal(end.atEnd, true);
  const top = JSON.parse((await run(['scroll', tab, '--in', '#log', 'top'])).stdout);
  assert.equal(top.scrollTop, 0);
  const none = await run(['scroll', tab, '--in', 'Comments']);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /Scrollable panes: .*Log output/);
});

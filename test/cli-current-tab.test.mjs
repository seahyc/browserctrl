// Three CLI conveniences, run as the binary against a headless browser: a per-agent current tab
// (use, open, "." and the tab left out), upload by the name a person sees, and do --each-tab.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';
import { fakeJev } from './fake-jev.mjs';
import { placeTab, looksLikeTab } from '../lib/current-tab.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Its own BROWSERCTRL_HOME: claims, current tabs and the daemon socket stay out of the user's.
const HOME = fs.mkdtempSync('/tmp/bc-cur-');
const FILES = fs.mkdtempSync('/tmp/bc-cur-files-');
const BASE_ENV = {
  ...process.env, BROWSERCTRL_HOME: HOME, BROWSERCTRL_AGENT_ID: 'agent-a', BROWSERCTRL_NOTIFY: '0', BROWSERCTRL_NOTES: 'off',
  BROWSERCTRL_JEV_ENV: path.join(HOME, 'no-such-jev.env'),
};
for (const k of ['TYPESAFE_API_KEY', 'BROWSERCTRL_BROWSER', 'BROWSERCTRL_PORT', 'CDP_AGENT_ID']) delete BASE_ENV[k];

function run(args, { input, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/browserctrl.mjs'), ...args, '--port', String(TEST_PORT)],
      { env: { ...BASE_ENV, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

const haveBrowser = Boolean(chromeBinary());
const t = (name, fn) => test(name, { skip: !haveBrowser && 'no Chromium-family browser' }, fn);
let fixture, browser;
before(async () => {
  for (const f of ['cv.pdf', 'a.jpg', 'b.jpg', 'letter.txt']) fs.writeFileSync(path.join(FILES, f), f);
  if (!haveBrowser) return;
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(TEST_PORT);
});
after(async () => {
  if (haveBrowser) await run(['stop']).catch(() => {});
  await browser?.close();
  await fixture?.close();
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(FILES, { recursive: true, force: true });
});

async function open(page, env) {
  const r = await run(['open', `${fixture.url}fixtures/${page}`, '--id'], { env });
  assert.equal(r.code, 0, r.stderr);
  return r.stdout.trim();
}
const bodyData = async (tab, key) => (await run(['eval', tab, `document.body.dataset.${key} || ''`])).stdout.trim().replace(/^"|"$/g, '');

test('a word is the tab only when it reads as one; URLs, names and plan steps never do', () => {
  const placed = (words, aliases) => placeTab(words, { hasCurrent: true, aliases });
  // Left out: the command's own words stay where they were, with "." for the tab.
  assert.deepEqual(placed(['text']), ['text', '.']);
  assert.deepEqual(placed(['nav', 'https://example.com/a']), ['nav', '.', 'https://example.com/a']);
  assert.deepEqual(placed(['key', 'Enter']), ['key', '.', 'Enter']);
  assert.deepEqual(placed(['click', 'Save']), ['click', '.', 'Save']);
  assert.deepEqual(placed(['click', '150', '407']), ['click', '.', '150', '407']);
  assert.deepEqual(placed(['fill', 'Search', 'aeron']), ['fill', '.', 'Search', 'aeron']);
  assert.deepEqual(placed(['do', 'click "Next"', 'key Enter']), ['do', '.', 'click "Next"', 'key Enter']);
  assert.deepEqual(placed(['do', '-']), ['do', '.', '-']);
  assert.deepEqual(placed(['find', 'deadbeef']), ['find', '.', 'deadbeef']); // hex, but no digit: a word
  assert.deepEqual(placed(['upload', 'Resume', 'cv.pdf']), ['upload', '.', 'Resume', 'cv.pdf']);
  assert.deepEqual(placed(['shot', '/tmp/a.png']), ['shot', '.', '/tmp/a.png']);
  // Named: a tab id, ".", a named tab, an alias, or more words than the command takes.
  assert.deepEqual(placed(['text', 'github']), ['text', 'github']);
  assert.deepEqual(placed(['nav', 'A1B2C3D4', 'https://x.test']), ['nav', 'A1B2C3D4', 'https://x.test']);
  assert.deepEqual(placed(['click', 'A1B2C3D4', 'Save']), ['click', 'A1B2C3D4', 'Save']);
  assert.deepEqual(placed(['click', '1a2b3c4d']), ['click', '1a2b3c4d']);
  assert.deepEqual(placed(['fill', 'A1B2C3D4', 'ref_5', 'x']), ['fill', 'A1B2C3D4', 'ref_5', 'x']);
  assert.deepEqual(placed(['do', '.', 'click "Next"']), ['do', '.', 'click "Next"']);
  assert.deepEqual(placed(['do', 'mail', 'click "Next"'], ['mail']), ['do', 'mail', 'click "Next"']);
  assert.deepEqual(placed(['read', 'active']), ['read', 'active']);
  // Without a current tab nothing moves.
  assert.deepEqual(placeTab(['click', 'Save'], { hasCurrent: false }), ['click', 'Save']);
  assert.equal(looksLikeTab('https://a1b2c3d4.example'), false);
  assert.equal(looksLikeTab('click "A1B2C3D4"'), false);
});

t('use and open set this agent’s current tab; "." and a left-out tab use it; claims and closed tabs still refuse', async () => {
  const none = await run(['use']);
  assert.equal(none.code, 1, none.stderr);
  assert.match(none.stderr, /No current tab for agent-a/);
  const dot = await run(['text', '.']);
  assert.equal(dot.code, 2, dot.stderr);
  assert.match(dot.stderr, /agent-a has none/);

  const a = await open('page.html');
  const shown = await run(['use']);
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(shown.stdout.trim(), a, 'open made the new tab current');
  const b = await open('upload-form.html');
  assert.equal((await run(['use'])).stdout.trim(), b);
  const used = await run(['use', a]);
  assert.equal(used.code, 0, used.stderr);
  assert.equal((await run(['use'])).stdout.trim(), a);

  // Left out, ".", or named: each reads the tab it should.
  const title = await run(['eval', 'document.title']);
  assert.equal(title.code, 0, title.stderr);
  assert.equal(title.stdout, (await run(['eval', a, 'document.title'])).stdout);
  const other = await run(['eval', b, 'document.title']);
  assert.equal(other.stdout.trim(), 'Upload form');
  const nav = await run(['nav', `${fixture.url}fixtures/upload-form.html`]);
  assert.equal(nav.code, 0, nav.stderr);
  assert.equal((await run(['eval', '.', 'document.title'])).stdout.trim(), 'Upload form');
  assert.match((await run(['tabs'])).stdout, new RegExp(`${a}.*current`));

  // Another agent's current tab is its own; a tab agent-a holds still refuses agent-b.
  const envB = { BROWSERCTRL_AGENT_ID: 'agent-b' };
  const bNone = await run(['use'], { env: envB });
  assert.equal(bNone.code, 1);
  const refused = await run(['use', a], { env: envB });
  assert.equal(refused.code, 5, refused.stderr);
  assert.match(refused.stderr, /is claimed by/);
  const c = await open('page.html', envB);
  const bAct = await run(['key', 'Tab'], { env: envB });
  assert.equal(bAct.code, 0, bAct.stderr);
  const aOnC = await run(['key', c, 'Tab']);
  assert.equal(aOnC.code, 5, aOnC.stderr);

  // A current tab that was closed is a failure that names it.
  const full = JSON.parse((await run(['use', '--json'])).stdout).targetId;
  await fetch(`http://127.0.0.1:${TEST_PORT}/json/close/${full}`);
  await new Promise(r => setTimeout(r, 300));
  const stale = await run(['text']);
  assert.equal(stale.code, 6, stale.stderr);
  assert.match(stale.stderr, new RegExp(`current tab ${a} .*is closed`));
  // close by this agent forgets it.
  assert.equal((await run(['use', b])).code, 0);
  assert.equal((await run(['close'])).code, 0);
  assert.equal((await run(['use'])).code, 1);
});

t('upload finds the file input by its label, a button beside a hidden input, or Jev; missing files exit 2', async () => {
  const tab = await open('upload-form.html');
  const f = n => path.join(FILES, n);

  const missing = await run(['upload', tab, 'Resume', f('nope.pdf')]);
  assert.equal(missing.code, 2, missing.stderr);
  assert.match(missing.stderr, /File not found: .*nope\.pdf/);
  const folder = await run(['upload', tab, 'Resume', FILES]);
  assert.equal(folder.code, 2, folder.stderr);
  const noFile = await run(['upload', tab, 'Resume']);
  assert.equal(noFile.code, 2, noFile.stderr);

  const byLabel = await run(['upload', tab, 'Resume', f('cv.pdf')]);
  assert.equal(byLabel.code, 0, byLabel.stderr);
  assert.equal(JSON.parse(byLabel.stdout).how, 'exact name');
  assert.equal(await bodyData(tab, 'cv'), 'cv.pdf');

  // A hidden input with its own button: the files go to the input, two of them.
  const byButton = await run(['upload', tab, 'add photos', f('a.jpg'), f('b.jpg')]);
  assert.equal(byButton.code, 0, byButton.stderr);
  assert.equal(JSON.parse(byButton.stdout).target.opens, 'file input');
  assert.equal(await bodyData(tab, 'photo'), 'a.jpg,b.jpg');

  // A wrapping label, through the current tab, with a relative path.
  const rel = path.relative(process.cwd(), f('letter.txt'));
  const wrapped = await run(['upload', 'Cover letter', rel]);
  assert.equal(wrapped.code, 0, wrapped.stderr);
  assert.equal(await bodyData(tab, 'letter'), 'letter.txt');

  // A button that makes its picker on click: the picker is intercepted.
  const picker = await run(['upload', tab, 'Browse files', f('cv.pdf')]);
  assert.equal(picker.code, 0, picker.stderr);
  assert.equal(JSON.parse(picker.stdout).via, 'file picker');
  assert.equal((await run(['eval', tab, "document.getElementById('picked').textContent"])).stdout.trim(), 'cv.pdf');

  // Not an exact name and no Jev key: stop (3) with the controls there are.
  const unsure = await run(['upload', tab, 'my CV', f('cv.pdf')]);
  assert.equal(unsure.code, 3, unsure.stderr);
  const res = JSON.parse(unsure.stdout);
  assert.match(res.reason, /TypeSafe API key/);
  assert.ok(res.upload_controls.some(c => /label "Resume"/.test(c)), res.upload_controls.join('; '));

  // With Jev: its pick among the upload controls.
  const jev = fakeJev({ choice: q => Object.keys(q.criteria).find(k => q.criteria[k].name === 'Resume') || 'none' });
  const server = http.createServer(async (req, rs) => {
    let body = '';
    for await (const ch of req) body += ch;
    const r = await jev.fetchImpl(req.url, { body, headers: {} });
    rs.writeHead(200, { 'Content-Type': 'application/json' });
    rs.end(JSON.stringify(await r.json()));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    await run(['reload', tab]);
    const env = { TYPESAFE_API_KEY: 'fake', BROWSERCTRL_JEV_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1/systemone` };
    const picked = await run(['upload', tab, 'my CV', f('cv.pdf')], { env });
    assert.equal(picked.code, 0, picked.stdout + picked.stderr);
    assert.match(JSON.parse(picked.stdout).how, /^Jev/);
    assert.equal(await bodyData(tab, 'cv'), 'cv.pdf');
  } finally { server.close(); }

  // Refs and selectors still work.
  const bySelector = await run(['upload', tab, '#letter', f('a.jpg')]);
  assert.equal(bySelector.code, 0, bySelector.stderr);
  assert.equal(await bodyData(tab, 'letter'), 'a.jpg');
});

t('do --each-tab runs one plan on each tab, in order or in parallel, and exits 3 when any stopped', async () => {
  const tabs = [await open('upload-form.html'), await open('upload-form.html'), await open('page.html')];
  const both = tabs.slice(0, 2).join(',');
  const seq = await run(['do', '--each-tab', both, 'click "Mark"']);
  assert.equal(seq.code, 0, seq.stdout + seq.stderr);
  assert.match(seq.stdout, new RegExp(`── tab ${tabs[0]}[\\s\\S]*── tab ${tabs[1]}`));
  assert.match(seq.stdout, /^2 tabs: 2 done, 0 stopped$/m);
  assert.deepEqual([await bodyData(tabs[0], 'marks'), await bodyData(tabs[1], 'marks')], ['1', '1']);

  // One tab without the control stops; the others still run; --json is an array, in order.
  const mixed = await run(['do', '--each-tab', tabs.join(','), 'click "Mark"', '--parallel', '9', '--json']);
  assert.equal(mixed.code, 3, mixed.stderr);
  assert.match(mixed.stderr, /capped at 4/);
  const rows = JSON.parse(mixed.stdout);
  assert.deepEqual(rows.map(r => r.tab), tabs);
  assert.deepEqual(rows.map(r => r.done), [true, true, false]);
  assert.equal(rows[2].exit, 3);
  assert.ok(rows[2].stopped?.reason);
  assert.deepEqual([await bodyData(tabs[0], 'marks'), await bodyData(tabs[1], 'marks')], ['2', '2']);

  // all-mine: the tabs this agent holds; another agent's tab is refused, its own still run.
  const envB = { BROWSERCTRL_AGENT_ID: 'agent-b' };
  const theirs = await open('upload-form.html', envB);
  const refused = await run(['do', '--each-tab', `${tabs[0]},${theirs}`, 'click "Mark"']);
  assert.equal(refused.code, 5, refused.stdout + refused.stderr);
  assert.match(refused.stdout, new RegExp(`${theirs}  ✗ refused: .*claimed by`));
  assert.match(refused.stdout, new RegExp(`${tabs[0]}  ✓ done`));
  const mine = await run(['do', '--each-tab', 'all-mine', 'key Tab', '-q']);
  assert.equal(mine.code, 0, mine.stderr);
  assert.equal(mine.stdout, '');
  const quietStop = await run(['do', '--each-tab', tabs.join(','), 'click "Mark"', '-q']);
  assert.equal(quietStop.code, 3);
  assert.match(quietStop.stderr, new RegExp(`✗ ${tabs[2]} stopped at step \\d`));
  const steps = await run(['do', '--each-tab', both, '-'], { input: 'key Tab\nkey Tab\n' });
  assert.equal(steps.code, 0, steps.stderr);
  const typo = await run(['do', '--each-tab', `${tabs[0]},nosuchtab`, 'key Tab']);
  assert.equal(typo.code, 6, typo.stderr);
  assert.match(typo.stderr, /No tab matches "nosuchtab"/);
  const usage = await run(['do', '--each-tab', both, 'key Tab', '--out', '/tmp/x.jsonl']);
  assert.equal(usage.code, 2, usage.stderr);
});

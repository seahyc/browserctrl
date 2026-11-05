// A Cloudflare-style React form (fixtures/react-form.html, real React 18): fill reaches the
// app's state, Cmd+A selects all on macOS, a react-select-style combobox can be chosen from,
// Back and Continue still work after a fill, and a stale ref or a covering dialog stops with
// a reason that says what to do. Rebuilt from failures on dash.cloudflare.com (2026-11-04).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { parseStep } from '../lib/do/parse.mjs';
import { fakeJev } from './fake-jev.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-react-'));
process.env.CDP_AGENT_ID = 'test-react-form';
process.env.BROWSERCTRL_NOTIFY = '0';
process.env.BROWSERCTRL_TRACE = '0';
process.env.BROWSERCTRL_CAPTURE = '0';
process.env.BROWSERCTRL_NOTES = 'off';
process.env.BROWSERCTRL_READ_TOKENS = path.join(MEMO, 'read-tokens.json');
process.env.BROWSERCTRL_SETTLE_MEMORY = path.join(MEMO, 'never.json');
process.env.BROWSERCTRL_SITE_TROUBLE = path.join(MEMO, 'trouble.json');

const haveBrowser = Boolean(chromeBinary());
let fixture, browser, conn;
before(async () => {
  if (!haveBrowser) return;
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => {
  try { conn?.close(); } catch {}
  await browser?.close();
  await fixture?.close();
  fs.rmSync(MEMO, { recursive: true, force: true });
});
const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
const open = async (query = '') => {
  const id = (await ops.newTab(conn, fixture.url + 'fixtures/react-form.html' + (query ? '?' + query : ''))).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  for (const t0 = Date.now(); Date.now() - t0 < 5000;) {
    if (await ops.evaluate(conn, id, `document.querySelector('#state').textContent !== ''`)) break;
    await new Promise(r => setTimeout(r, 50));
  }
  return id;
};
// What React holds, as the app mirrors it.
const state = async (id) => JSON.parse(await ops.evaluate(conn, id, `document.querySelector('#state').textContent`));
const reaches = async (id, pred, ms = 5000) => {
  let s = await state(id);
  for (const t0 = Date.now(); !pred(s) && Date.now() - t0 < ms;) { await new Promise(r => setTimeout(r, 50)); s = await state(id); }
  return s;
};
const quiet = () => fakeJev({ noul: (q, qid) => /expect/.test(qid) ? 0.98 : 0.04 });
const run = async (id, steps, opts = {}) => {
  const r = await runSteps(conn, id, steps, { jev: quiet(), noNotes: true, deadlineMs: 45000, ...opts });
  console.log(formatSteps(r));
  return r;
};
const refOf = (snap, role, name) => snap.elements.find(e => e.role === role && e.name === name)?.ref;
const field = (id) => ops.evaluate(conn, id, `(() => { const e = document.querySelector('[name=api_token_name]'); return { value: e.value, start: e.selectionStart, end: e.selectionEnd }; })()`);

t('fill by ref reaches React state, replacing what was there', async () => {
  const id = await open();
  try {
    const snap = await ops.readPage(conn, id, { maxText: 0 });
    const ref = refOf(snap, 'textbox', 'Token name');
    assert.ok(ref, 'the token name field has a ref');
    await ops.fill(conn, id, { ref, token: snap.token, value: 'first-name' });
    assert.equal((await reaches(id, s => s.name === 'first-name')).name, 'first-name');
    await ops.fill(conn, id, { ref, token: snap.token, value: 'cfw-token-admin' });
    assert.equal((await reaches(id, s => s.name === 'cfw-token-admin')).name, 'cfw-token-admin');
    await ops.fill(conn, id, { ref, token: snap.token, value: '' });
    assert.equal((await reaches(id, s => s.name === '')).name, '');
  } finally { await ops.closeTab(conn, id); }
});

t('fill that cannot type (input not delivered) still updates React through the native setter', async () => {
  const id = await open();
  try {
    // Swallow the typed text, as a background tab that takes no input does: the fallback sets
    // the value with the prototype setter and fires input, which React's onChange sees.
    await ops.evaluate(conn, id, `document.querySelector('[name=api_token_name]').addEventListener('beforeinput', e => e.preventDefault(), true)`);
    const r = await ops.fill(conn, id, { selector: '[name=api_token_name]', value: 'via-setter' });
    assert.equal(r.typed, false, JSON.stringify(r));
    assert.equal((await reaches(id, s => s.name === 'via-setter')).name, 'via-setter');
  } finally { await ops.closeTab(conn, id); }
});

t('Meta+a selects all in a text input, so Backspace clears it and type replaces it', async () => {
  const id = await open();
  try {
    await ops.fill(conn, id, { selector: '[name=api_token_name]', value: 'old-token-name' });
    await reaches(id, s => s.name === 'old-token-name');
    await ops.evaluate(conn, id, `(() => { const e = document.querySelector('[name=api_token_name]'); e.focus(); e.setSelectionRange(3, 3); })()`);
    await ops.key(conn, id, 'Meta+a');
    assert.deepEqual(await field(id), { value: 'old-token-name', start: 0, end: 'old-token-name'.length });
    await ops.key(conn, id, 'Backspace');
    assert.equal((await reaches(id, s => s.name === '')).name, '');
    await ops.type(conn, id, 'new');
    assert.equal((await reaches(id, s => s.name === 'new')).name, 'new');
    // cmd+a, the other spelling, and Ctrl+A where it is the platform's select-all.
    await ops.key(conn, id, 'cmd+a');
    assert.equal((await field(id)).end - (await field(id)).start, 3);
  } finally { await ops.closeTab(conn, id); }
});

t('a whole Create Token pass: fill, two react-select comboboxes, Continue, Back, change the name, Continue again', async () => {
  const id = await open();
  try {
    const r1 = await run(id, ['fill "Token name" = "cfw-token-admin"', 'select "Permissions" = "Workers Scripts"', 'select "Permissions levels" = "Read"', 'click "Continue to summary" => "Token Summary"']);
    assert.equal(r1.done, true, JSON.stringify(r1.stopped));
    assert.deepEqual(await reaches(id, s => s.step === 'summary'), { step: 'summary', name: 'cfw-token-admin', perm: 'Workers Scripts', level: 'Read', error: '', continues: 1 });
    const r2 = await run(id, ['click "Back"', 'fill "Token name" = "cfw-token-two"', 'click "Continue to summary" => "Token Summary"']);
    assert.equal(r2.done, true, JSON.stringify(r2.stopped));
    const s = await reaches(id, x => x.step === 'summary' && x.name === 'cfw-token-two');
    assert.equal(s.name, 'cfw-token-two');
    assert.equal(s.continues, 2);
  } finally { await ops.closeTab(conn, id); }
});

t('typing into a react-select combobox filters it, and Enter picks the match', async () => {
  const id = await open();
  try {
    const r = await run(id, ['click "Permissions"', 'type "R2"', 'key Enter']);
    assert.equal(r.done, true, JSON.stringify(r.stopped));
    assert.equal((await reaches(id, s => s.perm === 'Workers R2 Storage')).perm, 'Workers R2 Storage');
  } finally { await ops.closeTab(conn, id); }
});

t('a click under a modal quick-search dialog is refused with how to close it, and a do plan resumes with the reason', async () => {
  const id = await open('overlay=1');
  try {
    const snap = await ops.readPage(conn, id, { maxText: 0 });
    const ref = refOf(snap, 'button', 'Continue to summary');
    await ops.key(conn, id, 'Meta+k');
    await reaches(id, () => true, 100);
    assert.ok(await ops.evaluate(conn, id, `Boolean(document.querySelector('[role=dialog]'))`), 'Cmd+K opened the quick search');
    await assert.rejects(ops.click(conn, id, { ref, token: snap.token }), (e) => {
      assert.equal(e.code, 'covered');
      assert.match(e.message, /key \S+ Escape/, e.message);
      return true;
    });
    const r = await run(id, [`click ${ref}`], { refToken: snap.token });
    assert.equal(r.done, false);
    const resume = formatSteps(r).split('\n').find(l => /^resume:/.test(l)) || '';
    assert.match(resume, /# stopped: .*(cover|dialog|popup)/i, formatSteps(r));
    await ops.key(conn, id, 'Escape');
    assert.equal(await ops.evaluate(conn, id, `Boolean(document.querySelector('[role=dialog]'))`), false, 'Escape closed it');
  } finally { await ops.closeTab(conn, id); }
});

t('a ref whose element React removed stops with the reason on the resume line', async () => {
  const id = await open();
  try {
    const snap = await ops.readPage(conn, id, { maxText: 0 });
    const ref = refOf(snap, 'button', 'Continue to summary');
    // Back unmounts the whole form; Get started mounts a new one.
    await ops.evaluate(conn, id, `[...document.querySelectorAll('button')].find(b => b.textContent === 'Back').click()`);
    await reaches(id, s => s.step === 'start');
    const r = await run(id, [`click ${ref}`], { refToken: snap.token });
    assert.equal(r.done, false);
    const report = formatSteps(r);
    assert.match(r.stopped.reason, new RegExp(`${ref} \\(button "Continue to summary" when read\\) is not on the page any more \\(detached: the page removed or redrew it`), r.stopped.reason);
    const resume = report.split('\n').find(l => /^resume:/.test(l));
    assert.match(resume, /'click "Continue to summary"' {3}# by the name ref_\d+ had when read$/, report);
  } finally { await ops.closeTab(conn, id); }
});

t('fill and select steps take the value without "=" after a ref or selector', () => {
  assert.deepEqual(parseStep('fill ref_14 "x"'), { action: 'fill', target: 'ref_14', value: 'x', ref: 'ref_14' });
  assert.deepEqual(parseStep('fill "Token name" "cfw"'), { action: 'fill', target: 'Token name', value: 'cfw' });
  assert.deepEqual(parseStep('select ref_3 "Read"'), { action: 'select', target: 'ref_3', value: 'Read', ref: 'ref_3' });
  assert.equal(parseStep('fill ref_14 = cfw-token-admin').value, 'cfw-token-admin');
  assert.throws(() => parseStep('fill the token name'), /fill ref_14 = "text"|fill "<field>" = "<value>"/);
});

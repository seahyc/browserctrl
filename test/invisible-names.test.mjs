// A name made only of invisible characters (zero-width space, BOM, ...) is no name: the next
// source (label, own text, row text) supplies one, and invisible characters inside a visible
// name are dropped.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import * as finder from '../lib/find.mjs';
import { runSteps } from '../lib/steps.mjs';
import { fakeJev } from './fake-jev.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-memo-'));
process.env.CDP_AGENT_ID = 'test-invisible-names';
process.env.BROWSERCTRL_NOTIFY = '0';
process.env.BROWSERCTRL_TRACES = TRACES;
process.env.BROWSERCTRL_NOTES = 'off';
process.env.BROWSERCTRL_READ_TOKENS = path.join(MEMO, 'read-tokens.json');
process.env.BROWSERCTRL_SETTLE_MEMORY = path.join(MEMO, 'never.json');
process.env.BROWSERCTRL_SITE_TROUBLE = path.join(MEMO, 'trouble.json');

const haveBrowser = Boolean(chromeBinary());
let fixture, browser, conn;
before(async () => {
  if (!haveBrowser) return;
  delete process.env.TYPESAFE_API_KEY;
  process.env.BROWSERCTRL_JEV_ENV = path.join(os.tmpdir(), 'no-such-jev.env');
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => {
  try { conn?.close(); } catch {}
  await browser?.close();
  await fixture?.close();
  fs.rmSync(TRACES, { recursive: true, force: true });
  fs.rmSync(MEMO, { recursive: true, force: true });
});
const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
const open = async () => {
  const id = (await ops.newTab(conn, fixture.url + 'fixtures/invisible-names.html')).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  return id;
};

t('read names controls by their visible label when the aria-label is only invisible characters', async () => {
  const id = await open();
  const snap = await ops.readPage(conn, id);
  const names = snap.elements.map(e => `${e.role}|${e.name}`);
  assert.ok(snap.elements.some(e => e.tag === 'input' && e.name === 'Gitlab Diff Link'), names.join('\n'));
  assert.ok(snap.elements.some(e => e.tag === 'input' && e.name === 'Release Notes'), names.join('\n'));
  assert.ok(snap.elements.some(e => e.tag === 'button' && e.name === 'Submit request'), names.join('\n'));
  assert.ok(snap.elements.some(e => e.tag === 'button' && e.name === 'Save'), names.join('\n'));
  // No name carries an invisible character, and the icon-less ghost button stays unnamed.
  for (const e of snap.elements) assert.doesNotMatch(e.name || '', /[​-‍⁠﻿­]/, JSON.stringify(e));
  const ghost = snap.elements.filter(e => e.tag === 'button' && e.borrowed);
  assert.equal(ghost.length, 1, names.join('\n'));
  assert.match(ghost[0].name, /\(unnamed button\)$/);
});

t('find and fields name them the same way', async () => {
  const id = await open();
  const found = await ops.evaluate(conn, id, finder.FIND('Gitlab|Release|Submit|Save'));
  const text = JSON.stringify(found);
  for (const n of ['Gitlab Diff Link', 'Release Notes', 'Submit request', 'Save']) assert.ok(text.includes(n), `${n} in ${text}`);
  assert.doesNotMatch(text, /\\u200b|\\ufeff/i);
  const fields = JSON.stringify(await ops.evaluate(conn, id, finder.FIELDS()));
  assert.ok(fields.includes('Release Notes') && !/\\u200b/i.test(fields), fields);
});

t('fill by exact visible name fills the field with no Jev choice', async () => {
  const id = await open();
  const jev = fakeJev();
  const r = await runSteps(conn, id, ['fill "Gitlab Diff Link" = "https://example.test/diff"'], { jev, noNotes: true });
  assert.equal(r.ok ?? !r.stopped, true, JSON.stringify(r));
  assert.equal(await ops.evaluate(conn, id, 'document.getElementById("diff").value'), 'https://example.test/diff');
  // The page-state checks may ask Jev; choosing the control must not.
  const picks = jev.calls.flatMap(c => Object.values(c.questions)).filter(q => q.type === 'choice');
  assert.equal(picks.length, 0, JSON.stringify(picks));
  await runSteps(conn, id, ['fill "Release Notes" = "ship it"'], { jev: fakeJev(), noNotes: true });
  assert.equal(await ops.evaluate(conn, id, 'document.getElementById("x").value'), 'ship it');
});

test('cleanName trims invisible characters at the ends only; a name of nothing else is empty', async () => {
  const { cleanName } = await import('../lib/page/shared.mjs');
  assert.equal(cleanName('​'), '');
  assert.equal(cleanName(' ​﻿  '), '');
  assert.equal(cleanName('Save​'), 'Save');
  assert.equal(cleanName('⁠ Gitlab Diff Link ​'), 'Gitlab Diff Link');
  // Inside a word they spell something: Persian's zero-width non-joiner, an emoji's joiner.
  assert.equal(cleanName('می‌خواهم'), 'می‌خواهم');
  assert.equal(cleanName('Family \u{1F468}‍\u{1F469}‍\u{1F467}'), 'Family \u{1F468}‍\u{1F469}‍\u{1F467}');
  assert.equal(cleanName(null), '');
});

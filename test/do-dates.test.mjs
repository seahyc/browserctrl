// Date steps: calendar labels in many formats, pickers that open late or close on their own, and
// calendars that confirm a pick in different ways or not at all.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { runSteps, formatSteps, parseDateText } from '../lib/steps.mjs';
import { fakeJev, planJev } from './fake-jev.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-memo-'));
process.env.CDP_AGENT_ID = 'test-do-dates';
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
const url = (page) => fixture.url + 'fixtures/' + page;
const open = async (page, waitUntil = 'load') => {
  const id = (await ops.newTab(conn, url(page))).targetId;
  await ops.waitForReady(conn, id, { waitUntil });
  return id;
};
const text = (id, sel) => ops.evaluate(conn, id, `document.querySelector(${JSON.stringify(sel)}).textContent`);
const outState = async (id) => Object.fromEntries(String(await ops.evaluate(conn, id, 'document.querySelector("#out").dataset.s || ""')).split(';').filter(Boolean).map(x => x.split('=')));
const run = async (id, steps) => { const r = await runSteps(conn, id, steps, { jev: fakeJev(), noNotes: true }); console.log(formatSteps(r)); return r; };

test('calendar labels parse in every common format', () => {
  const want = { y: 2026, m: 10, d: 16 };
  for (const s of ['Friday, 16 October 2026', 'Oct 16, 2026', 'Fri Oct 16 2026', '16, Friday, October 2026. Available. Select as check-in date.',
    '2026-10-16', '10/16/2026', 'calendar-day-10/16/2026', 'October 16th, 2026']) assert.deepEqual(parseDateText(s), want, s);
  assert.equal(parseDateText('When Add dates'), null);
  assert.equal(parseDateText('Fri, Oct 16'), null, 'no year: not a whole date');
});

t('a date step pages the calendar to the day and refuses unavailable days', async () => {
  const id = await open('steps-friction.html');
  const jev = planJev();
  const r = await runSteps(conn, id, ['click "When Add dates"', 'date 2026-12-03'], { jev: jev });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(r.steps[1].how, /date, paged 2 months/);
  assert.equal(await text(id, '#picked'), 'Picked Thursday, 3 December 2026');
  // A click that names a whole date in another format finds the cell too, paging back.
  const r2 = await runSteps(conn, id, ['click "Oct 16, 2026"'], { jev: jev });
  assert.equal(r2.done, true, JSON.stringify(r2.stopped));
  assert.equal(await text(id, '#picked'), 'Picked Friday, 16 October 2026');
  const r3 = await runSteps(conn, id, ['date 2026-10-05'], { jev: jev });
  assert.match(r3.stopped.reason, /not available/);
  assert.equal(jev.calls.filter(c => c.questions.target).length, 0);
  await ops.closeTab(conn, id);
});

t('a date step waits for the picker to open and reads day cells by their text', async () => {
  const id = await open('steps-friction2.html');
  const jev = planJev({}, { near: true });
  const r = await runSteps(conn, id, ['click "Pick dates"', 'date 2026-11-16'], { jev: jev });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(r.steps[1].how, /date, paged 1 month/);
  assert.equal(await text(id, '#picked'), 'Picked November 16, 2026');
  await ops.closeTab(conn, id);
});

t('a date step reopens a date picker the previous click closed', async () => {
  const id = await open('steps-friction3.html');
  // The picker opens on load. Mid-plan, a click on its open control would be skipped (it is
  // already open), so close it as a plan's last step, then ask for a date.
  await runSteps(conn, id, ['click "When Add dates"'], { jev: planJev(), noNotes: true });
  const r = await runSteps(conn, id, ['date 2026-10-17'], { jev: planJev(), noNotes: true });
  console.log(formatSteps(r));
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(r.steps[0].how, /opened "When Add dates"/);
  assert.equal(await text(id, '#picked'), 'Picked October 17, 2026');
  await ops.closeTab(conn, id);
});

for (const mode of ['aria', 'class', 'closes', 'hidden', 'numbers']) {
  t(`a date pick is confirmed when the calendar shows it (${mode})`, async () => {
    const id = await open(`?cal=${mode}`);
    const steps = mode === 'closes' ? ['click "Arrival"', 'date 2026-10-17'] : ['date 2026-10-17'];
    const r = await run(id, steps);
    assert.equal(r.done, true, JSON.stringify(r.stopped));
    assert.equal((await outState(id)).picked, '2026-10-17');
    await ops.closeTab(conn, id);
  });
}

t('a date click the calendar ignores stops instead of passing as done', async () => {
  const id = await open('?cal=dead');
  const r = await run(id, ['date 2026-10-17']);
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /doesn't show it selected/);
  await ops.closeTab(conn, id);
});

t('a collapsed control that opens a dialog with a grid is opened for a date step, whatever its words', async () => {
  const id = await open('?cal=opener');
  const r = await run(id, ['date 2026-10-17']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(r.steps[0].how, /opened/);
  await ops.closeTab(conn, id);
});

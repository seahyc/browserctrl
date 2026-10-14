// A plan runs in one call: exact names need no model, results that render late are
// waited for, and anything uncertain or committing stops the plan.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { parseStep, runSteps } from '../lib/steps.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

test('steps parse into action, target and value', () => {
  assert.deepEqual(parseStep('fill "the search box" = "herman miller aeron"'), { action: 'fill', target: 'the search box', value: 'herman miller aeron' });
  assert.deepEqual(parseStep('click More filters'), { action: 'click', target: 'More filters' });
  assert.deepEqual(parseStep('select Sort = Price - Low to High'), { action: 'select', target: 'Sort', value: 'Price - Low to High' });
  assert.deepEqual(parseStep('key Enter'), { action: 'key', target: 'Enter' });
  assert.throws(() => parseStep('buy everything'), /Unknown step/);
  assert.throws(() => parseStep('fill "box"'), /fill <target> = <value>/);
});

const haveBrowser = Boolean(chromeBinary());
let fixture, browser, conn;
before(async () => {
  if (!haveBrowser) return;
  // No model in these tests: exact names must carry the plan on their own.
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
});
const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
const open = async () => {
  const id = (await ops.newTab(conn, fixture.url + 'fixtures/steps-form.html')).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  return id;
};

t('a search-filter plan runs in one call and waits for late results', async () => {
  const id = await open();
  const r = await runSteps(conn, id, ['fill Search = aeron', 'key Enter', 'click "More filters"', 'fill Maximum = 600', 'click Apply'], { then: 'text' });
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.ok(r.steps.filter(s => s.target).every(s => s.how === 'exact'));
  assert.match(r.text, /Aeron A · S\$380/);
  assert.match(r.text, /Aeron B · S\$580/);
  assert.doesNotMatch(r.text, /Aeron C|Chair D/);
  await ops.closeTab(conn, id);
});

t('a committing control stops the plan even when named exactly', async () => {
  const id = await open();
  const r = await runSteps(conn, id, ['click "Buy now"']);
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /can commit something/);
  await ops.closeTab(conn, id);
});

t('a step that needs Jev stops cleanly when no key is configured', async () => {
  const id = await open();
  const r = await runSteps(conn, id, ['fill "the box for the product name" = aeron']);
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /TYPESAFE_API_KEY/);
  await ops.closeTab(conn, id);
});

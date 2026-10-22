import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { judgment, retryContent, settleJudgment } from '../lib/do/judgments.mjs';

process.env.BROWSERCTRL_CAPTURE = '0';
let browser, conn;
before(async () => {
  if (!chromeBinary()) return;
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => {
  try { await conn?.stop(); } finally { conn?.close(); await browser?.close(); }
});
const step = { action: 'extract', target: 'the first available date' };
const none = { extract: { type: 'choice', choice: 'none', probabilities: { none: 1 } } };

test('extraction offers complete headings and informative control names with sources', { skip: !chromeBinary() }, async () => {
  const tab = (await ops.newTab(conn, 'about:blank')).targetId;
  try {
    await ops.evaluate(conn, tab, `document.body.innerHTML = '<h2><span>Showing 1-15</span><div>of 277 results</div></h2><button aria-label="11 Mar 2027 - Site E101 is available">11</button><button aria-label="2">next</button><button aria-label="Open calendar">Open</button><div role="heading"><span>Showing 1-20</span><div>of 888 results</div></div><span id="date-name" hidden>13 Mar 2027 - Site E103 is available</span><button aria-labelledby="date-name" aria-label="Wrong 14 Mar 2027">13</button><button hidden aria-label="12 Mar 2027 - Site E102 is available">12</button>'`);
    const j = await judgment({ conn, tab }, step);
    assert.equal(j.spans.find(s => s.text === 'Showing 1-20 of 888 results')?.source_attribute, 'heading');
    assert.equal(j.spans.find(s => s.text === '13 Mar 2027 - Site E103 is available')?.source_attribute, 'aria-labelledby');
    assert.ok(!j.spans.some(s => s.text === 'Wrong 14 Mar 2027'));
    const heading = j.spans.find(s => s.text === 'Showing 1-15 of 277 results');
    assert.equal(heading?.source_attribute, 'heading');
    assert.equal(j.spans.find(s => s.text === '11 Mar 2027 - Site E101 is available')?.source_attribute, 'aria-label');
    assert.ok(!j.spans.some(s => s.text === '2' || s.text === 'Open calendar' || s.text === '12 Mar 2027 - Site E102 is available'));
    const index = j.spans.findIndex(s => s.text === '11 Mar 2027 - Site E101 is available');
    const row = { step: 1 }, choice = `l${index + 1}`;
    await settleJudgment({ view: {}, report: {} }, step, row, j, { extract: { type: 'choice', choice, probabilities: { [choice]: 1 } } });
    assert.equal(row.extracted.value, '11 Mar 2027 - Site E101 is available');
    assert.equal(row.extracted.source_attribute, 'aria-label');
  } finally { await ops.closeTab(conn, tab); }
});

test('loaded unchanged extraction avoids late-content wait even on a young document', { skip: !chromeBinary() }, async () => {
  const tab = (await ops.newTab(conn, 'about:blank')).targetId;
  try {
    await ops.evaluate(conn, tab, `document.body.innerHTML = '<p>No dates available</p>'`);
    const ctx = { conn, tab, view: {}, deadline: Date.now() + 10000, ask: async () => ({ answers: none, ms: 0 }) };
    const j = await judgment(ctx, step), row = {};
    const start = Date.now();
    await retryContent(ctx, step, row, j, structuredClone(none));
    console.log('unchanged extraction timing', JSON.stringify({ wall: Date.now() - start, wait: row.content_wait_ms || 0 }));
    assert.equal(row.content_wait_ms, undefined);
  } finally { await ops.closeTab(conn, tab); }
});

test('changed extraction retries once with a bounded quiet wait', { skip: !chromeBinary() }, async () => {
  const tab = (await ops.newTab(conn, 'about:blank')).targetId;
  try {
    await ops.evaluate(conn, tab, `document.body.innerHTML = '<p>Checking dates</p>'`);
    let calls = 0;
    const ctx = { conn, tab, view: {}, deadline: Date.now() + 10000, ask: async () => { calls++; return { answers: none, ms: 0 }; } };
    const j = await judgment(ctx, step), row = {};
    await ops.evaluate(conn, tab, `document.body.innerHTML += '<p>11 Mar 2027 is available</p>'`);
    const start = Date.now();
    await retryContent(ctx, step, row, j, structuredClone(none));
    console.log('changed extraction timing', JSON.stringify({ wall: Date.now() - start, wait: row.content_wait_ms || 0 }));
    assert.equal(calls, 1);
    assert.ok(row.content_wait_ms < 1800);
    assert.ok(j.spans.some(s => s.text === '11 Mar 2027 is available'));
  } finally { await ops.closeTab(conn, tab); }
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { judgment } from '../lib/do/judgments.mjs';

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

test('result-count heading is offered as evidence and allowed to answer extraction', { skip: !chromeBinary() }, async () => {
  const tab = (await ops.newTab(conn, 'about:blank')).targetId;
  try {
    await ops.evaluate(conn, tab, `document.body.innerHTML = '<main><h2>Showing <span>1-15</span> of <strong>615</strong> results</h2><p>Search tours</p></main>'`);
    const result = await judgment({ conn, tab }, { action: 'extract', target: 'number of results' });
    assert.ok(result.spans.some(span => span.text === 'Showing 1-15 of 615 results'));
    assert.doesNotMatch(result.question.instructions, /not a heading[,;]/);
    assert.match(result.question.instructions, /heading.*(?:value|answer)/i);
  } finally { await ops.closeTab(conn, tab); }
});

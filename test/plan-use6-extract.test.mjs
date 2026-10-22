import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { page } from '../lib/page/index.mjs';
import { judgment } from '../lib/do/judgments.mjs';
import { shortlistSpans, EXTRACT_MAX_LINES } from '../lib/judge.mjs';
process.env.BROWSERCTRL_CAPTURE = '0';
let browser, conn;
const haveBrowser = Boolean(chromeBinary());
before(async () => { if (haveBrowser) { browser = await startHeadlessBrowser(TEST_PORT); conn = await connect(TEST_PORT); } });
after(async () => { try { await conn?.stop(); } finally { conn?.close(); await browser?.close(); } });
const fixture = fs.readFileSync(new URL('./fixtures/plan-use6-extract.html', import.meta.url), 'utf8');
test('extraction offers the same joined delivery card as items', { skip: !haveBrowser }, async () => {
  const tab = (await ops.newTab(conn, 'about:blank')).targetId;
  try {
    await ops.evaluate(conn, tab, `document.documentElement.innerHTML = ${JSON.stringify(fixture)}`);
    const result = await judgment({ conn, tab, view: {} }, { action: 'extract', target: 'FedEx Ground rate' });
    const card = result.spans.find(s => s.source === 'item' && /FedEx Ground®/.test(s.text) && /\$50\.59/.test(s.text));
    assert.ok(card, 'label and price must be offered together as an item candidate');
    assert.equal(card.structured, true);
    assert.match(card.text, / · /);
    assert.ok(card.text.length <= 220);
  } finally { await ops.closeTab(conn, tab); }
});
test('question content words outrank unrelated structured and contextual lines at the cap', () => {
  const unrelated = Array.from({ length: 1200 }, (_, i) => ({ text: `Unrelated catalog entry ${i}`, structured: true, heading: 'Catalog' }));
  const available = Array.from({ length: 280 }, (_, i) => ({ text: `${i + 1} Mar 2027 - Site E${i} is available`, source_attribute: 'aria-label', structured: true }));
  const selected = shortlistSpans([...unrelated, ...available], 'the first available date');
  assert.equal(selected.length, EXTRACT_MAX_LINES);
  assert.ok(selected.every(s => s.text.includes('is available')), 'content matches must precede unrelated reserved or sampled lines');
});
test('crowded grid exposes names as structured evidence and reserves newly appeared controls', { skip: !haveBrowser }, async () => {
  const tab = (await ops.newTab(conn, 'about:blank')).targetId;
  const name = '2 Mar 2027 - Site E101 is available';
  try {
    await ops.evaluate(conn, tab, `document.documentElement.innerHTML = ${JSON.stringify(fixture)}; document.querySelector('#grid').innerHTML = Array.from({length:1480}, (_,i) => '<button aria-label="'+(i===1301?${JSON.stringify(name)}:'Site '+i+' unavailable')+'">'+i+'</button>').join('')`);
    const spans = await ops.evaluate(conn, tab, page('extract-spans', {}));
    assert.ok(spans.some(s => s.text === name && s.structured));
    const result = await judgment({ conn, tab, view: {}, previousNewControlNames: [name] }, { action: 'extract', target: 'the first available date' });
    assert.ok(result.spans.some(s => s.text === name && s.recent_control));
  } finally { await ops.closeTab(conn, tab); }
});
test('extraction detects an in-place grid redraw after the previous step snapshot', { skip: !haveBrowser }, async () => {
  const tab = (await ops.newTab(conn, 'about:blank')).targetId;
  const name = '2 Mar 2027 - Site E101 is available';
  try {
    await ops.evaluate(conn, tab, `document.documentElement.innerHTML = ${JSON.stringify(fixture)}; document.querySelector('#grid').innerHTML = '<button aria-label="Site E101 unavailable">2</button>'`);
    const previousControlNames = await ops.evaluate(conn, tab, page('control-names', {}));
    await ops.evaluate(conn, tab, `document.querySelector('#grid button').setAttribute('aria-label', ${JSON.stringify(name)})`);
    const result = await judgment({ conn, tab, view: {}, previousControlNames, previousNewControlNames: [] }, { action: 'extract', target: 'the first available date' });
    assert.ok(result.spans.some(s => s.text === name && s.recent_control), 're-read names to catch a redraw after the last snapshot');
  } finally { await ops.closeTab(conn, tab); }
});

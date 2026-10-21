import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { page } from '../lib/page/index.mjs';
import { shortlistSpans } from '../lib/judge.mjs';

const haveBrowser = Boolean(chromeBinary());
let browser, conn;
before(async () => {
  if (!haveBrowser) return;
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => {
  try { await conn?.stop(); } finally {
    conn?.close();
    await browser?.close();
  }
});
const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
async function spans(html) {
  const tab = (await ops.newTab(conn, 'about:blank')).targetId;
  try {
    await ops.evaluate(conn, tab, `document.body.innerHTML = ${JSON.stringify(html)}`);
    return await ops.evaluate(conn, tab, page('extract-spans', {}));
  } finally { await ops.closeTab(conn, tab); }
}

t('visible release href tags remain structured facts inside prose headings', async () => {
  const result = await spans('<h2><a href="/releases/tag/v7.8.9">Release 7.8.9, July 12, 2025 <span>Latest</span></a></h2>');
  const tag = result.find(span => span.source_attribute === 'href');
  assert.ok(tag, 'visible version matching href must produce a tag span');
  assert.equal(tag.text, 'v7.8.9');
  assert.equal(tag.structured, true);
  assert.equal(tag.heading, 'Release 7.8.9, July 12, 2025 Latest');
  const noise = Array.from({ length: 400 }, (_, i) => `release notes unrelated item ${i}`);
  const selected = shortlistSpans([...noise.slice(0, 137), ...result, ...noise.slice(137)], 'the latest release tag', 1800);
  assert.ok(selected.some(span => span.text === 'v7.8.9' && span.source_attribute === 'href'), 'structured tag must survive a crowded shortlist');
});

t('href versions require the same visible link version', async () => {
  const result = await spans(`
    <a href="/releases/tag/v7.8.9">Release 7.8.10</a>
    <a href="/releases/tag/v8.9.0">Read the release notes</a>
    <a href="/releases/tag/v9.0.1"><span style="display:none">9.0.1</span>Read more</a>
  `);
  assert.equal(result.filter(span => span.source_attribute === 'href').length, 0);
});

t('hidden links do not expose their version tags or text', async () => {
  const result = await spans(`
    <a style="display:none" href="/releases/tag/v7.8.9">v7.8.9</a>
    <a style="visibility:hidden" href="/releases/tag/v8.9.0">v8.9.0</a>
    <div style="display:none"><a href="/releases/tag/v9.0.1">v9.0.1</a></div>
    <p>Visible content</p>
  `);
  assert.equal(result.filter(span => span.source_attribute === 'href').length, 0);
  assert.ok(!result.some(span => /7\.8\.9|8\.9\.0|9\.0\.1/.test(span.text)));
});

t('plain version links and matching prerelease suffixes preserve observed href tags', async () => {
  const result = await spans(`
    <a href="/tags/v7.8.9?download=1#notes">v7.8.9</a>
    <a href="/tags/8.9.0-rc.1">v8.9.0-rc.1</a>
    <a href="/tags/v9.0.1">9.0.1-rc.1</a>
  `);
  assert.deepEqual(result.filter(span => span.source_attribute === 'href').map(({ text, structured }) => ({ text, structured })), [
    { text: 'v7.8.9', structured: true },
    { text: '8.9.0-rc.1', structured: true },
  ]);
});

t('star oracle handles both statistics and signed-in fact-link layouts', async () => {
  const cases = JSON.parse(fs.readFileSync(new URL('../bench/extract-eval/cases.json', import.meta.url)));
  const oracle = cases.find(c => c.id === 'browserctrl-stars').expect;
  for (const html of [
    '<span class="socialStat"><svg class="octicon-star"></svg><strong>8.7k</strong></span>',
    '<button>Unstar 9k</button><a href="/seahyc/browserctrl/stargazers">8.7k stars</a>',
  ]) {
    const tab = (await ops.newTab(conn, 'about:blank')).targetId;
    try {
      await ops.evaluate(conn, tab, `document.body.innerHTML = ${JSON.stringify(html)}`);
      const observed = await ops.evaluate(conn, tab, `document.querySelector(${JSON.stringify(oracle.selector)}).textContent`);
      assert.equal(observed.match(new RegExp(oracle.capture))[1], '8.7k');
    } finally { await ops.closeTab(conn, tab); }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { FIND, PAGE_STATE_FOR_DIFF } from '../lib/find.mjs';
import { page } from '../lib/page/index.mjs';
import { chromeBinary, startHeadlessBrowser, TEST_PORT } from './helpers.mjs';

test('ordinary page diagnostics never return password values', { skip: !chromeBinary(), timeout: 60000 }, async t => {
  const canary = 'SYNTHETIC_PASSWORD_CANARY_' + 'long-value-'.repeat(9);
  const transformed = canary + '::page-transformed';
  const html = `<!doctype html><label for="pw">Password</label><input id="pw" type="password" value="${canary}">
    <input id="unnamed" type="password"><label for="text">Search</label><input id="text" value="ordinary-text-value">`;
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await startHeadlessBrowser(TEST_PORT);
  const conn = await connect(TEST_PORT);
  let id;
  t.after(async () => {
    try { if (id) await ops.closeTab(conn, id); } catch {}
    conn.close();
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  });

  id = (await ops.newTab(conn, `http://127.0.0.1:${server.address().port}/`)).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  await ops.evaluate(conn, id, `(()=>{document.querySelector('#pw').value=${JSON.stringify(transformed)};document.querySelector('#unnamed').value=${JSON.stringify(transformed)};})()`);

  const state = await ops.evaluate(conn, id, PAGE_STATE_FOR_DIFF);
  const find = await ops.evaluate(conn, id, FIND('Password|Search', { pin: true }));
  const findCanary = await ops.evaluate(conn, id, FIND(canary));
  const showsPassword = await ops.evaluate(conn, id, page('control-shows', { selector: '#pw' }));
  const showsText = await ops.evaluate(conn, id, page('control-shows', { selector: '#text' }));
  const returned = JSON.stringify({ state, find, findCanary, showsPassword });

  const safeReturned = returned.replaceAll(transformed, '[TRANSFORMED]').replaceAll(canary, '[CANARY]');
  assert.ok(!returned.includes(canary), `password attribute canary must not appear in diagnostics: ${safeReturned}`);
  assert.ok(!returned.includes(transformed), `transformed password property must not appear in diagnostics: ${safeReturned}`);
  assert.equal(showsPassword, '(filled)');
  assert.equal(showsText, 'ordinary-text-value ordinary-text-value');
  assert.equal(state.controls.find(c => c.name === 'Password')?.st.value, '(filled)');
  assert.equal(state.controls.find(c => c.name === 'Search')?.st.value, 'ordinary-text-value');
  const passwordHit = find.rows.find(row => row.role === 'textbox' && row.name === 'Password');
  assert.equal(passwordHit?.value, '(filled)');
  assert.equal(findCanary.matches, 0, 'the unnamed password value must not become its find name');
  assert.ok(!find.rows.some(row => row.name.includes(canary) || row.value === transformed));
});

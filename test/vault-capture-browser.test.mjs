// Protected capture (v3) against an isolated HTTPS Chromium and this checkout's test daemon:
// the value reaches only the driver's caller, the tab is tainted like after a fill, and every
// refusal is a fixed code with nothing read.
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {connect} from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import {deepTextExpression} from '../lib/refs.mjs';
import {daemonTrusted} from '../lib/vault-fill.mjs';
import {submitVaultCapture} from '../lib/vault-capture.mjs';
import {chromeBinary, startHeadlessBrowser, TEST_PORT} from './helpers.mjs';

const OWNER = 'capture-test-owner';
const TOKEN = 'SYNTHETIC_tok3n_0123456789abcdefghijklmnop';
const SHAPE = {min_length: TOKEN.length, max_length: TOKEN.length, charset: 'base64url', prefix: 'SYNTHETIC_'};

const tokenPage = q => `<!doctype html><title>Token created</title>
<p>Copy this token now. It will not be shown again.</p>
<label for="tok">API token</label><input id="tok" readonly value="${q.get('empty') ? '' : TOKEN}"><button>Copy</button>
<input id="other" readonly value="not a token" aria-label="Zone ID">
${q.get('two') ? `<input class="tok" readonly value="${TOKEN}"><input class="tok" readonly value="${TOKEN}">` : ''}
${q.get('hidden') ? '<input id="secret" style="display:none" value="SYNTHETIC_hidden0123456789abcdefghijklmnop">' : ''}`;

test('protected capture v3 in isolated HTTPS Chromium', {skip: !chromeBinary(), timeout: 120000}, async t => {
  const dir = fs.mkdtempSync('/tmp/bc-capture-tls-');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-subj', '/CN=localhost', '-days', '1'], {stdio: 'ignore'});
  const server = https.createServer({key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem'))}, (q, r) => {
    r.setHeader('content-type', 'text/html'); r.setHeader('cache-control', 'no-store');
    const url = new URL(q.url, 'https://fixture.test');
    if (url.pathname === '/done') return r.end('<!doctype html><title>Tokens</title><h1>API tokens</h1><p>1 active token</p>');
    if (url.pathname === '/echo') return r.end(`<!doctype html><title>Tokens</title><p>Last token ${TOKEN}</p>`);
    r.end(tokenPage(url.searchParams));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.BROWSERCTRL_CAPTURE = '0';
  process.env.BROWSERCTRL_AGENT_ID = OWNER;
  const port = TEST_PORT, browser = await startHeadlessBrowser(port);
  let raw, conn;
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-other-root-'));
  t.after(async () => { try { await raw?.stop(); } catch {} raw?.close(); conn?.close(); await browser.close(); await new Promise(r => server.close(r)); fs.rmSync(dir, {recursive: true, force: true}); fs.rmSync(fakeRoot, {recursive: true, force: true}); delete process.env.BROWSERCTRL_AGENT_ID; });
  raw = await connect(port);
  conn = await connect(port, {mediated: true});
  await raw.browser('Security.setIgnoreCertificateErrors', {ignore: true});
  const origin = `https://127.0.0.1:${server.address().port}`;
  const until = async (tab, expression, want) => {
    for (let i = 0; i < 100; i++) { if (await ops.evaluate(conn, tab, expression).catch(() => null) === want) return; await new Promise(r => setTimeout(r, 50)); }
    throw Error(`timed out waiting for ${expression} === ${want}`);
  };
  // A browserctrl tab, claimed by OWNER through an ordinary mediated read.
  async function tab(url) {
    const {targetId} = await raw.browser('Target.createTarget', {url: origin + url});
    await until(targetId, "document.readyState==='complete' && !!document.querySelector('input')", true);
    return targetId;
  }
  const close = async id => {
    await raw.browser('Target.closeTarget', {targetId: id});
    for (let i = 0; i < 40 && (await raw.status()).taintedTabs; i++) await new Promise(r => setTimeout(r, 50));
  };
  const capture = (element, {shape = SHAPE, owner = OWNER, captureOrigin = origin, request_id = crypto.randomUUID(), ...opts} = {}) => submitVaultCapture(
    {version: 3, request_id, deadline: Date.now() / 1000 + 60, destination: {browser: 'dia', origin: captureOrigin, tab_owner: owner, element}, shape},
    {port, ...opts});
  const failed = code => ({status: 'failed', verification: 'not_verified', code});

  await t.test('untrusted daemon is refused before any request is sent', async () => {
    const id = await tab('/token');
    fs.mkdirSync(path.join(fakeRoot, 'lib'), {recursive: true}); fs.writeFileSync(path.join(fakeRoot, 'lib', 'daemon-run.mjs'), '');
    assert.deepEqual(await capture({selector: '#tok'}, {trusted: (sock, p) => daemonTrusted(sock, p, {root: fakeRoot})}), failed('daemon_untrusted'));
    assert.equal((await raw.status()).taintedTabs, 0);
    await close(id);
  });

  await t.test('captures by selector, then the tab is tainted until it leaves the page', async () => {
    const id = await tab('/token');
    const result = await capture({selector: '#tok'});
    assert.deepEqual(result, {status: 'completed', verification: 'captured', value: TOKEN});
    assert.equal((await raw.status()).taintedTabs, 1);
    // The agent cannot read the value back: caller JavaScript, screenshots and raw CDP are off,
    // structured reads are redacted, and a second capture is refused.
    await assert.rejects(ops.evaluate(conn, id, "document.querySelector('#tok').value", {caller: true}), /tab_tainted/);
    await assert.rejects(conn.send(id, 'Page.captureScreenshot', {}), /tab_tainted/);
    await assert.rejects(raw.send(id, 'Runtime.evaluate', {expression: '1', returnByValue: true}), /tab_tainted/);
    const value = await ops.evaluate(conn, id, "document.querySelector('#tok').value");
    assert.equal(value, '[redacted]');
    const html = await ops.html(conn, id);
    assert.ok(!html.includes(TOKEN) && html.includes('[redacted]'));
    assert.ok(!JSON.stringify(await ops.readPage(conn, id)).includes(TOKEN));
    assert.deepEqual(await capture({selector: '#tok'}), failed('tab_tainted'));
    // A clean page lifts the taint and resets history.
    await conn.send(id, 'Page.navigate', {url: origin + '/done'});
    await until(id, "location.pathname==='/done' && document.readyState==='complete'", true);
    assert.equal(await ops.evaluate(conn, id, '6*7', {caller: true}), 42);
    assert.equal((await raw.send(id, 'Page.getNavigationHistory', {})).entries.length, 1);
    assert.equal((await raw.status()).taintedTabs, 0);
    await close(id);
  });

  await t.test('a page that still shows the value keeps the taint; close lifts it', async () => {
    const id = await tab('/token');
    assert.equal((await capture({name: 'API token'})).value, TOKEN);
    await conn.send(id, 'Page.navigate', {url: origin + '/echo'});
    await until(id, "location.pathname==='/echo' && document.readyState==='complete'", true);
    await assert.rejects(ops.evaluate(conn, id, 'document.body.innerText', {caller: true}), /tab_tainted/);
    const text = await ops.evaluate(conn, id, deepTextExpression());
    assert.match(text, /Last token \[redacted\]/);
    await close(id);
    assert.equal((await raw.status()).taintedTabs, 0);
  });

  await t.test('element refusals read nothing and leave the tab untainted', async () => {
    const id = await tab('/token?two=1&hidden=1');
    assert.deepEqual(await capture({selector: '.tok'}), failed('element_ambiguous'));
    assert.deepEqual(await capture({selector: '#missing'}), failed('element_not_found'));
    assert.deepEqual(await capture({selector: '#tok', name: 'Zone ID'}), failed('element_not_found'));
    assert.deepEqual(await capture({selector: '#secret'}), failed('element_not_visible'));
    assert.deepEqual(await capture({selector: '#other'}), failed('value_shape_mismatch'));
    assert.deepEqual(await capture({selector: '#tok'}, {shape: {...SHAPE, charset: 'hex', prefix: ''}}), failed('value_shape_mismatch'));
    assert.deepEqual(await capture({selector: 'input[[['}), failed('element_not_found'));
    assert.equal((await raw.status()).taintedTabs, 0);
    assert.equal(await ops.evaluate(conn, id, '1+1', {caller: true}), 2);
    await close(id);
    const empty = await tab('/token?empty=1');
    assert.deepEqual(await capture({selector: '#tok'}), failed('value_empty'));
    await close(empty);
  });

  await t.test('tab binding: owner, origin, ambiguity, history and request reuse', async () => {
    const id = await tab('/token');
    // Another owner's claim, or a plan origin the tab is not on, finds no tab.
    assert.deepEqual(await capture({selector: '#tok'}, {owner: 'someone-else'}), failed('tab_not_found'));
    assert.deepEqual(await capture({selector: '#tok'}, {captureOrigin: 'https://dash.example.com'}), failed('tab_not_found'));
    const second = await tab('/token');
    assert.deepEqual(await capture({selector: '#tok'}), failed('tab_ambiguous'));
    await close(second);
    const reused = crypto.randomUUID();
    assert.equal((await capture({selector: '#tok'}, {request_id: reused})).status, 'completed');
    await close(id);
    const again = await tab('/token');
    assert.deepEqual(await capture({selector: '#tok'}, {request_id: reused}), failed('request_already_used'));
    await close(again);
    // A tab the user opened with earlier history is refused, as for a fill.
    const r = await fetch(`http://127.0.0.1:${port}/json/new?${origin}/done`, {method: 'PUT'});
    const {id: user} = await r.json();
    await until(user, "document.readyState==='complete'", true);
    await conn.send(user, 'Page.navigate', {url: origin + '/token'});
    await until(user, "location.pathname==='/token' && document.readyState==='complete'", true);
    assert.deepEqual(await capture({selector: '#tok'}), failed('tab_not_dedicated'));
    assert.equal((await raw.status()).taintedTabs, 0);
    await close(user);
  });

  await t.test('malformed requests are refused before the daemon is reached', async () => {
    for (const element of [{}, {selector: ''}, {css: '#tok'}, {selector: 'x'.repeat(513)}]) {
      assert.deepEqual(await capture(element), failed('invalid_request'));
    }
    assert.deepEqual(await capture({selector: '#tok'}, {shape: {...SHAPE, charset: 'any'}}), failed('invalid_request'));
    assert.deepEqual(await capture({selector: '#tok'}, {captureOrigin: 'http://127.0.0.1'}), failed('invalid_request'));
    assert.deepEqual(await capture({selector: '#tok'}, {owner: 'bad owner'}), failed('invalid_request'));
  });
});

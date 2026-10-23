import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {connect} from '../lib/daemon.mjs';
import net from 'node:net';
import {SOCK, agentId} from '../lib/env.mjs';
import * as ops from '../lib/ops.mjs';
import {deepTextExpression} from '../lib/refs.mjs';
import {submitVaultFill, daemonTrusted} from '../lib/vault-fill.mjs';
import {chromeBinary, startHeadlessBrowser, TEST_PORT} from './helpers.mjs';

const USER = 'synthetic-user@example.com';
const PASSWORD = 'Synth&Pass"word<1>';
const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The password page behaves like a React controlled input: a value tracker on the element
// ignores input events whose value it set itself, so only trusted typing updates the state.
const passwordPage = q => `<!doctype html><title>Password</title><p>Signing in</p>
<form id="f" method="POST" action="/done?${q}"><input id="pw" name="pw" type="password"><span id="len">0</span><button id="submit">Sign in</button></form>
<script>
const el=document.getElementById('pw'), native=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
let tracked='', state='';
Object.defineProperty(el,'value',{configurable:true,get(){return native.get.call(this);},set(v){tracked=String(v);native.set.call(this,v);}});
el.addEventListener('input',()=>{const now=native.get.call(el);if(now===tracked)return;tracked=now;state=now;el.value=state;document.getElementById('len').textContent=String(state.length);});
${q.includes('spa=1') ? "document.getElementById('f').addEventListener('submit',e=>{e.preventDefault();window.kept=state;history.pushState({},'','/home');document.body.innerHTML='<h1>Welcome</h1>';});" : ''}
</script>`;

test('protected field fill v2 in isolated HTTPS Chromium', {skip: !chromeBinary(), timeout: 120000}, async t => {
  const dir = fs.mkdtempSync('/tmp/bc-fill-tls-');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-subj', '/CN=localhost', '-days', '1'], {stdio: 'ignore'});
  const posted = [];
  const server = https.createServer({key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem'))}, (q, r) => {
    r.setHeader('content-type', 'text/html'); r.setHeader('cache-control', 'no-store');
    const url = new URL(q.url, 'https://fixture.test');
    if (q.method === 'POST') {
      let body = ''; q.on('data', c => body += c); q.on('end', () => {
        const form = new URLSearchParams(body);
        if (url.pathname === '/password') return r.end(passwordPage(url.searchParams.toString()));
        posted.push(form.get('pw'));
        r.end(url.searchParams.get('mode') === 'echo'
          ? `<h1>Signed in</h1><p>Your password is ${escape(form.get('pw'))}</p><div data-secret="${escape(form.get('pw'))}">x</div>`
          : '<h1>Signed in</h1><p>Welcome back</p>');
      });
      return;
    }
    if (url.pathname === '/password') return r.end(passwordPage(url.searchParams.toString()));
    r.end(`<!doctype html><title>Sign in</title><form method="POST" action="/password?${url.searchParams}"><input id="user" name="user" type="email"><button id="next">Next</button></form>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.BROWSERCTRL_CAPTURE = '0';
  const port = TEST_PORT, browser = await startHeadlessBrowser(port);
  let raw, conn;
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-other-root-'));
  t.after(async () => { try { await raw?.stop(); } catch {} raw?.close(); conn?.close(); await browser.close(); await new Promise(r => server.close(r)); fs.rmSync(dir, {recursive: true, force: true}); fs.rmSync(fakeRoot, {recursive: true, force: true}); });
  raw = await connect(port);
  conn = await connect(port, {mediated: true});
  await raw.browser('Security.setIgnoreCertificateErrors', {ignore: true});
  const origin = `https://127.0.0.1:${server.address().port}`;
  const pathOf = tab => ops.evaluate(conn, tab, 'location.pathname');
  const until = async (tab, expression, want) => {
    for (let i = 0; i < 100; i++) { if (await ops.evaluate(conn, tab, expression).catch(() => null) === want) return; await new Promise(r => setTimeout(r, 50)); }
    throw Error(`timed out waiting for ${expression} === ${want}`);
  };
  async function tab(url) {
    const {targetId} = await raw.browser('Target.createTarget', {url: origin + url});
    await until(targetId, "document.readyState==='complete' && !!document.querySelector('input')", true);
    return targetId;
  }
  const fill = (tab_id, element, field, value, {origins = [origin], ...opts} = {}) => submitVaultFill(
    {version: 2, request_id: crypto.randomUUID(), deadline: Date.now() / 1000 + 60, destination: {browser: 'dia', origins, tab_id, element}, field, value},
    {port, ...opts});

  // The test daemon runs this checkout's daemon-run.mjs; a different install root is refused.
  assert.equal(await daemonTrusted(SOCK(port), port), true);
  fs.mkdirSync(path.join(fakeRoot, 'lib')); fs.writeFileSync(path.join(fakeRoot, 'lib', 'daemon-run.mjs'), '');

  await t.test('untrusted daemon is refused before any value is sent', async () => {
    const id = await tab('/password');
    const result = await fill(id, '#pw', 'password', PASSWORD, {trusted: (sock, p) => daemonTrusted(sock, p, {root: fakeRoot})});
    assert.deepEqual(result, {status: 'failed', verification: 'not_verified', input_attempted: false, action_may_have_run: false, code: 'daemon_untrusted'});
    assert.equal(await ops.evaluate(conn, id, "document.querySelector('#pw').value.length"), 0);
    assert.equal((await raw.status()).taintedTabs, 0);
    // Control: like React, the fixture ignores a value set by script plus a synthetic input event.
    assert.equal(await ops.evaluate(conn, id, "(()=>{const e=document.querySelector('#pw');e.value='abc';e.dispatchEvent(new Event('input',{bubbles:true}));const n=document.querySelector('#len').textContent;e.value='';return n;})()"), '0');
    await raw.browser('Target.closeTarget', {targetId: id});
  });

  await t.test('wrong origin and wrong element kind are refused with no input attempted', async () => {
    const id = await tab('/');
    const wrong = await fill(id, '#user', 'username', USER, {origins: ['https://accounts.example.com']});
    assert.equal(wrong.code, 'origin_mismatch'); assert.equal(wrong.input_attempted, false);
    const kind = await fill(id, '#user', 'password', PASSWORD);
    assert.equal(kind.code, 'element_kind_mismatch'); assert.equal(kind.input_attempted, false);
    assert.equal(await ops.evaluate(conn, id, "document.querySelector('#user').value"), '');
    assert.equal((await raw.status()).taintedTabs, 0);
    await raw.browser('Target.closeTarget', {targetId: id});
  });

  await t.test('multi-step login: username, Next, password by ref into a React-style input, submit, taint lifts', async () => {
    const id = await tab('/?mode=clean');
    const user = await fill(id, '#user', 'username', USER);
    assert.deepEqual(user, {status: 'completed', verification: 'filled', input_attempted: true, action_may_have_run: false});
    await ops.click(conn, id, {selector: '#next'});
    await until(id, "location.pathname==='/password' && document.readyState==='complete'", true);
    const snap = await ops.readPage(conn, id);
    const pw = snap.elements.find(e => e.role === 'textbox');
    assert.ok(pw?.id, JSON.stringify(snap.elements));
    const filled = await fill(id, `@${pw.id}`, 'password', PASSWORD);
    assert.deepEqual(filled, {status: 'completed', verification: 'filled', input_attempted: true, action_may_have_run: false});
    // The app's own state received the value; only its length is shown.
    assert.equal(await ops.evaluate(conn, id, "document.querySelector('#len').textContent"), String(PASSWORD.length));
    await assert.rejects(ops.evaluate(conn, id, '1', {caller: true}), /tab_tainted/);
    await ops.click(conn, id, {selector: '#submit'});
    await until(id, "location.pathname==='/done' && document.readyState==='complete'", true);
    assert.equal(posted.at(-1), PASSWORD);
    // The clean page lifts the taint: caller JavaScript works again and history holds one entry.
    assert.equal(await ops.evaluate(conn, id, '6*7', {caller: true}), 42);
    assert.equal((await raw.send(id, 'Page.getNavigationHistory', {})).entries.length, 1);
    assert.equal((await raw.status()).taintedTabs, 0);
    await raw.browser('Target.closeTarget', {targetId: id});
  });

  await t.test('a page echoing the secret stays tainted: capture refused, reads redacted, close lifts', async () => {
    const id = await tab('/password?mode=echo');
    assert.equal((await fill(id, '#pw', 'password', PASSWORD)).verification, 'filled');
    await ops.click(conn, id, {selector: '#submit'});
    await until(id, "location.pathname==='/done' && document.readyState==='complete'", true);
    assert.equal(posted.at(-1), PASSWORD);
    await assert.rejects(ops.evaluate(conn, id, 'document.body.innerText', {caller: true}), /tab_tainted/);
    await assert.rejects(conn.send(id, 'Page.captureScreenshot', {}), /tab_tainted/);
    await assert.rejects(raw.send(id, 'Runtime.evaluate', {expression: '1', returnByValue: true}), /tab_tainted/);
    await assert.rejects(raw.send(id, 'Input.dispatchKeyEvent', {type: 'keyDown', key: 'a'}), /tab_tainted/);
    await assert.rejects(conn.events(id, {limit: 50}), /tab_tainted/);
    const text = await ops.evaluate(conn, id, deepTextExpression());
    assert.match(text, /Your password is \[redacted\]/); assert.ok(!text.includes(PASSWORD));
    const html = await ops.html(conn, id);
    assert.ok(html.includes('data-secret="[redacted]"'), html); assert.ok(!html.includes(escape(PASSWORD)) && !html.includes(PASSWORD));
    const targets = JSON.stringify(await raw.browser('Target.getTargets'));
    assert.ok(!targets.includes(PASSWORD));
    assert.equal(await pathOf(id), '/done');
    assert.equal((await raw.status()).taintedTabs, 1);
    await raw.browser('Target.closeTarget', {targetId: id});
    for (let i = 0; i < 40 && (await raw.status()).taintedTabs; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal((await raw.status()).taintedTabs, 0);
  });

  await t.test('an SPA submission stays tainted', async () => {
    const id = await tab('/password?spa=1');
    assert.equal((await fill(id, '#pw', 'password', PASSWORD)).verification, 'filled');
    await ops.click(conn, id, {selector: '#submit'});
    await until(id, "location.pathname==='/home'", true);
    await assert.rejects(ops.evaluate(conn, id, 'window.kept', {caller: true}), /tab_tainted/);
    assert.equal(await ops.evaluate(conn, id, "document.querySelector('h1').textContent"), 'Welcome');
    await raw.browser('Target.closeTarget', {targetId: id});
  });

  await t.test('after a daemon restart a marked tab allows only close, then owner recovery', async () => {
    const id = await tab('/password');
    assert.equal((await fill(id, '#pw', 'password', PASSWORD)).verification, 'filled');
    await assert.rejects(raw.stop(), /daemon_busy_or_recording/);
    // Simulate a crash of this test's own daemon: the values are gone, the marker stays.
    process.kill((await raw.status()).pid, 'SIGKILL');
    await new Promise(r => setTimeout(r, 300));
    await raw.reconnect(); conn.close(); conn = await connect(port, {mediated: true});
    assert.equal((await raw.status()).taintedTabs, 1);
    await assert.rejects(ops.evaluate(conn, id, "document.querySelector('#len').textContent"), /tab_tainted/);
    await assert.rejects(ops.click(conn, id, {selector: '#submit'}), /tab_tainted/);
    const recover = request => new Promise((resolve, reject) => {
      const s = net.connect(SOCK(port)); let b = '';
      s.on('connect', () => s.write(JSON.stringify({reqId: 1, op: 'vault-recover', owner: agentId(), request}) + '\n'));
      s.on('data', c => { b += c; if (b.includes('\n')) { s.destroy(); resolve(JSON.parse(b.split('\n')[0]).result); } });
      s.on('error', reject);
    });
    const recovery = {version: 1, destination: {browser: 'dia', tab_id: id, origin}};
    assert.equal((await recover(recovery)).code, 'target_still_present');
    await raw.browser('Target.closeTarget', {targetId: id});
    assert.equal((await recover(recovery)).code, 'closed_target_recovered');
    assert.equal((await raw.status()).taintedTabs, 0);
  });
});

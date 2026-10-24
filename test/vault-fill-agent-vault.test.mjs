// Cross-repo check: agent-vault's real protected executor drives the real browserctrl-vault
// driver against an isolated HTTPS Chromium and test daemon. Nothing records stdin in between.
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {connect} from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import {chromeBinary, startHeadlessBrowser, TEST_PORT} from './helpers.mjs';

const AGENT_VAULT = process.env.AGENT_VAULT_WORKTREE || path.resolve(import.meta.dirname, '../../agent-vault');
const PYTHON = process.env.AGENT_VAULT_PYTHON || path.join(AGENT_VAULT, '.venv/bin/python');
const DRIVER = fileURLToPath(new URL('../bin/browserctrl-vault.mjs', import.meta.url));
const missing = !fs.existsSync(path.join(AGENT_VAULT, 'src', 'agent_vault', 'adapters', 'protected.py')) ? `agent-vault worktree not found at ${AGENT_VAULT}`
  : !fs.existsSync(PYTHON) ? `agent-vault python not found at ${PYTHON}` : !chromeBinary() ? 'no Chrome for the isolated browser' : false;
const OWNER = 'vault-integration-agent';
const USER = 'synthetic-user@example.com';
const PASSWORD = 'Synth&Pass"word<1>';

// One executor call per process, as the broker makes it: ProtectedExecutor("browser", argv)("execute", params).
const HARNESS = `
import json, sys
from agent_vault.adapters import protected
from agent_vault.errors import VaultError
argv, params = json.loads(sys.stdin.read())
executor = protected.ProtectedExecutor("browser", argv)
out = {"runner_is_capture": executor.runner is protected._capture, "argv": executor.argv}
try:
    out["result"] = executor("execute", params)
except VaultError as e:
    out["error"] = str(e)
print(json.dumps(out))
`;

test('agent-vault ProtectedExecutor drives browserctrl-vault through a multi-step login', {skip: missing ? `skipped: ${missing}` : false, timeout: 180000}, async t => {
  const dir = fs.mkdtempSync('/tmp/bc-av-tls-');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-subj', '/CN=localhost', '-days', '1'], {stdio: 'ignore'});
  const posted = [];
  const server = https.createServer({key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem'))}, (q, r) => {
    r.setHeader('content-type', 'text/html'); r.setHeader('cache-control', 'no-store');
    const url = new URL(q.url, 'https://fixture.test');
    let body = ''; q.on('data', c => body += c); q.on('end', () => {
      const form = new URLSearchParams(body);
      if (url.pathname === '/password') { posted.push({user: form.get('user')}); return r.end('<!doctype html><title>Password</title><form method="POST" action="/done"><input id="pw" name="pw" type="password"><button id="submit">Sign in</button></form>'); }
      if (url.pathname === '/done') { posted.push({pw: form.get('pw')}); return r.end('<!doctype html><h1>Signed in</h1><p>Welcome back</p>'); }
      r.end('<!doctype html><title>Sign in</title><form method="POST" action="/password"><input id="user" name="user" type="email"><button id="next">Next</button></form>');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.BROWSERCTRL_CAPTURE = '0';
  const port = TEST_PORT, browser = await startHeadlessBrowser(port);
  // Node loads this before the driver runs; the executor itself forwards only a fixed set of variables.
  const envFile = path.join(dir, 'driver.env');
  fs.writeFileSync(envFile, `BROWSERCTRL_HOME=${process.env.BROWSERCTRL_HOME}\nBROWSERCTRL_VAULT_TEST_PORT=${port}\n`);
  let conn;
  t.after(async () => { try { await conn?.stop(); } catch {} conn?.close(); await browser.close(); await new Promise(r => server.close(r)); fs.rmSync(dir, {recursive: true, force: true}); });
  conn = await connect(port, {owner: OWNER, mediated: true});
  await conn.browser('Security.setIgnoreCertificateErrors', {ignore: true});
  const origin = `https://127.0.0.1:${server.address().port}`;
  const until = async (tab, expression) => {
    for (let i = 0; i < 100; i++) { if (await ops.evaluate(conn, tab, expression).catch(() => null) === true) return; await new Promise(r => setTimeout(r, 50)); }
    throw Error(`timed out waiting for ${expression}`);
  };
  const argv = [process.execPath, `--env-file=${envFile}`, DRIVER];
  // The broker's browser.fill params: op.destination plus the call's tab_id and element,
  // one resolved field, and the lease/credential deadline.
  const execute = (tab_id, element, field, value, origins = [origin]) => new Promise((resolve, reject) => {
    const params = {operation_id: crypto.randomUUID(), action: 'browser.fill', destination: {browser: 'dia', origins, tab_id, element},
      credential: {fields: {[field]: value}}, deadline: Date.now() / 1000 + 60};
    const child = spawn(PYTHON, ['-c', HARNESS], {env: {PATH: process.env.PATH, HOME: os.homedir(), PYTHONPATH: path.join(AGENT_VAULT, 'src'), BROWSERCTRL_AGENT_ID: OWNER}, stdio: ['pipe', 'pipe', 'pipe']});
    let out = '', err = '';
    child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c);
    child.on('error', reject);
    child.on('close', code => { try { resolve(JSON.parse(out)); } catch { reject(Error(`harness exited ${code}: ${err.slice(-2000)}`)); } });
    child.stdin.end(JSON.stringify([argv, params]));
  });

  const {targetId: tab} = await conn.browser('Target.createTarget', {url: origin + '/'});
  await until(tab, "document.readyState==='complete' && !!document.querySelector('#user')");

  // The real driver, run directly by the executor's own runner.
  const wrong = await execute(tab, '#user', 'username', USER, ['https://accounts.example.com']);
  assert.equal(wrong.runner_is_capture, true);
  assert.deepEqual(wrong.argv, argv);
  assert.equal(fs.realpathSync(wrong.argv.at(-1)), fs.realpathSync(DRIVER));
  assert.deepEqual(wrong.result, {status: 'failed', verification: 'not_verified', input_attempted: false, action_may_have_run: false, code: 'origin_mismatch'});
  assert.equal(await ops.evaluate(conn, tab, "document.querySelector('#user').value"), '');
  assert.equal((await conn.status()).taintedTabs, 0);

  const user = await execute(tab, '#user', 'username', USER);
  assert.deepEqual(user.result, {status: 'completed', verification: 'filled', input_attempted: true, action_may_have_run: false});
  await ops.click(conn, tab, {selector: '#next'});
  await until(tab, "location.pathname==='/password' && document.readyState==='complete'");
  assert.deepEqual(posted.at(-1), {user: USER});

  const snap = await ops.readPage(conn, tab);
  const pw = snap.elements.find(e => e.role === 'textbox');
  const password = await execute(tab, `@${pw.id}`, 'password', PASSWORD);
  assert.deepEqual(password.result, {status: 'completed', verification: 'filled', input_attempted: true, action_may_have_run: false});
  assert.equal((await conn.status()).taintedTabs, 1);
  await assert.rejects(ops.evaluate(conn, tab, '1', {caller: true}), /tab_tainted/);
  assert.equal(await ops.evaluate(conn, tab, "document.querySelector('#pw').value.length"), PASSWORD.length);

  await ops.click(conn, tab, {selector: '#submit'});
  await until(tab, "location.pathname==='/done' && document.readyState==='complete'");
  assert.deepEqual(posted.at(-1), {pw: PASSWORD});
  // The clean page lifts the taint.
  assert.equal(await ops.evaluate(conn, tab, '6*7', {caller: true}), 42);
  assert.equal((await conn.status()).taintedTabs, 0);
  assert.equal((await conn.send(tab, 'Page.getNavigationHistory', {})).entries.length, 1);
  for (const r of [wrong, user, password]) assert.ok(!JSON.stringify(r).includes(PASSWORD) && !JSON.stringify(r).includes(USER));
});


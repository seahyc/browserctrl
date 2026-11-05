// Cross-repo check: agent-vault's real create-only writer runs a capture plan through its own
// private runner, the real browserctrl-vault driver and a test daemon on an isolated HTTPS
// Chromium, then hands the value to a fake official CLI. Only booleans and codes come back.
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
const missing = !fs.existsSync(path.join(AGENT_VAULT, 'tests', 'test_protected_capture.py')) ? `agent-vault capture tests not found at ${AGENT_VAULT}`
  : !fs.existsSync(PYTHON) ? `agent-vault python not found at ${PYTHON}` : !chromeBinary() ? 'no Chrome for the isolated browser' : false;
const OWNER = 'agent-vault-capture';
const TOKEN = 'SYNTHETIC_crossrepo_0123456789abcdefghijk';

// The writer's stage and create, as the broker calls them, with a ready synthetic session.
const HARNESS = `
import json, sys, tempfile, time
sys.path.insert(0, sys.argv[1])
import test_protected_capture as t
from agent_vault.errors import VaultError
from agent_vault.write_plans import validate_plan
argv, spec, expected = json.loads(sys.stdin.read())
class Cleanup:
    def addCleanup(self, *a): pass
h = t.Harness(Cleanup(), tempfile.mkdtemp(), time.time)
h.provider.configure_capture(argv)
lease = {"grant_id": "grant-cross", "expires_at": time.time() + 120}
h.ready(lease["grant_id"], lease["expires_at"])
plan = validate_plan({"account": "work", "capture": spec, "item": {"name": "Synthetic token", "type": 1}})
params = {"reference": {"write": plan}, "lease": lease}
out = {}
try:
    with h.patched():
        h.provider.stage(params)
        out["result"] = h.provider.create({**params, "operation_id": "cross-repo"})
    out["stored_matches"] = h.created[0]["login"]["password"] == expected
    out["argv_clean"] = all(expected not in json.dumps([c["argv"], c["env"]]) for c in h.children)
except VaultError as e:
    out["error"] = e.code
print(json.dumps(out))
`;

test('agent-vault writer captures through browserctrl-vault into a new item', {skip: missing ? `skipped: ${missing}` : false, timeout: 180000}, async t => {
  const dir = fs.mkdtempSync(path.join((process.platform === 'win32' ? os.tmpdir() : '/tmp'), 'bc-avc-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-subj', '/CN=localhost', '-days', '1'], {stdio: 'ignore'});
  const server = https.createServer({key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem'))}, (q, r) => {
    r.setHeader('content-type', 'text/html'); r.setHeader('cache-control', 'no-store');
    r.end(`<!doctype html><title>Token created</title><label for="tok">API token</label><input id="tok" readonly value="${TOKEN}"><button>Copy</button>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.BROWSERCTRL_CAPTURE = '0';
  const port = TEST_PORT, browser = await startHeadlessBrowser(port);
  const envFile = path.join(dir, 'driver.env');
  fs.writeFileSync(envFile, `BROWSERCTRL_HOME=${process.env.BROWSERCTRL_HOME}\nBROWSERCTRL_VAULT_TEST_PORT=${port}\n`);
  let conn;
  t.after(async () => { try { await conn?.stop(); } catch {} conn?.close(); await browser.close(); await new Promise(r => server.close(r)); fs.rmSync(dir, {recursive: true, force: true}); });
  conn = await connect(port, {owner: OWNER, mediated: true});
  await conn.browser('Security.setIgnoreCertificateErrors', {ignore: true});
  const origin = `https://127.0.0.1:${server.address().port}`;
  const argv = [process.execPath, `--env-file=${envFile}`, DRIVER];
  const spec = element => ({browser: 'dia', origin, tab_owner: OWNER, element,
    shape: {min_length: TOKEN.length, max_length: TOKEN.length, charset: 'base64url', prefix: 'SYNTHETIC_'}});
  const run = element => new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ['-c', HARNESS, path.join(AGENT_VAULT, 'tests')], {env: {PATH: process.env.PATH, HOME: os.homedir(), PYTHONPATH: path.join(AGENT_VAULT, 'src')}, stdio: ['pipe', 'pipe', 'pipe']});
    let out = '', err = '';
    child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c);
    child.on('error', reject);
    child.on('close', code => {
      assert.ok(!out.includes(TOKEN) && !err.includes(TOKEN), 'the value reached harness output');
      try { resolve(JSON.parse(out)); } catch { reject(Error(`harness exited ${code}: ${err.slice(-2000)}`)); }
    });
    child.stdin.end(JSON.stringify([argv, spec(element), TOKEN]));
  });

  const {targetId: tab} = await conn.browser('Target.createTarget', {url: origin + '/'});
  for (let i = 0; i < 100 && await ops.evaluate(conn, tab, "document.readyState==='complete' && !!document.querySelector('#tok')").catch(() => false) !== true; i++) await new Promise(r => setTimeout(r, 50));

  assert.deepEqual(await run({selector: '#missing'}), {error: 'capture_element_not_found'});
  assert.equal((await conn.status()).taintedTabs, 0);

  const ok = await run({name: 'API token'});
  assert.deepEqual(ok, {result: {created_item_id: '00000000-0000-4000-8000-0000000000c1'}, stored_matches: true, argv_clean: true});
  assert.equal((await conn.status()).taintedTabs, 1);
  await assert.rejects(ops.evaluate(conn, tab, "document.querySelector('#tok').value", {caller: true}), /tab_tainted/);
  assert.equal(await ops.evaluate(conn, tab, "document.querySelector('#tok').value"), '[redacted]');
  assert.deepEqual(await run({name: 'API token'}), {error: 'capture_tab_tainted'});
});

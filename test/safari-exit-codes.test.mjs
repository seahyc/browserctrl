// The Safari path exits with the same codes as Chromium (references/scripting.md): the
// mapping as a unit, then the binary against a Safari daemon whose native client is a fake.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exitCodeFor, safariResultCode, EXIT } from '../lib/exit-codes.mjs';
import { safariCLI } from '../lib/safari-frontend.mjs';
import { createSafariDaemon } from '../lib/safari-daemon.mjs';

const test = (name, fn) => nodeTest(name, { skip: process.platform === 'win32' }, fn);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const coded = (code, message = 'x') => Object.assign(new Error(message), { code });
const thrown = fn => { try { fn(); } catch (e) { return e; } assert.fail('expected a throw'); };

test('Safari daemon error codes map to the documented exit codes', () => {
  for (const code of ['CLAIMED', 'AGENT_PAUSED', 'SENSITIVE_PHASE', 'PROTECTED_HISTORY']) assert.equal(exitCodeFor(coded(code)), EXIT.REFUSED, code);
  for (const code of ['TAB_REQUIRED', 'TAB_MISMATCH', 'INVALID_TAB_HANDLE', 'INVALID_ARGUMENTS', 'UNKNOWN_TOOL', 'INVALID_OWNER', 'INVALID_JSON']) assert.equal(exitCodeFor(coded(code)), EXIT.USAGE, code);
  for (const code of ['DAEMON_STOPPING', 'SAFARI_DISCONNECTED']) assert.equal(exitCodeFor(coded(code)), EXIT.UNAVAILABLE, code);
  for (const code of ['SWITCH_FAILED', 'QUEUE_FULL', 'DAEMON_BUSY']) assert.equal(exitCodeFor(coded(code)), EXIT.FAILED, code);
  assert.equal(exitCodeFor(coded('ETIMEDOUT', 'Safari daemon connection timed out')), EXIT.UNAVAILABLE);
  assert.equal(exitCodeFor(coded('ENOENT', 'connect ENOENT /tmp/browserctrl-501/safari.sock')), EXIT.UNAVAILABLE);
  assert.equal(exitCodeFor(new Error('Safari daemon did not become available: connect ENOENT')), EXIT.UNAVAILABLE);
  assert.equal(exitCodeFor(new Error('Could not start Safari’s official MCP server: spawn failed. Check that Safari Remote Automation is enabled')), EXIT.UNAVAILABLE);
  assert.equal(exitCodeFor(coded('ETIMEDOUT', 'Safari request timed out; action outcome may be unknown and was not retried.')), EXIT.FAILED);
  assert.equal(exitCodeFor(new Error('Safari reload outcome is uncertain; it was not replayed.')), EXIT.FAILED);
});

test('every refusal of the shared Safari command set is a usage error (exit 2)', () => {
  const cases = [
    ['click', { ref: 'ref_3' }], ['click', { selector: '#b' }], ['click', {}], ['click', { ref: '4', button: 'right' }],
    ['click', { ref: '4', steal: true }], ['group', {}], ['upload', {}], ['shot', { 'emulate-focus': true }], ['shot', { ref: '4' }],
    ['open', { anonymous: true }],
  ];
  for (const [cmd, flags] of cases) {
    const e = thrown(() => safariCLI(cmd, [cmd, 'native-tab'], flags));
    assert.equal(exitCodeFor(e), EXIT.USAGE, `${cmd} ${JSON.stringify(flags)}: ${e.message}`);
  }
});

test('a Safari tool result marked isError exits 6, or 5 when a guard refused it', () => {
  assert.equal(safariResultCode({ content: [{ type: 'text', text: 'ok' }] }), EXIT.OK);
  assert.equal(safariResultCode({ isError: true, content: [{ type: 'text', text: 'No element with that UID' }] }), EXIT.FAILED);
  assert.equal(safariResultCode({ isError: true }), EXIT.FAILED);
  assert.equal(safariResultCode({ isError: true, content: [{ type: 'text', text: 'Tab abc is claimed by codex (x)' }] }), EXIT.REFUSED);
});

// The binary, with BROWSERCTRL_HOME pointing at a folder whose run/safari.sock is a Safari
// daemon driving a fake native client (the mocks test/safari.test.mjs uses).
function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/browserctrl.mjs'), ...args], {
      env: { ...process.env, ...env, BROWSERCTRL_BROWSER: '', BROWSERCTRL_PORT: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

nodeTest('the Safari CLI exits 0, 2, 5 and 6 as the Chromium CLI does', { skip: process.platform !== 'darwin' && 'Safari is macOS-only' }, async t => {
  const home = fs.mkdtempSync('/tmp/bc-sx-');
  fs.mkdirSync(path.join(home, 'run'), { recursive: true, mode: 0o700 });
  const socketPath = path.join(home, 'run', 'safari.sock');
  const tools = ['list_tabs', 'create_tab', 'switch_tab', 'close_tab', 'navigate_to_url', 'get_page_content', 'page_info'].map(name => ({ name, inputSchema: { type: 'object' } }));
  const client = {
    async listTools() { return { tools }; },
    async callTool(name) {
      if (name === 'get_page_content') return { isError: true, content: [{ type: 'text', text: 'The page could not be read' }] };
      return { content: [{ type: 'text', text: name }] };
    },
    async close() {},
  };
  const claimApi = {
    claim(port, handle) { if (handle === 'claimed-tab') throw Object.assign(new Error('Tab claimed-t is claimed by other (agent-b)'), { code: 'CLAIMED' }); },
    release() {},
  };
  const daemon = await createSafariDaemon({ socketPath, lockPath: `${socketPath}.lock`, clientFactory: async () => client, platform: 'darwin', claimApi, activityFile: path.join(home, 'activity.json') });
  t.after(async () => { await daemon.shutdown(); fs.rmSync(home, { recursive: true, force: true }); });
  const env = { BROWSERCTRL_HOME: home, BROWSERCTRL_AGENT_ID: 'safari-exit-test' };

  const ok = await run(['tabs', '--browser', 'safari'], env);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /list_tabs/);

  const failed = await run(['text', 'native-tab', '--browser', 'safari'], env);
  assert.equal(failed.code, EXIT.FAILED, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /could not be read/);

  const refused = await run(['nav', 'claimed-tab', 'https://example.com', '--browser', 'safari'], env);
  assert.equal(refused.code, EXIT.REFUSED, refused.stderr);
  assert.match(refused.stderr, /^Error: .*is claimed by/m);

  const unsupported = await run(['group', '--browser', 'safari'], env);
  assert.equal(unsupported.code, EXIT.USAGE, unsupported.stderr);
  const noTab = await run(['safari', 'call', 'page_info', '--browser', 'safari'], env);
  assert.equal(noTab.code, EXIT.USAGE, noTab.stderr);
  const badArgs = await run(['safari', 'call', 'list_tabs', '--args', '{oops', '--browser', 'safari'], env);
  assert.equal(badArgs.code, EXIT.USAGE, badArgs.stderr);
  assert.match(badArgs.stderr, /args must be JSON/);
  const port = await run(['tabs', '--browser', 'safari', '--port', '9999'], env);
  assert.equal(port.code, EXIT.USAGE, port.stderr);
});

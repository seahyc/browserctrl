import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Starts the server over stdio, runs the requests, returns the responses by id.
async function session(env, requests) {
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp/server.mjs')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = new Map();
  let buf = '';
  child.stdout.on('data', d => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch {}
    }
  });
  const call = (id, method, params) => new Promise(resolve => { waiting.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  try {
    await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const out = {};
    for (const [i, [method, params]] of requests.entries()) out[i] = await call(i + 2, method, params);
    return out;
  } finally { child.kill(); }
}

const home = { BROWSERCTRL_HOME: '/tmp/bc-mcp-tools-home' };

test('tools/list shows the core profile by default and stays small', async () => {
  const r = (await session(home, [['tools/list', {}]]))[0].result;
  const names = r.tools.map(t => t.name);
  for (const n of ['browser_list', 'browser_open', 'browser_read', 'browser_act', 'browser_do', 'browser_recipe']) assert.ok(names.includes(n), n);
  for (const n of ['browser_group', 'browser_profiles', 'browser_safari']) assert.ok(!names.includes(n), `${n} is not core`);
  assert.ok(JSON.stringify(r).length < 20000, `core tools/list is ${JSON.stringify(r).length} bytes`);
});

test('BROWSERCTRL_MCP_TOOLS=all lists everything; a comma list adds to core', async () => {
  const all = (await session({ ...home, BROWSERCTRL_MCP_TOOLS: 'all' }, [['tools/list', {}]]))[0].result.tools.map(t => t.name);
  for (const n of ['browser_group', 'browser_profiles', 'browser_record', 'browser_reload']) assert.ok(all.includes(n), n);
  for (const gone of ['browser_refresh', 'browser_rec', 'browser_recording', 'browser_marks', 'browser_annotate_mode']) assert.ok(!all.includes(gone), `${gone} was merged`);
  const some = (await session({ ...home, BROWSERCTRL_MCP_TOOLS: 'browser_group, browser_wake' }, [['tools/list', {}]]))[0].result.tools.map(t => t.name);
  assert.ok(some.includes('browser_group') && some.includes('browser_wake') && some.includes('browser_read'));
  assert.ok(!some.includes('browser_profiles'));
});

test('the guide and references are MCP resources', async () => {
  const r = await session(home, [['resources/list', {}], ['resources/read', { uri: 'browserctrl://guide' }]]);
  const uris = r[0].result.resources.map(x => x.uri);
  assert.ok(uris.includes('browserctrl://guide'));
  assert.ok(uris.some(u => u.startsWith('browserctrl://reference/')));
  assert.match(r[1].result.contents[0].text, /^---\nname: browserctrl/);
});

test('merged tools still answer to their old names', async () => {
  const r = await session(home, [
    ['tools/call', { name: 'browser_marks', arguments: {} }],
    ['tools/call', { name: 'browser_rec', arguments: { action: 'status' } }],
  ]);
  assert.ok(!r[0].result.isError, JSON.stringify(r[0]));
  assert.ok(!r[1].result.isError, JSON.stringify(r[1]));
});

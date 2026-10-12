import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safariCall, safariTools } from '../lib/safari.mjs';
import { createSafariDaemon, SAFARI_CLAIM_PORT } from '../lib/safari-daemon.mjs';

const fakeTools = [
  { name: 'list_tabs', inputSchema: { type: 'object' } },
  { name: 'create_tab', inputSchema: { type: 'object' } },
  { name: 'switch_tab', inputSchema: { type: 'object' } },
  { name: 'close_tab', inputSchema: { type: 'object' } },
  { name: 'navigate_to_url', inputSchema: { type: 'object' } },
  { name: 'page_info', inputSchema: { type: 'object' } },
  { name: 'get_page_content', inputSchema: { type: 'object' } },
];

async function startFake(t, { claimApi = null, callTool = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-safari-test-'));
  const socketPath = path.join(dir, 'safari.sock');
  const claims = claimApi || { claim() {} };
  const client = {
    async listTools() { return { tools: fakeTools }; },
    async callTool(name, args) { return callTool ? callTool(name, args) : { content: [{ type: 'text', text: name }] }; },
    async close() {},
  };
  const daemon = await createSafariDaemon({ socketPath, lockPath: `${socketPath}.lock`, clientFactory: async () => client, platform: 'darwin', claimApi: claims });
  t.after(async () => {
    await daemon.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { socketPath, daemon };
}

function ipc(socketPath, message) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify(message) + '\n'));
    socket.on('data', chunk => {
      data += chunk;
      const end = data.indexOf('\n');
      if (end < 0) return;
      socket.destroy();
      try { resolve(JSON.parse(data.slice(0, end))); } catch (error) { reject(error); }
    });
    socket.on('error', reject);
  });
}

test('Safari tool catalog is static and complete', async () => {
  const tools = safariTools();
  assert.equal(tools.length, 17);
  assert.ok(tools.some(tool => tool.name === 'navigate_to_url'));
  await assert.rejects(safariCall('not_a_tool'), /Unknown Safari MCP tool/);
});

test('daemon rejects implicit-current-tab calls and claims explicit actions', async t => {
  const claimed = [];
  const { socketPath } = await startFake(t, { claimApi: { claim: (...args) => claimed.push(args) } });
  const missing = await ipc(socketPath, { op: 'call', name: 'page_info', args: {}, owner: 'agent-a' });
  assert.equal(missing.error.code, 'TAB_REQUIRED');
  assert.match(missing.error.message, /explicit tab handle/);
  const listed = await ipc(socketPath, { op: 'call', name: 'list_tabs', args: {}, owner: 'agent-a' });
  assert.equal(listed.result.content[0].text, 'list_tabs');
  assert.deepEqual(claimed, []);
  const read = await ipc(socketPath, { op: 'call', name: 'page_info', args: {}, tab: 'native-handle-7', owner: 'agent-a', label: 'test' });
  assert.equal(read.result.content[0].text, 'page_info');
  assert.deepEqual(claimed[0], [SAFARI_CLAIM_PORT, 'native-handle-7', { owner: 'agent-a', label: 'test' }]);
});

test('mismatched explicit handles fail before switching or calling the tool', async t => {
  const events = [];
  const { socketPath } = await startFake(t, { callTool: async name => { events.push(name); return { content: [] }; } });
  const result = await ipc(socketPath, { op: 'call', name: 'navigate_to_url', args: { tab_uuid: 'tab-b', url: 'https://example.test' }, tab: 'tab-a', owner: 'agent-a' });
  assert.equal(result.error.code, 'TAB_MISMATCH');
  assert.deepEqual(events, []);
});

test('serialized switch and tool call prevent concurrent current-tab races', async t => {
  const events = [];
  const { socketPath } = await startFake(t, {
    callTool: async (name, args) => {
      events.push(`${name}:${args.handle || args.marker || ''}`);
      await new Promise(resolve => setTimeout(resolve, 15));
      return { content: [{ type: 'text', text: name }] };
    },
  });
  const [one, two] = await Promise.all([
    ipc(socketPath, { op: 'call', name: 'get_page_content', args: { marker: 'one' }, tab: 'tab-one', owner: 'a' }),
    ipc(socketPath, { op: 'call', name: 'get_page_content', args: { marker: 'two' }, tab: 'tab-two', owner: 'b' }),
  ]);
  assert.equal(one.result.content[0].text, 'get_page_content');
  assert.equal(two.result.content[0].text, 'get_page_content');
  assert.deepEqual(events, ['switch_tab:tab-one', 'get_page_content:one', 'switch_tab:tab-two', 'get_page_content:two']);
});

test('claim conflict prevents switch or page action', async t => {
  const events = [];
  const { socketPath } = await startFake(t, {
    claimApi: { claim(_port, handle, { owner }) { if (handle === 'held' && owner !== 'owner-a') throw Object.assign(new Error('claimed by another agent'), { code: 'CLAIMED' }); } },
    callTool: async name => { events.push(name); return { content: [] }; },
  });
  const result = await ipc(socketPath, { op: 'call', name: 'page_info', args: {}, tab: 'held', owner: 'owner-b' });
  assert.equal(result.error.code, 'CLAIMED');
  assert.deepEqual(events, []);
});

test('failed tab switch prevents requested action', async t => {
  const events = [];
  const { socketPath } = await startFake(t, {
    callTool: async name => {
      events.push(name);
      return name === 'switch_tab' ? { isError: true, content: [{ type: 'text', text: 'switch failed' }] } : { content: [] };
    },
  });
  const result = await ipc(socketPath, { op: 'call', name: 'page_info', args: {}, tab: 'tab-a', owner: 'agent-a' });
  assert.equal(result.error.code, 'SWITCH_FAILED');
  assert.deepEqual(events, ['switch_tab']);
});

test('failed close keeps its tab claim', async t => {
  const events = [];
  const { socketPath } = await startFake(t, {
    claimApi: { claim: (...args) => events.push(['claim', ...args]), release: (...args) => events.push(['release', ...args]) },
    callTool: async name => { events.push(['tool', name]); return { isError: true, content: [] }; },
  });
  const result = await ipc(socketPath, { op: 'call', name: 'close_tab', args: { handle: 'tab-a' }, owner: 'agent-a' });
  assert.equal(result.result.isError, true);
  assert.equal(events.some(event => event[0] === 'release'), false);
});

test('create_tab claims a clearly returned native handle and annotates ambiguous results', async t => {
  const claimed = [];
  let response = { structuredContent: { handle: 'created-uuid' }, content: [] };
  const { socketPath } = await startFake(t, { claimApi: { claim: (...args) => claimed.push(args) }, callTool: async () => response });
  await ipc(socketPath, { op: 'call', name: 'create_tab', args: {}, owner: 'creator', label: 'creator' });
  assert.deepEqual(claimed[0], [SAFARI_CLAIM_PORT, 'created-uuid', { owner: 'creator', label: 'creator' }]);
  response = { content: [{ type: 'text', text: 'created a tab' }] };
  const ambiguous = await ipc(socketPath, { op: 'call', name: 'create_tab', args: {}, owner: 'creator' });
  assert.match(ambiguous.result._meta.browserctrl_safari_claim, /Call list_tabs/);
});

test('daemon status does not initialize Safari and unknown backend tools are clear', async t => {
  let starts = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-safari-test-'));
  const socketPath = path.join(dir, 'safari.sock');
  const daemon = await createSafariDaemon({ socketPath, lockPath: `${socketPath}.lock`, platform: 'darwin', clientFactory: async () => { starts++; return { listTools: async () => ({ tools: fakeTools }), callTool: async () => ({ content: [] }), close: async () => {} }; } });
  t.after(async () => { await daemon.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  // Handshake is lazy: status has no tool count until the first call.
  const before = await ipc(socketPath, { op: 'status' });
  assert.equal(before.result.connected, false);
  assert.equal(starts, 0);
  const unknown = await ipc(socketPath, { op: 'call', name: 'missing_tool', args: {}, owner: 'agent-a' });
  assert.equal(unknown.error.code, 'UNKNOWN_TOOL');
  assert.match(unknown.error.message, /Unknown Safari MCP tool/);
  assert.equal(starts, 0);
});

test('daemon rejects malformed owners and protects shutdown from foreign claims or work', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-safari-test-'));
  const socketPath = path.join(dir, 'safari.sock');
  let foreignClaims = [];
  let starts = 0;
  const daemon = await createSafariDaemon({
    socketPath,
    lockPath: `${socketPath}.lock`,
    platform: 'darwin',
    claimApi: { list: () => foreignClaims },
    clientFactory: async () => { starts++; return { listTools: async () => ({ tools: fakeTools }), callTool: async () => ({ content: [] }), close: async () => {} }; },
  });
  t.after(async () => { await daemon.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  const malformed = await ipc(socketPath, { op: 'call', name: 'list_tabs', args: {}, owner: '  ' });
  assert.equal(malformed.error.code, 'INVALID_OWNER');
  assert.equal(starts, 0);
  foreignClaims = [{ targetId: 'tab-a', owner: 'someone-else' }];
  const foreignStop = await ipc(socketPath, { op: 'stop', owner: 'agent-a' });
  assert.equal(foreignStop.error.code, 'CLAIMED');
  foreignClaims = [];
  const stop = await ipc(socketPath, { op: 'stop', owner: 'agent-a' });
  assert.equal(stop.result.stopping, true);
});

test('daemon refuses shutdown during an in-flight browser call', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-safari-test-'));
  const socketPath = path.join(dir, 'safari.sock');
  let enteredResolve;
  let finishCall;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const daemon = await createSafariDaemon({
    socketPath,
    lockPath: `${socketPath}.lock`,
    platform: 'darwin',
    claimApi: { claim() {}, list: () => [] },
    clientFactory: async () => ({
      listTools: async () => ({ tools: fakeTools }),
      callTool: async name => {
        if (name === 'page_info') {
          enteredResolve();
          await new Promise(resolve => { finishCall = resolve; });
        }
        return { content: [] };
      },
      close: async () => {},
    }),
  });
  t.after(async () => { await daemon.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  const pending = ipc(socketPath, { op: 'call', name: 'page_info', args: {}, tab: 'tab-a', owner: 'agent-a' });
  await entered;
  const busy = await ipc(socketPath, { op: 'stop', owner: 'agent-a' });
  assert.equal(busy.error.code, 'DAEMON_BUSY');
  finishCall();
  await pending;
});

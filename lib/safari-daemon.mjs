#!/usr/bin/env node
// One daemon owns the official safaridriver MCP process and serializes every request.
import net from 'node:net';
import { createActivityMonitor } from './activity.mjs';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { acquireFileLock, releaseFileLock } from './file-lock.mjs';
import * as claims from './claims.mjs';
import { runtimePath } from './platform.mjs';

export const SAFARI_SOCKET = runtimePath('safari.sock');
export const SAFARI_CLAIM_PORT = 9228;
const MAX_REQUEST_BYTES = 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 120_000;
const MAX_PENDING = 128;
const NEEDS_TARGET = 'This Safari tool needs an explicit tab handle. Pass { tab: "<handle>" } (or the tool-specific tab_handle/tab_uuid/handle argument); it will not use Safari’s current tab implicitly.';
const AMBIGUOUS_CREATE_HINT = 'The new tab handle could not be read unambiguously. Call list_tabs, then use its exact handle in a later tab-targeted request.';
const SUPPORTED_TOOLS = new Set([
  'browser_console_messages', 'browser_dialogs', 'close_tab', 'create_tab',
  'evaluate_javascript', 'get_network_request', 'get_page_content', 'list_network_requests',
  'list_tabs', 'navigate_to_url', 'page_info', 'page_interactions', 'screenshot',
  'set_emulated_media', 'set_viewport_size', 'switch_tab', 'wait_for_navigation',
]);

const DEFAULT_CLIENT_FACTORY = async () => {
  if (process.platform !== 'darwin') throw new Error('The official Safari MCP server is available only on macOS.');
  const client = new Client({ name: 'browserctrl-safari', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: '/usr/bin/safaridriver', args: ['--mcp'], stderr: 'pipe' });
  transport.stderr?.on('data', chunk => process.stderr.write(`[safaridriver] ${chunk}`));
  let initTimer;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => { initTimer = setTimeout(() => reject(new Error('MCP initialization timed out')), 15_000); }),
    ]);
  }
  catch (cause) {
    try { await transport.close(); } catch {}
    const error = new Error(`Could not start Safari’s official MCP server: ${cause.message}. Check that Safari Remote Automation is enabled in Safari > Settings > Advanced.`);
    error.cause = cause;
    throw error;
  } finally { clearTimeout(initTimer); }
  return {
    async listTools() { return client.listTools({}, { timeout: 15_000 }); },
    async callTool(name, args) { return client.callTool({ name, arguments: args }, undefined, { timeout: RESPONSE_TIMEOUT_MS }); },
    async close() { await client.close(); },
  };
};

function errorShape(error) {
  return { code: error?.code || 'SAFARI_ERROR', message: error?.message || String(error) };
}
function validateOwner(owner) {
  if (typeof owner !== 'string' || !owner.trim() || owner.length > 256) {
    const error = new Error('Safari owner must be a nonempty string of at most 256 characters.');
    error.code = 'INVALID_OWNER';
    throw error;
  }
  return owner;
}
function handleFrom(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  const found = new Set();
  for (const key of ['handle', 'tab_handle', 'tab_uuid', 'uuid']) {
    if (typeof value[key] === 'string' && value[key]) found.add(value[key]);
  }
  for (const child of Object.values(value)) {
    if (typeof child === 'string') {
      try {
        const nested = JSON.parse(child);
        const nestedHandle = handleFrom(nested, seen);
        if (nestedHandle) found.add(nestedHandle);
      } catch {}
    } else if (child && typeof child === 'object') {
      const nestedHandle = handleFrom(child, seen);
      if (nestedHandle) found.add(nestedHandle);
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

function requestedTab(name, args, tab) {
  if (name === 'list_tabs' || name === 'create_tab') return null;
  const candidates = [tab, args.handle, args.tab_handle, args.tab_uuid].filter(value => value !== undefined && value !== null && value !== '');
  if (candidates.some(value => typeof value !== 'string')) {
    const error = new Error('Safari tab handles must be strings.'); error.code = 'INVALID_TAB_HANDLE'; throw error;
  }
  if (new Set(candidates).size > 1) {
    const error = new Error('Conflicting Safari tab handles were supplied. Pass the same exact handle in tab and tool arguments.'); error.code = 'TAB_MISMATCH'; throw error;
  }
  const handle = candidates[0] || null;
  if (typeof handle !== 'string' || !handle) {
    const error = new Error(NEEDS_TARGET); error.code = 'TAB_REQUIRED'; throw error;
  }
  return handle;
}

async function probeSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => socket.destroy(Object.assign(new Error('socket probe timeout'), { code: 'ETIMEDOUT' })), 700);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

async function bindOwnedSocket(server, socketPath) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = error => { server.off('listening', onListen); reject(error); };
        const onListen = () => { server.off('error', onError); resolve(); };
        server.once('error', onError); server.once('listening', onListen); server.listen(socketPath);
      });
      fs.chmodSync(socketPath, 0o600);
      return;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      const prior = fs.statSync(socketPath);
      try { await probeSocket(socketPath); throw Object.assign(new Error('Safari daemon socket is already owned by a live process'), { code: 'DAEMON_EXISTS' }); }
      catch (probeError) {
        if (probeError.code === 'DAEMON_EXISTS') throw probeError;
        if (!['ENOENT', 'ECONNREFUSED'].includes(probeError.code)) throw probeError;
      }
      try { if (fs.statSync(socketPath).ino === prior.ino) fs.unlinkSync(socketPath); }
      catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
    }
  }
  throw new Error('Could not acquire Safari daemon socket ownership');
}

export async function createSafariDaemon({
  socketPath = SAFARI_SOCKET,
  lockPath = `${socketPath}.lock`,
  clientFactory = DEFAULT_CLIENT_FACTORY,
  platform = process.platform,
  claimApi = claims,
  stopProcess = false,
  activityFile,
} = {}) {
  if (platform !== 'darwin') throw new Error('Safari provider is available only on macOS.');
  const lock = acquireFileLock(lockPath, { timeoutSeconds: 0 });
  if (lock === null) throw Object.assign(new Error('Safari daemon is already running or starting'), { code: 'DAEMON_EXISTS' });

  const activity = createActivityMonitor(SAFARI_CLAIM_PORT, activityFile ? {file: activityFile} : {});
  const ownedClaims = new Map();
  let sdkClient = null;
  let sdkTools = null;
  let stopping = false;
  let stopRequested = false;
  let socketIdentity = null;
  let shutdownTask = null;
  let queue = Promise.resolve();
  let active = 0;
  let lastError = null;
  const clients = new Set();
  const server = net.createServer(socket => {
    clients.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let handled = false;
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        socket.end(JSON.stringify({ error: { code: 'REQUEST_TOO_LARGE', message: 'Safari request exceeded 1 MiB.' } }) + '\n');
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0 || handled) return;
      handled = true;
      const line = buffer.slice(0, newline);
      let message;
      try { message = JSON.parse(line); }
      catch { socket.end(JSON.stringify({ error: { code: 'INVALID_JSON', message: 'Invalid Safari daemon request.' } }) + '\n'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        socket.end(JSON.stringify({error:{code:'INVALID_REQUEST',message:'Safari request must be an object.'}})+'\n'); return;
      }
      if (message.op === 'activity') {
        try {
          const owner = validateOwner(message.owner);
          if (message.action === 'describe' && message.activityOwner && message.activityOwner !== owner) throw Error('Describe only your own agent activity.');
          const result = activity.control(message.action || 'list', {owner: message.activityOwner || owner, label: message.label, intent: message.intent, completed: message.completed, total: message.total});
          socket.end(JSON.stringify({result: message.action === 'list' || !message.action ? activity.snapshot(claimApi.list(SAFARI_CLAIM_PORT)) : result}) + '\n');
        } catch (error) { socket.end(JSON.stringify({error: errorShape(error)}) + '\n'); }
        return;
      }
      if (message.op === 'status') {
        socket.end(JSON.stringify({ result: { available: true, connected: !!sdkClient, toolCount: sdkTools?.length ?? null, active, stopping, lastError } }) + '\n');
        return;
      }
      if (message.op === 'stop') {
        let owner;
        try { owner = validateOwner(message.owner); } catch (error) { socket.end(JSON.stringify({error:errorShape(error)})+'\n'); return; }
        let held;
        try { held = claimApi.list(SAFARI_CLAIM_PORT); }
        catch (error) { socket.end(JSON.stringify({ error: errorShape(error) }) + '\n'); return; }
        if (active > 0) {
          socket.end(JSON.stringify({ error: { code: 'DAEMON_BUSY', message: 'Safari daemon has an in-flight request; stop it after the request finishes.' } }) + '\n');
          return;
        }
        const foreign = held.find(claim => claim.owner !== owner);
        if (foreign) {
          socket.end(JSON.stringify({ error: { code: 'CLAIMED', message: `Safari daemon cannot stop while another agent owns tab ${foreign.targetId}.` } }) + '\n');
          return;
        }
        stopRequested = true;
        socket.end(JSON.stringify({ result: { stopping: true } }) + '\n');
        setImmediate(() => shutdown('requested'));
        return;
      }
      if (message.op !== 'call') {
        socket.end(JSON.stringify({ error: { code: 'INVALID_OPERATION', message: `Unknown Safari daemon operation: ${message.op}` } }) + '\n');
        return;
      }
      if (active >= MAX_PENDING) {
        socket.end(JSON.stringify({ error: { code: 'QUEUE_FULL', message: 'Safari daemon request queue is full; retry later.' } }) + '\n');
        return;
      }
      active++;
      const execute = () => {
        if (socket.destroyed) throw Object.assign(new Error('Safari caller disconnected before execution; request was not run.'),{code:'CALLER_DISCONNECTED'});
        return dispatch(message);
      };
      queue = queue.then(execute, execute).then(
        result => socket.end(JSON.stringify({ result }) + '\n'),
        error => { lastError = error.message; socket.end(JSON.stringify({ error: errorShape(error) }) + '\n'); },
      ).finally(() => { active--; clients.delete(socket); });
    });
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });

  async function ensureClient() {
    if (!sdkClient) {
      sdkClient = await clientFactory();
      try {
        const listed = await sdkClient.listTools();
        sdkTools = listed.tools || listed;
        if (!Array.isArray(sdkTools)) throw new Error('Safari MCP server returned an invalid tools list.');
      } catch (error) {
        try { await sdkClient.close?.(); } catch {}
        sdkClient = null; sdkTools = null;
        throw error;
      }
    }
    return sdkClient;
  }

  async function dispatch(message) {
    if (stopping || stopRequested) throw Object.assign(new Error('Safari daemon is stopping.'), { code: 'DAEMON_STOPPING' });
    const { name, args = {}, owner, label, tab } = message;
    validateOwner(owner);
    activity.assertRunning(owner);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw Object.assign(new Error('Safari tool arguments must be an object.'), { code: 'INVALID_ARGUMENTS' });
    if (!SUPPORTED_TOOLS.has(name)) throw Object.assign(new Error(`Unknown Safari MCP tool "${name}".`), { code: 'UNKNOWN_TOOL' });
    const client = await ensureClient(); // handshake/tool enumeration does not create a browser session
    const tool = sdkTools.find(item => item.name === name);
    if (!tool) throw Object.assign(new Error(`Safari MCP does not expose tool "${name}".`), { code: 'UNKNOWN_TOOL' });
    activity.assertRunning(owner);
    const handle = requestedTab(name, args, tab);
    if (handle) {
      claimApi.claim(SAFARI_CLAIM_PORT, handle, { owner, label });
      ownedClaims.set(handle, owner);
      if (name !== 'switch_tab' && name !== 'close_tab') {
        const switched = await client.callTool('switch_tab', { handle });
        if (switched?.isError) throw Object.assign(new Error('Safari could not switch to the requested tab; the requested tool was not run.'), { code: 'SWITCH_FAILED', result: switched });
      }
    }
    const nativeArgs = (name === 'switch_tab' || name === 'close_tab') && handle
      ? { ...args, handle }
      : args;
    activity.assertRunning(owner);
    const warnings = activity.observe({owner, label, targetId: handle, method: message.activityMethod === 'Page.reload' && name === 'evaluate_javascript' ? 'Page.reload' : name});
    const result = await client.callTool(name, nativeArgs);
    if (warnings.length) result.content = [...(result.content || []), {type: 'text', text: warnings.map(w => `Warning: ${w}`).join('\n')}];
    if (name === 'close_tab' && handle && !result?.isError) claimApi.release?.(SAFARI_CLAIM_PORT, handle, { owner });
    if (name === 'create_tab' && !result?.isError) {
      const createdHandle = handleFrom(result);
      if (createdHandle) { claimApi.claim(SAFARI_CLAIM_PORT, createdHandle, { owner, label }); ownedClaims.set(createdHandle, owner); }
      else return { ...result, _meta: { ...(result._meta || {}), browserctrl_safari_claim: AMBIGUOUS_CREATE_HINT } };
    }
    return result;
  }

  async function shutdown(reason = 'requested') {
    if (shutdownTask) return shutdownTask;
    stopping = true;
    shutdownTask = (async () => {
      for (const socket of clients) socket.destroy();
      try { await new Promise(resolve => server.close(resolve)); } catch {}
      try { await sdkClient?.close?.(); } catch (error) { lastError = error.message; }
      sdkClient = null;
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGINT', onSignal);
      try {
        if (socketIdentity && fs.statSync(socketPath).ino === socketIdentity.ino) fs.unlinkSync(socketPath);
      } catch (error) { if (error.code !== 'ENOENT') lastError = error.message; }
      for (const [handle, owner] of ownedClaims) { try { claimApi.release?.(SAFARI_CLAIM_PORT, handle, {owner}); } catch {} }
      releaseFileLock(lock);
      if (stopProcess) process.exit(reason === 'requested' ? 0 : 1);
    })();
    return shutdownTask;
  }

  try {
    await bindOwnedSocket(server, socketPath);
    socketIdentity = fs.statSync(socketPath);
  }
  catch (error) { releaseFileLock(lock); throw error; }
  const onSignal = () => shutdown('signal').then(() => { if (stopProcess) process.exit(0); });
  process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);
  return { server, dispatch, shutdown, getStatus: () => ({ available: true, connected: !!sdkClient, toolCount: sdkTools?.length ?? null, active, stopping, lastError }) };
}

export async function runSafariDaemon() {
  try { await createSafariDaemon({ stopProcess: true }); }
  catch (error) {
    if (error.code !== 'DAEMON_EXISTS') process.stderr.write(`Safari daemon failed: ${error.message}\n`);
    process.exit(error.code === 'DAEMON_EXISTS' ? 0 : 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runSafariDaemon();

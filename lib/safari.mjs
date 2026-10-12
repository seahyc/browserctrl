// Safari's official MCP tools, captured from Safari 27 on 2026-10-12.
// Apple provides browser control; this adapter adds shared ownership and transport.
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentId, agentLabel } from './env.mjs';
import { readFileSync } from 'node:fs';

const TOOLS = Object.freeze(JSON.parse(readFileSync(new URL('./safari-tools.json', import.meta.url), 'utf8')));
const SOCKET = '/tmp/browserctrl-safari.sock';
const DAEMON = fileURLToPath(new URL('./safari-daemon.mjs', import.meta.url));
const MAX_RESPONSE = 8 * 1024 * 1024;
const IPC_TIMEOUT_MS = 120_000;

export function safariTools() { return TOOLS.map(tool => structuredClone(tool)); }

function connect(pathname, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pathname);
    const timer = setTimeout(() => socket.destroy(Object.assign(new Error('Safari daemon connection timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

async function request(payload, { start = true, timeoutMs = IPC_TIMEOUT_MS } = {}) {
  if (process.platform !== 'darwin') throw new Error('Safari provider is available only on macOS.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > IPC_TIMEOUT_MS) throw new Error('Safari timeout must be greater than 0 and at most 120000ms.');
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  let socket;
  try { socket = await connect(SOCKET, Math.min(500, remaining())); }
  catch (error) {
    if (!start || !['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
    const child = spawn(process.execPath, [DAEMON], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    const until = Math.min(deadline, Date.now() + 10_000);
    let last = error;
    while (Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 50));
      try { socket = await connect(SOCKET, Math.min(300, remaining())); break; }
      catch (next) { last = next; if (!['ENOENT', 'ECONNREFUSED'].includes(next.code)) throw next; }
    }
    if (!socket) throw new Error(`Safari daemon did not become available: ${last.message}`);
  }
  if (Date.now() >= deadline) {
    socket?.destroy();
    throw new Error('Safari request deadline expired before sending. No action was sent or replayed.');
  }
  return new Promise((resolve, reject) => {
    let data = '';
    let settled = false;
    const done = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => done(Object.assign(new Error('Safari request timed out; action outcome may be unknown and was not retried.'), { code: 'ETIMEDOUT' })), remaining());
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      data += chunk;
      if (data.length > MAX_RESPONSE) return done(new Error('Safari daemon response exceeded size limit'));
      const newline = data.indexOf('\n');
      if (newline < 0) return;
      try {
        const result = JSON.parse(data.slice(0, newline));
        if (result.error) { const error = new Error(result.error.message); error.code = result.error.code; done(error); }
        else done(null, result.result);
      } catch (error) { done(new Error(`Invalid Safari daemon response: ${error.message}`)); }
    });
    socket.once('error', error => done(error));
    socket.once('end', () => { if (!settled) done(new Error('Safari daemon closed before replying')); });
    const line = JSON.stringify(payload) + '\n';
    if (Date.now() >= deadline) return done(new Error('Safari deadline expired before sending. No action was sent or replayed.'));
    socket.write(line);
  });
}

export function safariStatus() {
  if (process.platform !== 'darwin') return Promise.resolve({ available: false, error: 'Safari provider is available only on macOS.' });
  return request({ op: 'status' }, { start: false, timeoutMs: 2000 }).catch(error => ({ available: false, error: error.message }));
}
export function safariStop({ owner = agentId() } = {}) { return request({ op: 'stop', owner }, { start: false, timeoutMs: 3000 }); }

export async function safariCall(name, args = {}, { tab, owner = agentId(), label = agentLabel(), timeoutMs, activityMethod } = {}) {
  const known = TOOLS.find(tool => tool.name === name);
  if (!known) throw new Error(`Unknown Safari MCP tool "${name}". Use safariTools() to list supported tools.`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('Safari tool arguments must be an object');
  if (!['list_tabs', 'create_tab'].includes(name) &&
      !(typeof tab === 'string' && tab) &&
      ![args.handle, args.tab_handle, args.tab_uuid].some(value => typeof value === 'string' && value)) {
    const error = new Error('This Safari tool needs an explicit tab handle. Pass { tab: "<handle>" } or a tool-specific handle argument; Safari’s current tab will not be used implicitly.');
    error.code = 'TAB_REQUIRED';
    throw error;
  }
  return request({ op: 'call', name, args, tab, owner, label, activityMethod }, { start: true, ...(timeoutMs === undefined ? {} : {timeoutMs}) });
}

export function safariActivity(action = 'list', {owner, ...details} = {}) {
  return request({op: 'activity', action, activityOwner: owner, owner: agentId(), label: agentLabel(), ...details});
}

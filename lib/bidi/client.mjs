// A WebDriver BiDi client for Firefox-family browsers (Firefox, Camoufox).
//
// One command opens its own BiDi session and ends it: Firefox allows a single session at a
// time and ends a BiDi-only session when its WebSocket closes, so a crashed command never
// leaves the browser locked. A per-port file lock serializes commands from several agents.

import { acquireFileLock, releaseFileLock } from '../file-lock.mjs';
import { runtimePath } from '../platform.mjs';

const CONNECT_TIMEOUT_MS = 10_000;
export const COMMAND_TIMEOUT_MS = 60_000;

export class BidiError extends Error {
  constructor(error, message, method) {
    super(`${method ? `${method}: ` : ''}${error}${message ? `: ${message}` : ''}`);
    this.name = 'BidiError';
    this.error = error;
  }
}

/** Open ws://host:port/session and start a BiDi session. Resolves a session object. */
export async function openSession(port, { host = '127.0.0.1', WebSocketImpl = globalThis.WebSocket, timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  if (!WebSocketImpl) throw new Error('This Node.js has no WebSocket client (Node 22 or newer is required).');
  const url = `ws://${host}:${port}/session`;
  const ws = new WebSocketImpl(url);
  const pending = new Map();
  let nextId = 1;
  let closed = null;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error(`No WebDriver BiDi endpoint answered at ${url} within ${timeoutMs / 1000}s. Start the browser with browserctrl launch firefox|camoufox, or pass its --port.`)); }, timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(Object.assign(new Error(`Could not connect to WebDriver BiDi at ${url} (ECONNREFUSED or not a BiDi browser). Start it with browserctrl launch firefox|camoufox, or pass its --port.`), { code: 'ECONNREFUSED' })); }, { once: true });
  });
  ws.addEventListener('message', event => {
    let msg;
    try { msg = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8')); } catch { return; }
    if (msg.id === undefined || !pending.has(msg.id)) return;
    const { resolve, reject, method, timer } = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(timer);
    if (msg.type === 'error' || msg.error) reject(new BidiError(msg.error, msg.message, method));
    else resolve(msg.result ?? {});
  });
  ws.addEventListener('close', () => {
    closed = new Error('The browser closed the WebDriver BiDi connection');
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(closed); }
    pending.clear();
  });

  const debug = Boolean(process.env.BROWSERCTRL_BIDI_DEBUG);
  const trace = (id, method, started, outcome) => {
    if (debug) process.stderr.write(`[bidi] #${id} ${method} ${Date.now() - started}ms ${outcome}\n`);
  };
  const send = (method, params = {}, { timeoutMs: limit = COMMAND_TIMEOUT_MS } = {}) => new Promise((resolve, reject) => {
    if (closed) return reject(closed);
    const id = nextId++;
    const started = Date.now();
    if (debug) {
      const ok = resolve, ko = reject;
      resolve = v => { trace(id, method, started, 'ok'); ok(v); };
      reject = e => { trace(id, method, started, `error: ${e.message}`); ko(e); };
    }
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error(`${method} timed out after ${limit / 1000}s; its outcome is unknown and it was not retried`), { code: 'ETIMEDOUT' }));
    }, limit);
    pending.set(id, { resolve, reject, method, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });

  let info;
  try {
    info = await send('session.new', { capabilities: {} });
  } catch (error) {
    try { ws.close(); } catch {}
    if (/session not created|maximum number of active sessions/i.test(error.message)) {
      throw new Error(`The browser on port ${port} already has a WebDriver BiDi session (another client, or geckodriver). Only one is allowed; close that client and retry. (${error.message})`);
    }
    throw error;
  }
  return {
    send,
    capabilities: info.capabilities || {},
    get closed() { return closed !== null; },
    async close() {
      try { await send('session.end', {}, { timeoutMs: 3000 }); } catch {}
      try { ws.close(); } catch {}
    },
  };
}

// Callers in one process queue per port (the file lock below blocks synchronously, so it
// only serializes separate processes).
const queues = new Map();

/** Run fn(session) with the port's lock held and a fresh session; always ends the session. */
export async function withSession(port, fn, { open = openSession, lockTimeoutSeconds = 60, lock = true } = {}) {
  const previous = queues.get(port) || Promise.resolve();
  let done;
  const turn = new Promise(resolve => { done = resolve; });
  const tail = previous.then(() => turn);
  queues.set(port, tail);
  await previous;
  try {
    const held = lock ? acquireFileLock(runtimePath(`bidi-${port}.lock`), { timeoutSeconds: lockTimeoutSeconds }) : null;
    if (lock && held === null) throw new Error(`Another browserctrl command is using the browser on port ${port}; it did not finish within ${lockTimeoutSeconds}s.`);
    try {
      const session = await open(port);
      try { return await fn(session); } finally { await session.close(); }
    } finally {
      if (held !== null) releaseFileLock(held);
    }
  } finally {
    done();
    if (queues.get(port) === tail) queues.delete(port);
  }
}

/** A BiDi RemoteValue as a plain JavaScript value (best effort for display and JSON). */
export function deserialize(value) {
  if (!value || typeof value !== 'object') return value;
  switch (value.type) {
    case 'undefined': return undefined;
    case 'null': return null;
    case 'string': case 'boolean': return value.value;
    case 'number':
      if (value.value === 'NaN') return NaN;
      if (value.value === '-0') return -0;
      if (value.value === 'Infinity') return Infinity;
      if (value.value === '-Infinity') return -Infinity;
      return value.value;
    case 'bigint': return `${value.value}n`;
    case 'array': case 'set': return (value.value || []).map(deserialize);
    case 'object': case 'map':
      return Object.fromEntries((value.value || []).map(([k, v]) => [typeof k === 'string' ? k : String(deserialize(k)), deserialize(v)]));
    case 'date': return value.value;
    case 'regexp': return `/${value.value?.pattern}/${value.value?.flags || ''}`;
    case 'node': return `[${value.value?.localName || 'node'}]`;
    case 'window': return '[window]';
    default: return `[${value.type}]`;
  }
}

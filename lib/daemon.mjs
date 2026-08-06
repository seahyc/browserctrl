// Per-port master daemon.
//
// Why a daemon at all: Chrome shows "Allow remote debugging?" on EVERY new
// debugging connection. One long-lived connection per port means the popup
// fires once. It also gives us somewhere to buffer console/network events
// between CLI invocations, which a one-shot process cannot do.
//
// The daemon owns: the browser WebSocket, per-target attached sessions, and
// the event ring buffers. It exits when the browser goes away for good or
// after IDLE_EXIT_MS with no requests.
import net from 'net';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { SOCK, IDLE_EXIT_MS, DEFAULT_TIMEOUT_MS } from './env.mjs';
import { browserWsUrl } from './discovery.mjs';
import * as annotations from './annotations.mjs';
import * as state from './state.mjs';
import { appendEvents } from './recstore.mjs';

// A daemon started before a code change keeps running the old logic, which
// looks exactly like a mysterious bug. Clients compare this and restart a
// stale daemon rather than debugging a ghost.
export function codeVersion() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  let newest = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.mjs')) continue;
    const m = fs.statSync(path.join(dir, f)).mtimeMs;
    if (m > newest) newest = m;
  }
  return String(Math.round(newest));
}

const RING = 500;
// Reconnect fast, then back off: a browser relaunch is the common case and it
// is usually back within a second or two.
const RECONNECT_DELAYS_MS = [200, 500, 1000, 2000, 4000, 8000];
const WAIT_FOR_RECONNECT_MS = 10000;
const HEALTH_TIMEOUT_MS = 2500;

function ringPush(arr, item) {
  arr.push(item);
  if (arr.length > RING) arr.splice(0, arr.length - RING);
}

const MY_CODE = codeVersion();

export async function runDaemon(port) {
  let ws = null;
  let nextId = 1;
  const pending = new Map();
  const sessions = new Map(); // targetId -> sessionId
  const buffers = new Map(); // targetId -> {console:[], errors:[], network:[]}
  let lastActivity = Date.now();
  let stopping = false;
  let connected = false;

  const bufFor = targetId => {
    if (!buffers.has(targetId)) buffers.set(targetId, { console: [], errors: [], network: [] });
    return buffers.get(targetId);
  };
  const targetOf = sessionId => {
    for (const [t, s] of sessions) if (s === sessionId) return t;
    return null;
  };

  const shutdown = () => {
    stopping = true;
    try {
      fs.unlinkSync(SOCK(port));
    } catch {}
    process.exit(0);
  };

  function wire(socket) {
    socket.onmessage = e => {
      const d = JSON.parse(e.data);
      if (d.id && pending.has(d.id)) {
        const { resolve, reject } = pending.get(d.id);
        pending.delete(d.id);
        return d.error ? reject(new Error(d.error.message)) : resolve(d.result);
      }
      if (!d.method) return;
      const targetId = d.sessionId ? targetOf(d.sessionId) : null;
      if (d.method === 'Target.detachedFromTarget' || d.method === 'Target.targetDestroyed') {
        const gone = d.params?.targetId ?? targetId;
        if (gone) {
          sessions.delete(gone);
          buffers.delete(gone);
        }
        return;
      }
      if (d.method === 'Runtime.bindingCalled' && d.params?.name === '__cdpSend') {
        // The overlay hands annotations back through a CDP binding rather than
        // HTTP: current Chromium blocks an HTTPS page from reaching loopback.
        collectFromPage(targetId, d.params.payload).catch(() => {});
        return;
      }
      if (!targetId) return;
      const buf = bufFor(targetId);
      if (d.method === 'Runtime.consoleAPICalled') {
        ringPush(buf.console, {
          ts: Date.now(),
          level: d.params.type,
          text: (d.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' '),
        });
      } else if (d.method === 'Log.entryAdded') {
        ringPush(buf.console, {
          ts: Date.now(),
          level: d.params.entry.level,
          text: d.params.entry.text,
          url: d.params.entry.url,
        });
      } else if (d.method === 'Runtime.exceptionThrown') {
        const ex = d.params.exceptionDetails;
        ringPush(buf.errors, {
          ts: Date.now(),
          text: ex.exception?.description || ex.text,
          url: ex.url,
          line: ex.lineNumber,
        });
      } else if (d.method === 'Network.requestWillBeSent') {
        ringPush(buf.network, {
          ts: Date.now(),
          requestId: d.params.requestId,
          method: d.params.request.method,
          url: d.params.request.url,
          status: null,
        });
      } else if (d.method === 'Network.responseReceived') {
        const row = buf.network.findLast(r => r.requestId === d.params.requestId);
        if (row) {
          row.status = d.params.response.status;
          row.mimeType = d.params.response.mimeType;
        }
      } else if (d.method === 'Network.loadingFailed') {
        const row = buf.network.findLast(r => r.requestId === d.params.requestId);
        if (row) {
          row.failed = true;
          row.errorText = d.params.errorText;
        }
      }
    };
    socket.onclose = async () => {
      if (stopping) return;
      connected = false;
      sessions.clear();
      // Anything in flight is gone with the socket: fail it now rather than
      // letting callers sit until their timeout.
      for (const [id, p] of pending) {
        pending.delete(id);
        p.reject(new Error('Browser connection dropped mid-request. Retry once it is back.'));
      }
      // The browser may just be restarting, e.g. `cdp launch dia`.
      for (const delay of RECONNECT_DELAYS_MS) {
        await new Promise(r => setTimeout(r, delay));
        if (stopping) return;
        try {
          const url = await browserWsUrl(port);
          const next = new WebSocket(url);
          await new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('timeout')), 10000);
            next.onopen = () => {
              clearTimeout(t);
              res();
            };
            next.onerror = () => {
              clearTimeout(t);
              rej(new Error('failed'));
            };
          });
          ws = next;
          connected = true;
          wire(next);
          return;
        } catch {
          /* keep trying */
        }
      }
      shutdown();
    };
  }

  // An annotation arriving from the page. The page knows which element and
  // what note; only we can add the tab identity and a cropped screenshot.
  async function collectFromPage(targetId, raw) {
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      return;
    }
    if (envelope.kind === 'events') {
      appendEvents(envelope.id, envelope.rows || []);
      return;
    }
    if (envelope.kind !== 'annotation') return;
    const payload = envelope.payload || {};
    const row = annotations.add({
      ...payload,
      tab: { targetId, port, alias: state.getAlias(port, targetId) },
    });
    const box = payload.element?.box;
    const scroll = payload.element?.scroll || { x: 0, y: 0 };
    if (box) {
      try {
        const pad = 8;
        const sessionId = await sessionFor(targetId);
        const shot = await send(
          'Page.captureScreenshot',
          {
            format: 'png',
            captureBeyondViewport: true,
            clip: {
              x: Math.max(0, box.x + scroll.x - pad),
              y: Math.max(0, box.y + scroll.y - pad),
              width: box.w + pad * 2,
              height: box.h + pad * 2,
              scale: 1,
            },
          },
          sessionId,
          20000,
        );
        fs.writeFileSync(annotations.shotPath(row.id), Buffer.from(shot.data, 'base64'));
        annotations.update(row.id, { screenshot: annotations.shotPath(row.id) });
      } catch {
        /* a screenshot is a nicety; the annotation itself already landed */
      }
    }
    // Annotating a tab is itself a handover, so mark it for the agent.
    state.mark(port, targetId, { note: payload.note, url: payload.page?.url, title: payload.page?.title });
  }

  // Requests that arrive while we are between browsers wait briefly for the
  // reconnect instead of being written into a dead socket.
  async function ensureConnected() {
    if (connected) return;
    const deadline = Date.now() + WAIT_FOR_RECONNECT_MS;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
      if (connected) return;
    }
    throw new Error(
      `The browser on port ${port} is not connected. It may have quit. Check with: cdp browsers`,
    );
  }

  const url = await browserWsUrl(port);
  ws = new WebSocket(url);
  await new Promise((res, rej) => {
    // Generous: the first connect can sit behind Chrome's Allow popup.
    const t = setTimeout(() => rej(new Error('browser WS connect timeout')), 60000);
    ws.onopen = () => {
      clearTimeout(t);
      res();
    };
    ws.onerror = () => {
      clearTimeout(t);
      rej(new Error('browser WS connect failed'));
    };
  });
  connected = true;
  wire(ws);

  const send = async (method, params = {}, sessionId, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    await ensureConnected();
    return new Promise((resolve, reject) => {
      lastActivity = Date.now();
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          reject(
            new Error(
              `${method} timed out after ${timeoutMs}ms. The tab may be suspended by memory saver ` +
                `(cdp wake <tab>), busy, or waiting on a modal.`,
            ),
          );
        }
      }, timeoutMs);
      pending.set(id, {
        resolve: v => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: e => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  };

  const enabled = new Set();
  async function sessionFor(targetId, { light = false } = {}) {
    if (sessions.has(targetId)) {
      const existing = sessions.get(targetId);
      if (light || enabled.has(targetId)) return existing;
      await enableDomains(targetId, existing);
      return existing;
    }
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    sessions.set(targetId, sessionId);
    if (light) return sessionId;
    await enableDomains(targetId, sessionId);
    return sessionId;
  }

  // Enable the domains we buffer. Failures are non-fatal: a target that
  // refuses one domain should not make the tab undriveable.
  async function enableDomains(targetId, sessionId) {
    enabled.add(targetId);
    // The overlay's transport. Harmless on pages with no overlay.
    await send('Runtime.addBinding', { name: '__cdpSend' }, sessionId, 5000).catch(() => {});
    for (const [domain, params] of [
      ['Runtime', {}],
      ['Log', {}],
      ['Page', {}],
      ['Network', {}],
    ]) {
      await send(`${domain}.enable`, params, sessionId, 5000).catch(() => {});
    }
  }

  try {
    fs.unlinkSync(SOCK(port));
  } catch {}

  const server = net.createServer(sock => {
    let buf = '';
    sock.on('data', async chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        const reply = obj => {
          try {
            sock.write(JSON.stringify({ reqId: req.reqId, ...obj }) + '\n');
          } catch {}
        };
        lastActivity = Date.now();
        try {
          if (req.op === 'ping') reply({ result: 'pong' });
          else if (req.op === 'health') {
            // Answered by the browser, not by us: this is what tells a client
            // that the daemon is still attached to a live browser rather than
            // sitting on a dead socket.
            try {
              const v = await send('Browser.getVersion', {}, undefined, HEALTH_TIMEOUT_MS);
              reply({ result: { ok: true, connected, browser: v.product, code: MY_CODE } });
            } catch (e) {
              reply({ result: { ok: false, connected, reason: e.message, code: MY_CODE } });
            }
          } else if (req.op === 'status') {
            reply({ result: { port, attached: [...sessions.keys()], since: lastActivity } });
          } else if (req.op === 'stop') {
            reply({ result: 'stopping' });
            setTimeout(shutdown, 50);
          } else if (req.op === 'browser') {
            reply({ result: await send(req.method, req.params, undefined, req.timeoutMs) });
          } else if (req.op === 'cdp') {
            const sessionId = req.targetId ? await sessionFor(req.targetId, { light: Boolean(req.light) }) : undefined;
            reply({ result: await send(req.method, req.params, sessionId, req.timeoutMs) });
          } else if (req.op === 'events') {
            const b = bufFor(req.targetId);
            const out = {
              console: b.console.slice(-(req.limit ?? 100)),
              errors: b.errors.slice(-(req.limit ?? 100)),
              network: b.network.slice(-(req.limit ?? 100)),
            };
            if (req.clear) buffers.set(req.targetId, { console: [], errors: [], network: [] });
            reply({ result: out });
          } else if (req.op === 'detach') {
            const sessionId = sessions.get(req.targetId);
            if (sessionId) {
              await send('Target.detachFromTarget', { sessionId }).catch(() => {});
              sessions.delete(req.targetId);
            }
            reply({ result: 'detached' });
          } else reply({ error: `unknown op ${req.op}` });
        } catch (e) {
          reply({ error: e.message });
        }
      }
    });
    sock.on('error', () => {});
  });
  server.listen(SOCK(port));
  setInterval(() => {
    if (Date.now() - lastActivity > IDLE_EXIT_MS) shutdown();
  }, 60000).unref?.();
}

// ------------------------------------------------------------------ client --

function sockConnect(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCK(port));
    sock.on('connect', () => resolve(sock));
    sock.on('error', reject);
  });
}

// A one-shot request against an already-open daemon socket, used for the
// health probe before we decide to reuse a daemon.
function askOnce(sock, payload, timeoutMs) {
  return new Promise(resolve => {
    let buf = '';
    const finish = value => {
      sock.removeListener('data', onData);
      clearTimeout(timer);
      resolve(value);
    };
    const onData = chunk => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      try {
        finish(JSON.parse(buf.slice(0, nl)).result ?? null);
      } catch {
        finish(null);
      }
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on('data', onData);
    sock.write(JSON.stringify({ reqId: 0, ...payload }) + '\n');
  });
}

async function ensureDaemon(port) {
  try {
    const existing = await sockConnect(port);
    const health = await askOnce(existing, { op: 'health' }, HEALTH_TIMEOUT_MS + 1000);
    if (health?.ok && health.code === codeVersion()) return existing;
    if (health?.ok) process.stderr.write('(restarting the daemon: it is running older code than this CLI)\n');
    // A daemon whose browser died (or was replaced by a new instance on the
    // same port) must not be reused: every request would hang until timeout.
    existing.write(JSON.stringify({ reqId: 0, op: 'stop' }) + '\n');
    existing.end();
    await new Promise(r => setTimeout(r, 300));
  } catch {
    /* not running, or stale socket */
  }
  try {
    fs.unlinkSync(SOCK(port));
  } catch {}
  // Fail fast with the actionable hint if nothing is debuggable on this port.
  await browserWsUrl(port);
  const self = path.join(path.dirname(fileURLToPath(import.meta.url)), 'daemon-run.mjs');
  spawn(process.execPath, [self, String(port)], { detached: true, stdio: 'ignore' }).unref();
  const deadline = Date.now() + 60000;
  let warned = false;
  while (Date.now() < deadline) {
    try {
      return await sockConnect(port);
    } catch {
      /* not up yet */
    }
    if (!warned && Date.now() > deadline - 55000) {
      process.stderr.write('(starting daemon: if the browser shows "Allow remote debugging?", click Allow once)\n');
      warned = true;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Daemon failed to start within 60s (Allow popup not clicked, or the browser rejected the connection).');
}

export async function connect(port) {
  const sock = await ensureDaemon(port);
  let buf = '';
  let nextReq = 1;
  const pending = new Map();
  sock.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const d = JSON.parse(line);
      const p = pending.get(d.reqId);
      if (p) {
        pending.delete(d.reqId);
        d.error ? p.reject(new Error(d.error)) : p.resolve(d.result);
      }
    }
  });
  const request = obj =>
    new Promise((resolve, reject) => {
      const reqId = nextReq++;
      pending.set(reqId, { resolve, reject });
      sock.write(JSON.stringify({ reqId, ...obj }) + '\n');
    });
  return {
    port,
    browser: (method, params = {}, timeoutMs) => request({ op: 'browser', method, params, timeoutMs }),
    send: (targetId, method, params = {}, timeoutMs, opts = {}) =>
      request({ op: 'cdp', targetId, method, params, timeoutMs, light: opts.light }),
    events: (targetId, opts = {}) => request({ op: 'events', targetId, ...opts }),
    detach: targetId => request({ op: 'detach', targetId }),
    health: () => request({ op: 'health' }),
    status: () => request({ op: 'status' }),
    stop: () => request({ op: 'stop' }),
    close: () => sock.end(),
  };
}

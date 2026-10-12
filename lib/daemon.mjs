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
import {extensionReads, extensionScoped, affectedExtensionTabs, assertExtensionClaims} from './extension-access.mjs';
import {planNativeGroup,groupNativeTabs} from './tab-control.mjs';
import {getNativeTabAdapter} from './adapters/index.mjs';
import { createTelemetry } from './telemetry.mjs';
import { createActivityMonitor } from './activity.mjs';
import { runQueuedInput } from './input-queue.mjs';
import { acquireFileLock, releaseFileLock } from './file-lock.mjs';
import { createProtocolTrace } from './protocol-trace.mjs';
import fs from 'fs';
import { spawn, execFile } from 'child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'url';
import path from 'path';
import { SOCK, IDLE_EXIT_MS, DEFAULT_TIMEOUT_MS, PORT_TO_KEY, runtimePath } from './env.mjs';
import { browserWsUrl } from './discovery.mjs';
import * as claims from './claims.mjs';
import { agentId, agentLabel } from './env.mjs';
import * as annotations from './annotations.mjs';
import * as state from './state.mjs';
import { appendEvents, readActive } from './recstore.mjs';
import * as sessions from './sessions.mjs';
import { createCapture } from './exemplars.mjs';

// A daemon started before a code change keeps running the old logic, which
// looks exactly like a mysterious bug. Clients compare this and restart a
// stale daemon rather than debugging a ghost.
export function codeVersion() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  let newest = 0;
  for (const f of fs.readdirSync(dir, {recursive:true})) {
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
const HEALTH_TIMEOUT_MS = 30000;
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const IPC_LIVENESS_TIMEOUT_MS = 30000;
const IPC_TIMEOUT_GRACE_MS = 2000;
const TAB_INITIALIZATION_ALLOWANCE_MS = 60000;
// Commands that need the page's event loop running to complete.
const THAW_BEFORE = /^(Runtime\.(evaluate|callFunctionOn|awaitPromise)|Input\.|Page\.(navigate|reload|captureScreenshot)|DOM\.)/;

function ringPush(arr, item) {
  arr.push(item);
  if (arr.length > RING) arr.splice(0, arr.length - RING);
}

const MY_CODE = codeVersion();
const exec = promisify(execFile);
const ownerFile = port => process.platform === 'win32' ? runtimePath(`daemon-${port}.owner.json`) : `${SOCK(port)}.owner.json`;

function openBrowserSocket(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    const fail = message => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.onopen = () => socket.close();
      socket.close();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail('browser WS connect timeout'), timeoutMs);
    socket.onopen = () => { settled = true; clearTimeout(timer); resolve(socket); };
    socket.onerror = () => fail('browser WS connect failed');
  });
}

async function bindDaemonSocket(server, port) {
  const listen = () => new Promise((resolve, reject) => {
    const onError = error => { server.off('listening', onListen); reject(error); };
    const onListen = () => { server.off('error', onError); resolve(true); };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(SOCK(port));
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await listen(); } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
    if (process.platform === 'win32') {
      try { const owner = await sockConnect(port); owner.destroy(); return false; }
      catch (error) {
        if (!['ENOENT', 'ECONNREFUSED', 'EPIPE'].includes(error.code)) throw error;
        continue;
      }
    }
    let identity;
    try { identity = fs.statSync(SOCK(port)); } catch { continue; }
    try {
      const owner = await sockConnect(port);
      owner.destroy();
      return false;
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
    }
    try {
      if (fs.statSync(SOCK(port)).ino === identity.ino) fs.unlinkSync(SOCK(port));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('Could not acquire daemon socket ownership');
}

export async function runDaemon(port) {
  const telemetry = createTelemetry(port);
  const activity = createActivityMonitor(port);
  telemetry('daemon_start', { codeVersion: MY_CODE });
  const lock = acquireFileLock(`${SOCK(port)}.lock`, { timeoutSeconds: 0 });
  if (lock === null) { telemetry('lock_skipped'); return; }
  const trace = createProtocolTrace(process.env.CDP_DIAGNOSTIC_LOG, port);
  let ws = null;
  let nextId = 1;
  const pending = new Map();
  const sessions = new Map(); // targetId -> sessionId
  const activeTargets = new Map();
  const activeBrowserOwners = new Map();
  let activeGlobal = null;
  const targetTypes = new Map();
  const inputQueues = new Map();
  const buffers = new Map(); // targetId -> {console:[], errors:[], network:[]}
  // Fetch/XHR exemplars from attached tabs, for `browserctrl api endpoints`.
  const capture = createCapture({ getBody: (requestId, sessionId) => send('Network.getResponseBody', { requestId }, sessionId, 5000) });
  let lastActivity = Date.now();
  let stopping = false;
  let connected = false;
  let initialized = false;
  let socketIdentity = null;
  let healthProbe = null;
  let retiring = false;
  let replySequence = 0;

  const bufFor = targetId => {
    if (!buffers.has(targetId)) buffers.set(targetId, { console: [], errors: [], network: [] });
    return buffers.get(targetId);
  };
  const targetOf = sessionId => {
    for (const [t, s] of sessions) if (s === sessionId) return t;
    return null;
  };

  const shutdown = (reason = 'requested') => {
    telemetry('shutdown', { reason, pendingCount: pending.size });
    stopping = true;
    try { capture.store.flush(); } catch {}
    try {
      if (process.platform === 'win32') {
        const owner = readOwner(port);
        if (owner?.pid === process.pid && owner?.processStart === socketIdentity?.processStart) fs.unlinkSync(ownerFile(port));
      } else if (socketIdentity?.ino === fs.statSync(SOCK(port)).ino) {
        fs.unlinkSync(SOCK(port));
        fs.unlinkSync(ownerFile(port));
      }
    } catch {}
    process.exit(0);
  };

  function wire(socket) {
    socket.onmessage = e => {
      if (socket !== ws || stopping) return;
      const d = JSON.parse(e.data);
      if (d.id) { replySequence++; trace('reply', {id:d.id, result:d.result, errorCode:d.error?.code}); }
      else if (d.method?.startsWith('Target.')) trace('event', d);
      if (d.id && pending.has(d.id)) {
        const { resolve, reject } = pending.get(d.id);
        pending.delete(d.id);
        return d.error ? reject(new Error(d.error.message)) : resolve(d.result);
      }
      if (!d.method) return;
      const targetId = d.sessionId ? targetOf(d.sessionId) : null;
      if (d.method === 'Target.targetCreated' && d.params?.targetInfo?.type === 'page') {
        // A tab that appears mid-recording has to be instrumented now, not when
        // a poll gets round to it: the interesting click is usually the first
        // thing that happens in a tab someone just opened.
        instrumentNewTarget(d.params.targetInfo.targetId).catch(() => {});
        return;
      }
      if (d.method === 'Target.detachedFromTarget' || d.method === 'Target.targetDestroyed') {
        const gone = d.params?.targetId ?? targetId;
        if (gone) {
          sessions.delete(gone);
          enabled.delete(gone);
          buffers.delete(gone);
          targetTypes.delete(gone);
          if (d.method === 'Target.targetDestroyed') {
            try {
              if (claims.get(port, gone)) claims.release(port, gone, { steal: true });
            } catch { /* A claims error is reported on the next caller operation. */ }
          }
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
      if (d.method.startsWith('Network.')) capture.onEvent(d.method, d.params, d.sessionId);
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
      trace('disconnected');
      if (stopping || socket !== ws) return;
      telemetry('browser_disconnected', { pendingCount: pending.size });
      connected = false;
      sessions.clear();
      enabled.clear();
      buffers.clear();
      targetTypes.clear();
      attaching.clear();
      // Anything in flight is gone with the socket: fail it now rather than
      // letting callers sit until their timeout.
      for (const [id, p] of pending) {
        pending.delete(id);
        p.reject(
          new Error(
            'Browser connection dropped mid-request. Its outcome is uncertain; it was not replayed. ' +
              'Observe current browser state before deciding whether to retry.',
          ),
        );
      }
      // The browser may just be restarting, e.g. `cdp launch dia`.
      let attempt = 0;
      for (const delay of RECONNECT_DELAYS_MS) {
        await new Promise(r => setTimeout(r, delay));
        if (stopping) return;
        telemetry('reconnect_attempt', { attempt: ++attempt });
        try {
          const url = await browserWsUrl(port);
          const next = await openBrowserSocket(url, APPROVAL_TIMEOUT_MS);
          ws = next;
          connected = true;
          wire(next);
          telemetry('reconnected', { attempt });
          armTargetDiscovery().catch(() => {});
          return;
        } catch {
          telemetry('reconnect_failed', { attempt });
        }
      }
      telemetry('reconnect_exhausted');
      shutdown('reconnect_exhausted');
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
    // A CDP binding is one-way, so an answer goes back as an evaluate.
    if (envelope.kind === 'pins-request' || envelope.kind === 'resolve') {
      if (envelope.kind === 'resolve') annotations.remove(envelope.id);
      const rows = annotations.forPage(envelope.url);
      const payload = JSON.stringify({ pins: rows, sessions: sessions.live() });
      const sessionId = await sessionFor(targetId);
      await send(
        'Runtime.evaluate',
        {
          expression: `window.__cdpOverlay && window.__cdpOverlay.setPins(${JSON.stringify(rows)}, ${JSON.stringify(sessions.live())})`,
          returnByValue: true,
        },
        sessionId,
        5000,
      ).catch(() => {});
      void payload;
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
    if (retiring) throw new Error('Browser transport is retiring. No new request was sent or replayed.');
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

  const send = async (method, params = {}, sessionId, timeoutMs = DEFAULT_TIMEOUT_MS, probe = false) => {
    await ensureConnected();
    return new Promise((resolve, reject) => {
      lastActivity = Date.now();
      const id = nextId++;
      trace('send', {id, method, sessionId, params});
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          trace('timeout', {id, method, sessionId});
          telemetry('protocol_timeout', { method, durationMs: timeoutMs, pendingCount: pending.size });
          reject(
            new Error(
              `${method} timed out after ${timeoutMs}ms. Its outcome is uncertain; it was not replayed. ` +
                `The tab may be suspended, busy, or waiting on a modal.`,
            ),
          );
          if (!probe) void checkTransport();
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
      try {
        ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      } catch {
        pending.get(id)?.reject(new Error('Browser transport write failed. Its outcome is uncertain; it was not replayed.'));
        pending.delete(id);
        if (!probe) void checkTransport();
      }
    });
  };

  async function checkTransport() {
    if (!connected) return { ok: false, recovering: true, code: MY_CODE, pid: process.pid };
    if (retiring) return { ok: false, retiring: true, code: MY_CODE, pid: process.pid };
    if (healthProbe) return healthProbe;
    const transport = ws;
    const repliesBeforeProbe = replySequence;
    healthProbe = (async () => {
      try {
        const v = await send('Browser.getVersion', {}, undefined, HEALTH_TIMEOUT_MS, true);
        telemetry('health', { reason: 'healthy' });
        return { ok: true, connected, browser: v.product, code: MY_CODE, pid: process.pid };
      } catch (e) {
        if (!connected || ws !== transport) return { ok: false, recovering: true, code: MY_CODE, pid: process.pid };
        if (replySequence !== repliesBeforeProbe) {
          telemetry('health', { reason: 'busy' });
          return { ok: false, busy: true, connected: true, code: MY_CODE, pid: process.pid };
        }
        retiring = true;
        // Retire only after a browser-level probe fails, not for a stalled page.
        telemetry('health', { reason: 'unhealthy_transport' });
        setTimeout(() => shutdown('unhealthy_transport'), 50);
        return { ok: false, connected: false, reason: e.message, code: MY_CODE, pid: process.pid };
      }
    })();
    try { return await healthProbe; } finally { healthProbe = null; }
  }

  const enabled = new Set();
  const attaching = new Map();
  async function sessionFor(targetId, { light = false, attachTimeoutMs } = {}) {
    if (attaching.has(targetId)) {
      await attaching.get(targetId);
      return sessionFor(targetId, { light, attachTimeoutMs });
    }
    if (sessions.has(targetId) && (light || enabled.has(targetId))) return sessions.get(targetId);
    const transport = ws;
    const task = (async () => {
      let sessionId = sessions.get(targetId);
      if (!sessionId) {
        ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, undefined, attachTimeoutMs));
        if (ws !== transport) throw new Error('Browser changed during attachment; observe again.');
        sessions.set(targetId, sessionId);
      }
      if (!light) await enableDomains(targetId, sessionId);
      return sessionId;
    })();
    attaching.set(targetId, task);
    try { return await task; } finally {
      if (attaching.get(targetId) === task) attaching.delete(targetId);
    }
  }

  async function extensionSession(targetInfos) {
    const workers = targetInfos.filter(t => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
    try {
      return await Promise.any(workers.map(async worker => {
        const sid = await sessionFor(worker.targetId, {light:true,attachTimeoutMs:10000});
        const marker = await send('Runtime.evaluate', {expression:'Boolean(globalThis.__cdpAgentBrowser)',returnByValue:true}, sid,15000);
        if (!marker.result?.value) throw Error('Not the handoff extension');
        return sid;
      }));
    } catch (error) { throw Error(`The browserctrl handoff extension is not loaded or responding: ${error.errors?.map(e => e.message).join('; ') || error.message}`); }
  }

  async function resolveExtensionClaims(targetInfos) {
    const destroyed = new Set();
    for (const claim of claims.list(port)) {
      if (targetInfos.some(t => t.targetId === claim.targetId)) continue;
      try {
        const {targetInfo} = await send('Target.getTargetInfo', {targetId:claim.targetId}, undefined,5000);
        targetInfos.push(targetInfo);
      } catch (error) {
        if (!/No target with given id found/.test(error.message)) throw error;
        destroyed.add(claim.targetId);
      }
    }
    return destroyed;
  }

  // Target.targetCreated only arrives if discovery is on, and it has to be
  // re-armed after a browser restart or a mid-recording tab goes unseen again.
  async function armTargetDiscovery() {
    await send('Target.setDiscoverTargets', { discover: true }, undefined, 5000).catch(() => {});
  }

  // Instrument a just-created tab if a recording is in progress on this port.
  // addScriptToEvaluateOnNewDocument lands before the first document runs, so
  // the tab is covered from its first paint rather than from the next poll.
  async function instrumentNewTarget(targetId) {
    const active = readActive();
    if (!active || active.port !== port || !active.script) return;
    const sessionId = await sessionFor(targetId).catch(() => null);
    if (!sessionId) return;
    await send('Page.addScriptToEvaluateOnNewDocument', { source: active.script }, sessionId, 5000).catch(() => {});
    await send('Runtime.evaluate', { expression: active.script, returnByValue: true }, sessionId, 5000).catch(() => {});
  }

  // Enable the domains we buffer. Failures are non-fatal: a target that
  // refuses one domain should not make the tab undriveable.
  async function enableDomains(targetId, sessionId) {
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
    if (sessions.get(targetId) === sessionId) enabled.add(targetId);
  }

  function identity(req) {
    if (typeof req.owner !== 'string' || !req.owner.trim() || req.owner.length > 256) {
      throw new Error('This client has no agent identity. Restart its MCP server or use the updated CLI.');
    }
    return { owner: req.owner, label: typeof req.label === 'string' ? req.label : req.owner };
  }

  function assertRunningRequest(req) {
    const cleanup = req.op === 'cdp' && req.method === 'Emulation.setFocusEmulationEnabled' && req.params?.enabled === false;
    if (!cleanup) activity.assertRunning(identity(req).owner);
  }

  function authorizeTarget(req, targetId, held) {
    const who = assertGlobalAvailable(req);
    const active = activeTargets.get(targetId);
    if (active && active.owner !== who.owner) throw new Error(`Tab ${targetId.slice(0, 8)} is busy with another agent's in-flight action.`);
    if (req.light) claims.assertAccess(port, targetId, who);
    else claims.claim(port, targetId, who);
    if (active) active.count++;
    else activeTargets.set(targetId, { owner: who.owner, count: 1 });
    held.push(targetId);
  }

  function assertGlobalAvailable(req) {
    const who = identity(req);
    assertRunningRequest(req);
    if (activeGlobal && activeGlobal.owner !== who.owner) throw new Error('Browser-wide control is blocked by another agent’s in-flight action.');
    return who;
  }

  function authorizeGlobal(req) {
    const who = assertGlobalAvailable(req);
    if ([...activeTargets.values()].some(active => active.owner !== who.owner) ||
        [...activeBrowserOwners.keys()].some(owner => owner !== who.owner)) {
      throw new Error('Browser-wide control is blocked by another agent’s in-flight action.');
    }
    const other = claims.list(port).find(claim => claim.owner !== who.owner);
    if (other) throw new Error(`Browser-wide control is blocked while a tab is claimed by ${other.label} (${other.owner}). Use your own tab.`);
    if (activeGlobal) activeGlobal.count++;
    else activeGlobal = { owner: who.owner, count: 1 };
  }

  let extensionMutationActive = false;

  const transportStatus = () => ({ port, pid: process.pid, code: MY_CODE,
    ok: connected && !retiring, starting: !initialized,
    recovering: initialized && !connected, retiring,
    attached: [...sessions.keys()], since: lastActivity });

  let nextClientId = 1;
  let nextTelemetryRequestId = 1;
  const server = net.createServer(sock => {
    const clientId = nextClientId++;
    telemetry('ipc_connected', { clientId });
    sock.once('close', () => telemetry('ipc_disconnected', { clientId }));
    let buf = '';
    sock.on('data', chunk => {
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
        void (async () => {
          const startedAt = Date.now();
          const requestId = nextTelemetryRequestId++;
          telemetry('request_started', { requestId, clientId, op: req.op, method: req.method,
            owner: req.owner, pendingCount: pending.size });
          const warnings = [];
          const observe = targetId => warnings.push(...activity.observe({ ...identity(req), targetId, method: req.method || req.op }));
          const reply = obj => {
            if (req.op === 'health') telemetry('health', { clientId, reason:
              obj.result?.ok ? 'healthy' : obj.result?.starting ? 'starting' :
              obj.result?.recovering ? 'recovering' : obj.result?.busy ? 'busy' : obj.result?.retiring ? 'retiring' : 'failed' });
            telemetry(obj.error ? 'request_failed' : 'request_complete', {
              requestId, clientId, op: req.op, method: req.method, owner: req.owner,
              durationMs: Date.now() - startedAt, pendingCount: pending.size,
            });
            try {
              sock.write(JSON.stringify({ reqId: req.reqId, ...obj, ...(warnings.length ? { warnings } : {}) }) + '\n');
            } catch {}
          };
          lastActivity = Date.now();
          if (!initialized) {
            reply(['health', 'status'].includes(req.op)
              ? { result: { ok: false, starting: true, code: MY_CODE, pid: process.pid } }
              : { error: 'Browser connection is starting. No request was sent; retry after approval.' });
            return;
          }
          const held = [];
          let globalHeld = false;
          let browserHeld = false;
          let extensionMutationHeld = false;
          try {
            if (!['ping', 'health', 'status', 'activity'].includes(req.op)) assertRunningRequest(req);
            if (['browser', 'cdp', 'detach'].includes(req.op)) assertGlobalAvailable(req);
            if (req.op === 'ping') reply({ result: 'pong' });
            else if (req.op === 'health') {
              reply({ result: Number.isFinite(req.timeoutMs) && req.timeoutMs > 0
                ? await checkTransport() : { ...transportStatus(), unchecked: true } });
            } else if (req.op === 'activity') {
              const who = identity(req);
              if (req.action === 'describe' && req.activityOwner && req.activityOwner !== who.owner) throw new Error('Describe only your own agent activity.');
              const result = activity.control(req.action || 'list', { owner: req.activityOwner || who.owner, label: who.label, intent: req.intent, completed: req.completed, total: req.total });
              reply({ result: req.action === 'list' || !req.action ? activity.snapshot(claims.list(port)) : result });
            } else if (req.op === 'status') {
              reply({ result: transportStatus() });
            } else if (req.op === 'stop') {
              reply({ result: 'stopping' });
              setTimeout(shutdown, 50);
            } else if (req.op === 'extension') {
              const who = assertGlobalAvailable(req);
              if (!Array.isArray(req.args) || (!extensionReads.has(req.method) && !extensionScoped.has(req.method))) throw Error('Unsupported structured extension operation');
              if (extensionScoped.has(req.method)) {
                if (extensionMutationActive) throw Error('Another scoped extension mutation is in flight; inspect again before retrying');
                extensionMutationActive = extensionMutationHeld = true;
                activeBrowserOwners.set(who.owner, (activeBrowserOwners.get(who.owner) || 0) + 1);
                browserHeld = true;
              }
              const {targetInfos} = await send('Target.getTargets');
              const workerSession = await extensionSession(targetInfos);
              const evaluate = async expression => {
                assertRunningRequest(req);
                const r = await send('Runtime.evaluate', {expression,awaitPromise:true,returnByValue:true}, workerSession,15000);
                if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
                return r.result?.value;
              };
              if (extensionScoped.has(req.method)) {
                const tabs = await evaluate('chrome.tabs.query({})');
                const affected = affectedExtensionTabs(req.method, req.args, tabs);
                const destroyed = await resolveExtensionClaims(targetInfos);
                assertExtensionClaims(affected, targetInfos, claims.list(port), who.owner, destroyed);
                // Hold the matching page leases through mutation; unrelated pages remain available.
                for (const target of targetInfos.filter(t => t.type === 'page' && affected.some(tab => tab.url === t.url))) authorizeTarget(req, target.targetId, held);
                // Recheck after authorization, before sending the mutation.
                assertExtensionClaims(affected, targetInfos, claims.list(port), who.owner, destroyed);
              }
              const expression = req.method === 'outline'
                ? 'Promise.all([chrome.tabs.query({}),chrome.tabGroups.query({})]).then(([tabs,groups])=>tabs.map(t=>({...t,group:groups.find(g=>g.id===t.groupId)?.title??null,groupCollapsed:groups.find(g=>g.id===t.groupId)?.collapsed??null})))'
                : `chrome.${req.method}(...${JSON.stringify(req.args)})`;
              const result = await evaluate(expression);
              if (req.method === 'tabs.remove') {
                for (const targetId of held) claims.release(port, targetId, who);
              }
              reply({result});
            } else if (['native-group', 'dia-group'].includes(req.op)) {
              const adapter = getNativeTabAdapter(PORT_TO_KEY[port]);
              const who = assertGlobalAvailable(req);
              if (extensionMutationActive) throw Error('Another scoped extension mutation is in flight; inspect again before retrying');
              extensionMutationActive = extensionMutationHeld = true;
              activeBrowserOwners.set(who.owner, (activeBrowserOwners.get(who.owner) || 0) + 1);
              browserHeld = true;
              const {targetInfos} = await send('Target.getTargets');
              const workerSession = await extensionSession(targetInfos);
              const evaluate = async expression => {
                assertRunningRequest(req);
                const r = await send('Runtime.evaluate', {expression,awaitPromise:true,returnByValue:true}, workerSession,15000);
                if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
                return r.result?.value;
              };
              const windows = await adapter.listTabs();
              const plan = planNativeGroup(windows, req.ids, req.groupId);
              const extensionTabs = await evaluate('chrome.tabs.query({})');
              const affected = [...plan.tabs, ...extensionTabs.filter(t => t.groupId === req.groupId)];
              if (req.allowFocus === true) {
                const restoreTab = windows.flatMap(w => w.tabs).find(t => t.id === plan.restoreId);
                if (restoreTab) affected.push(restoreTab);
              }
              const destroyed = await resolveExtensionClaims(targetInfos);
              assertExtensionClaims(affected, targetInfos, claims.list(port), who.owner, destroyed);
              for (const target of targetInfos.filter(t => t.type === 'page' && affected.some(tab => tab.url === t.url))) authorizeTarget(req, target.targetId, held);
              assertExtensionClaims(affected, targetInfos, claims.list(port), who.owner, destroyed);
              const authorize = async () => {
                const {targetInfos:currentTargets} = await send('Target.getTargets');
                const currentTabs = await evaluate('chrome.tabs.query({})');
                const currentAffected = [...affected, ...currentTabs.filter(t => t.groupId === req.groupId)];
                const gone = await resolveExtensionClaims(currentTargets);
                assertExtensionClaims(currentAffected, currentTargets, claims.list(port), who.owner, gone);
                for (const target of currentTargets.filter(t => t.type === 'page' && currentAffected.some(tab => tab.url === t.url))) {
                  if (!held.includes(target.targetId)) authorizeTarget(req, target.targetId, held);
                }
                assertExtensionClaims(currentAffected, currentTargets, claims.list(port), who.owner, gone);
              };
              reply({result:await groupNativeTabs(req.ids,req.groupId,{evaluate, authorize, list:adapter.listTabs, focus:adapter.focusTab, allowFocus:req.allowFocus === true})});
            } else if (['native-focus', 'dia-focus'].includes(req.op)) {
              const adapter = getNativeTabAdapter(PORT_TO_KEY[port]);
              authorizeGlobal(req);
              globalHeld = true;
              observe(req.nativeId);
              reply({result: await adapter.focusTab(req.nativeId)});
            } else if (req.op === 'browser') {
              const reads = ['Browser.getVersion', 'Target.getTargets', 'Target.getTargetInfo', 'Target.getBrowserContexts'];
              if (!reads.includes(req.method)) {
                activeBrowserOwners.set(req.owner, (activeBrowserOwners.get(req.owner) || 0) + 1);
                browserHeld = true;
              }
              if (['Target.closeTarget', 'Target.activateTarget', 'Target.attachToTarget'].includes(req.method)) {
                authorizeTarget(req, req.params?.targetId, held);
              } else if (req.method === 'Target.disposeBrowserContext') {
                const { targetInfos } = await send('Target.getTargets');
                for (const target of targetInfos.filter(t => t.browserContextId === req.params?.browserContextId)) {
                  authorizeTarget(req, target.targetId, held);
                }
              } else if (!reads.includes(req.method) && !['Target.createTarget', 'Target.createBrowserContext'].includes(req.method)) {
                authorizeGlobal(req);
                globalHeld = true;
              }
              if (req.method === 'Target.createTarget') identity(req);
              assertRunningRequest(req);
              observe(req.params?.targetId);
              const result = await send(req.method, req.params, undefined, req.timeoutMs);
              if (req.method === 'Target.createTarget') {
                claims.claim(port, result.targetId, identity(req));
                targetTypes.set(result.targetId, 'page');
              }
              if (req.method === 'Target.closeTarget' && result.success) claims.release(port, req.params.targetId, identity(req));
              reply({ result });
            } else if (req.op === 'cdp') {
              if (!req.targetId) throw new Error('Target-scoped commands require a tab id.');
              if (!targetTypes.has(req.targetId)) {
                const { targetInfo } = await send('Target.getTargetInfo', { targetId: req.targetId });
                targetTypes.set(req.targetId, targetInfo.type);
              }
              if (targetTypes.get(req.targetId) !== 'page' || /^(Browser|Target|Storage|Tracing)\./.test(req.method)) {
                authorizeGlobal(req);
                globalHeld = true;
              }
              authorizeTarget(req, req.targetId, held);
              const sessionId = req.targetId ? await sessionFor(req.targetId, { light: Boolean(req.light) }) : undefined;
              claims.assertAccess(port, req.targetId, identity(req));
              assertRunningRequest(req);
              // Dia and Chrome freeze background tabs. A frozen page still answers a
              // synchronous evaluate, but never settles a fetch, timer or awaited
              // promise, so the command hangs until it times out. Thaw it first.
              if (targetTypes.get(req.targetId) === 'page' && THAW_BEFORE.test(req.method)) {
                await send('Page.setWebLifecycleState', { state: 'active' }, sessionId, 5000).catch(() => {});
              }
              if (req.method.startsWith('Input.')) {
                const assertAllowed = () => {
                  claims.assertAccess(port, req.targetId, identity(req));
                  assertRunningRequest(req);
                };
                const result = await runQueuedInput(inputQueues, req.targetId, assertAllowed, async () => {
                  if (sessions.get(req.targetId) !== sessionId) throw new Error('Tab session changed before input. No input was sent or replayed.');
                  await send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
                  try {
                    assertRunningRequest(req);
                    observe(req.targetId);
                    return await send(req.method, req.params, sessionId, req.timeoutMs);
                  } finally {
                    await send('Emulation.setFocusEmulationEnabled', { enabled: false }, sessionId).catch(() => {});
                  }
                });
                reply({ result });
              } else {
                observe(req.targetId);
                reply({ result: await send(req.method, req.params, sessionId, req.timeoutMs) });
              }
            } else if (req.op === 'events') {
              claims.assertAccess(port, req.targetId, identity(req));
              const b = bufFor(req.targetId);
              const out = {
                console: b.console.slice(-(req.limit ?? 100)),
                errors: b.errors.slice(-(req.limit ?? 100)),
                network: b.network.slice(-(req.limit ?? 100)),
              };
              if (req.clear) buffers.set(req.targetId, { console: [], errors: [], network: [] });
              reply({ result: out });
            } else if (req.op === 'detach') {
              authorizeTarget(req, req.targetId, held);
              const sessionId = sessions.get(req.targetId);
              if (sessionId) {
                await send('Target.detachFromTarget', { sessionId }).catch(() => {});
                sessions.delete(req.targetId);
              }
              enabled.delete(req.targetId);
              reply({ result: 'detached' });
            } else reply({ error: `unknown op ${req.op}` });
          } catch (e) {
            reply({ error: e.message });
          } finally {
            if (extensionMutationHeld) extensionMutationActive = false;
            if (globalHeld && activeGlobal && --activeGlobal.count === 0) activeGlobal = null;
            if (browserHeld) {
              const count = activeBrowserOwners.get(req.owner) - 1;
              if (count) activeBrowserOwners.set(req.owner, count);
              else activeBrowserOwners.delete(req.owner);
            }
            for (const targetId of held) {
              const active = activeTargets.get(targetId);
              if (active && --active.count === 0) activeTargets.delete(targetId);
            }
          }
        })().catch(() => sock.destroy());
      }
    });
    sock.on('error', () => {});
  });
  if (!(await bindDaemonSocket(server, port))) { telemetry('lock_skipped', { reason: 'socket_owned' }); releaseFileLock(lock); return; }
  telemetry('listening');
  let processStart;
  if (process.platform === 'win32') processStart = await windowsProcessStart(process.pid);
  else {
    socketIdentity = fs.statSync(SOCK(port));
    fs.chmodSync(SOCK(port), 0o600);
    ({ stdout: processStart } = await exec('/bin/ps', ['-p', String(process.pid), '-o', 'lstart=']));
  }
  socketIdentity = { ...(socketIdentity || {}), processStart };
  fs.mkdirSync(path.dirname(ownerFile(port)), { recursive: true });
  fs.writeFileSync(ownerFile(port), JSON.stringify({ pid: process.pid, ino: socketIdentity.ino, processStart }), { mode: 0o600 });
  process.once('SIGTERM', () => shutdown('sigterm'));
  process.once('SIGINT', () => shutdown('sigint'));
  telemetry('browser_connect_attempt', { attempt: 1 });
  try {
    const url = await browserWsUrl(port);
    ws = await openBrowserSocket(url, APPROVAL_TIMEOUT_MS);
    connected = true;
    wire(ws);
    initialized = true;
    telemetry('browser_connected');
  } catch {
    telemetry('browser_connect_failed');
    shutdown('startup_failed');
  }
  // Discovery has to be on before any tab is created, not when the first
  // recording starts, because the daemon outlives individual recordings.
  armTargetDiscovery().catch(() => {});

  setInterval(() => {
    if (Date.now() - lastActivity > IDLE_EXIT_MS) shutdown('idle');
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

function readOwner(port) {
  try { return JSON.parse(fs.readFileSync(ownerFile(port), 'utf8')); } catch { return null; }
}

async function windowsProcessStart(pid) {
  const command = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}").CreationDate.ToUniversalTime().ToString('o')`;
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
  const start = stdout.trim();
  if (!start) throw new Error('Cannot verify Windows process creation time');
  return start;
}

async function terminateWindowsProcess(pid, processStart) {
  const expected = processStart.replaceAll("'", "''");
  const command = `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}"; if($p -and $p.CreationDate.ToUniversalTime().ToString('o') -ceq '${expected}') { Invoke-CimMethod -InputObject $p -MethodName Terminate | Out-Null }`;
  await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
}

async function retireUnresponsiveDaemon(port, owner) {
  if (!owner) return false;
  const stillOwned = async () => {
    try {
      if (!Number.isInteger(owner.pid) || owner.pid <= 1) return false;
      const current = JSON.parse(fs.readFileSync(ownerFile(port), 'utf8'));
      if (current.pid !== owner.pid || current.processStart !== owner.processStart) return false;
      if (process.platform === 'win32') return await windowsProcessStart(owner.pid) === owner.processStart;
      if (fs.statSync(SOCK(port)).ino !== owner.ino) return false;
      const { stdout } = await exec('/bin/ps', ['-p', String(owner.pid), '-o', 'lstart=']);
      return stdout === owner.processStart && fs.statSync(SOCK(port)).ino === owner.ino;
    } catch { return false; }
  };
  if (!(await stillOwned())) return true; // Another client may already have replaced this owner.
  if (process.platform === 'win32') {
    if (!(await stillOwned())) return true;
    await terminateWindowsProcess(owner.pid, owner.processStart).catch(() => {});
    return true;
  }
  try { process.kill(owner.pid, 'SIGTERM'); } catch { return true; }
  await new Promise(resolve => setTimeout(resolve, 500));
  if (await stillOwned()) {
    try { process.kill(owner.pid, 'SIGKILL'); } catch {}
  }
  return true;
}

async function ensureDaemon(port, { owner, label }) {
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS + 5000;
  let spawned = false;
  let stoppingPid = null;
  while (Date.now() < deadline) {
    const daemonOwner = readOwner(port);
    let existing;
    let reused = false;
    try {
      existing = await sockConnect(port);
      const health = await askOnce(existing, { op: 'status' }, IPC_LIVENESS_TIMEOUT_MS);
      if (health && !health.ok && !health.starting && !health.recovering) spawned = false;
      if (health?.ok && health.code === codeVersion()) { reused = true; return existing; }
      const legacy = health?.pid === daemonOwner?.pid && health?.pid && health.code == null && !health.starting;
      if ((health?.ok || legacy) && stoppingPid !== health.pid) {
        process.stderr.write('(restarting the daemon: it is running older code than this CLI)\n');
        existing.write(JSON.stringify({ reqId: 0, op: 'stop', owner, label }) + '\n');
        stoppingPid = health.pid;
      }
      // A starting daemon owns the approval handshake; never open a second one.
      // An unhealthy daemon retires itself after its shared transport probe.
      if (!health) spawned = false;
      if (!health && !existing.destroyed && !(await retireUnresponsiveDaemon(port, daemonOwner))) {
        throw new Error('Daemon IPC is unresponsive and its owner could not be verified; no requests were replayed.');
      }
    } catch (error) {
      if (existing) throw error;
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
      if (!spawned) {
        await browserWsUrl(port);
        const self = path.join(path.dirname(fileURLToPath(import.meta.url)), 'daemon-run.mjs');
        spawn(process.execPath, [self, String(port)], { detached: true, stdio: 'ignore' }).unref();
        spawned = true;
      }
    } finally {
      // Successful reuse returns above; keep that client's IPC stream open.
      if (existing && !reused) existing.destroy();
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Daemon failed to become ready within 5 minutes. Allow the browser debugging prompt if shown.');
}

export async function connect(port, { owner = agentId(), label = agentLabel() } = {}) {
  let sock = await ensureDaemon(port, { owner, label });
  let buf = '';
  let nextReq = 1;
  const pending = new Map();
  const warningQueue = [];
  let disconnected = false;
  let reconnecting = null;

  const rejectPending = message => {
    for (const [reqId, request] of pending) {
      pending.delete(reqId);
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
  };

  const onDisconnect = () => {
    if (disconnected) return;
    disconnected = true;
    rejectPending(
      'Daemon connection closed before the request completed. Its outcome is uncertain; it was not replayed. ' +
        'Call reconnect() before a new observation.',
    );
  };

  const onData = chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        rejectPending(
          'Daemon returned malformed IPC data. The outcome of pending requests is uncertain; none were replayed.',
        );
        continue;
      }
      if (!d || typeof d !== 'object' || Array.isArray(d)) {
        rejectPending(
          'Daemon returned malformed IPC data. The outcome of pending requests is uncertain; none were replayed.',
        );
        continue;
      }
      if (Array.isArray(d.warnings)) {
        warningQueue.push(...d.warnings.filter(w => typeof w === 'string'));
        if (warningQueue.length > 32) warningQueue.splice(0, warningQueue.length - 32);
      }
      const p = pending.get(d.reqId);
      if (p) {
        pending.delete(d.reqId);
        clearTimeout(p.timer);
        d.error ? p.reject(new Error(d.error)) : p.resolve(d.result);
      }
    }
  };

  const wireClient = next => {
    buf = '';
    disconnected = false;
    next.on('data', chunk => {
      if (next === sock) onData(chunk);
    });
    const disconnect = () => {
      if (next === sock) onDisconnect();
    };
    next.once('end', disconnect);
    next.once('close', disconnect);
    next.once('error', disconnect);
  };
  wireClient(sock);

  const request = obj =>
    new Promise((resolve, reject) => {
      if (disconnected || sock.destroyed) {
        reject(
          new Error(
            'Daemon connection is closed. No request was sent or replayed; call reconnect() before a new observation.',
          ),
        );
        return;
      }
      const reqId = nextReq++;
      const timeoutMs = (Number.isFinite(obj.timeoutMs) && obj.timeoutMs > 0 ? obj.timeoutMs : DEFAULT_TIMEOUT_MS) +
        IPC_TIMEOUT_GRACE_MS + (obj.op === 'cdp' ? TAB_INITIALIZATION_ALLOWANCE_MS : 0);
      const timer = setTimeout(() => {
        if (!pending.delete(reqId)) return;
        reject(
          new Error(
            `Daemon IPC request timed out after ${timeoutMs}ms. Its outcome is uncertain; it was not replayed.`,
          ),
        );
        onDisconnect();
        sock.destroy();
      }, timeoutMs);
      pending.set(reqId, { resolve, reject, timer });
      sock.write(JSON.stringify({ reqId, ...obj, timeoutMs: Number.isFinite(obj.timeoutMs) && obj.timeoutMs > 0 ? obj.timeoutMs : DEFAULT_TIMEOUT_MS, owner, label }) + '\n', error => {
        if (!error || !pending.delete(reqId)) return;
        clearTimeout(timer);
        reject(
          new Error(
            'Daemon IPC write failed before completion. Its outcome is uncertain; the request was not replayed.',
          ),
        );
      });
    });

  const reconnect = async () => {
    if (reconnecting) return reconnecting;
    reconnecting = (async () => {
      rejectPending(
        'Daemon connection was explicitly replaced before the request completed. Its outcome is uncertain; it was not replayed.',
      );
      disconnected = true;
      sock.destroy();
      const next = await ensureDaemon(port, { owner, label });
      sock = next;
      wireClient(next);
    })();
    try {
      await reconnecting;
    } finally {
      reconnecting = null;
    }
  };

  return {
    port,
    activity: (action = 'list', {owner: activityOwner, ...details} = {}) => request({op: 'activity', action, activityOwner, ...details}),
    takeWarnings: () => warningQueue.splice(0),
    browser: (method, params = {}, timeoutMs) => request({ op: 'browser', method, params, timeoutMs }),
    send: (targetId, method, params = {}, timeoutMs, opts = {}) =>
      request({ op: 'cdp', targetId, method, params, timeoutMs, light: opts.light }),
    events: (targetId, opts = {}) => request({ op: 'events', targetId, ...opts }),
    detach: targetId => request({ op: 'detach', targetId }),
    extension: (method, args = []) => request({op:'extension',method,args,timeoutMs:60000}),
    groupNativeTabs: (ids, groupId, {allowFocus = false} = {}) => request({op:'native-group',ids,groupId,allowFocus,timeoutMs:Math.min(600000,30000 + ids.length*20000)}),
    focusNativeTab: nativeId => request({op: 'native-focus', nativeId, timeoutMs: 12000}),
    health: () => request({ op: 'health', timeoutMs: HEALTH_TIMEOUT_MS + 1000 }),
    status: () => request({ op: 'status' }),
    stop: () => request({ op: 'stop' }),
    reconnect,
    close: () => {
      disconnected = true;
      rejectPending('Daemon client closed before the request completed. Its outcome is uncertain; it was not replayed.');
      sock.end();
    },
  };
}

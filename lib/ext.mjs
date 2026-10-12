import { fileURLToPath } from 'node:url';
// Browser-level control via the extension's service worker.
//
// CDP exposes pages, not the browser UI. Tab groups, bookmarks, history,
// downloads, sessions, the reading list, and half of chrome.tabs (pin, mute,
// duplicate, move, discard, zoom) exist only as `chrome.*` extension APIs.
//
// Rather than invent an RPC protocol between the CLI and the extension, we
// attach CDP straight to the extension's service worker and Runtime.evaluate
// there. The extension is a permission carrier: whatever its manifest grants,
// this module can call. Nothing here needs updating when a new chrome.* API
// becomes interesting.

import { connect } from './daemon.mjs';

const MARKER = '__cdpAgentBrowser';

/** All extension service workers currently alive on this port. */
async function serviceWorkers(port) {
  const client = await connect(port);
  try {
    const { targetInfos } = await client.browser('Target.getTargets');
    return targetInfos
      .filter(t => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'))
      .map(t => ({ ...t, id: t.targetId }));
  } finally {
    client.close();
  }
}

async function evaluateOn(port, targetId, expression, { timeoutMs = 15000 } = {}) {
  const client = await connect(port);
  try {
    const r = await client.send(targetId, 'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true }, timeoutMs, { light: true });
    if (r.exceptionDetails) {
      const e = r.exceptionDetails;
      throw new Error(e.exception?.description || e.text || 'evaluation threw');
    }
    return r.result?.value;
  } finally {
    client.close();
  }
}

/**
 * Find the browserctrl handoff extension's service worker.
 *
 * MV3 workers are terminated when idle and then vanish from target discovery. The
 * extension keeps a 30s alarm heartbeat for exactly this reason, but there is
 * still a window where it is asleep — so this retries briefly rather than
 * reporting "not installed" for something that is merely dozing.
 */
export async function findWorker(port, { retries = 3, delayMs = 1200 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const workers = await serviceWorkers(port);
    for (const w of workers) {
      try {
        const marker = await evaluateOn(port, w.id, `globalThis.${MARKER} ? JSON.stringify(globalThis.${MARKER}) : null`, { timeoutMs: 4000 });
        if (marker) return { ...w, marker: JSON.parse(marker) };
      } catch (error) {
        // Ownership refusals must remain visible; they do not mean the extension
        // is missing. IPC currently carries error messages rather than codes.
        if (error.code === 'CLAIMED' || /claimed by|Browser-wide control is blocked|busy with another agent/i.test(error.message)) throw error;
        // A worker we cannot attach to may not be ours; keep looking.
      }
    }
    if (attempt < retries) await new Promise(r => setTimeout(r, delayMs));
  }

  const seen = (await serviceWorkers(port)).length;
  throw new Error(
    `The browserctrl handoff extension is not loaded (checked ${seen} extension service worker${seen === 1 ? '' : 's'}).\n` +
    `Load it once: open chrome://extensions, enable Developer mode, "Load unpacked",\n` +
    `and pick ${fileURLToPath(new URL('../extension', import.meta.url))}`
  );
}

/** Evaluate an arbitrary chrome.* expression inside the extension. */
export async function evaluate(port, expression, opts = {}) {
  const worker = await findWorker(port);
  const wrapped = `(async () => { const __r = await (${expression}); return typeof __r === 'string' ? __r : JSON.stringify(__r ?? null); })()`;
  const value = await evaluateOn(port, worker.id, wrapped, opts);
  try { return JSON.parse(value); } catch { return value; }
}

/** Is the extension present, and what does it grant? */
export async function info(port) {
  const worker = await findWorker(port);
  const raw = await evaluateOn(
    port, worker.id,
    `JSON.stringify({ id: chrome.runtime.id, name: chrome.runtime.getManifest().name, version: chrome.runtime.getManifest().version, permissions: chrome.runtime.getManifest().permissions })`,
  );
  return JSON.parse(raw);
}

/** Structured inspection and exact tab/group mutations preserve other page owners. */
export async function operation(port, method, args = []) {
  const client = await connect(port);
  try { return await client.extension(method, args); }
  finally { client.close(); }
}

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

const MARKER = '__cdpAgentBrowser';

/** All extension service workers currently alive on this port. */
async function serviceWorkers(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await res.json();
  return targets.filter(t => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
}

function evaluateOn(wsUrl, expression, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`timed out after ${timeoutMs}ms evaluating in the service worker`));
    }, timeoutMs);
    const done = (fn, arg) => { clearTimeout(timer); try { ws.close(); } catch {} fn(arg); };

    ws.onopen = () => ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
    ws.onerror = () => done(reject, new Error('could not attach to the service worker'));
    ws.onmessage = m => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.id !== 1) return;
      if (msg.error) return done(reject, new Error(msg.error.message));
      const r = msg.result || {};
      if (r.exceptionDetails) {
        const e = r.exceptionDetails;
        return done(reject, new Error(e.exception?.description || e.text || 'evaluation threw'));
      }
      done(resolve, r.result?.value);
    };
  });
}

/**
 * Find the cdp handoff extension's service worker.
 *
 * MV3 workers are terminated when idle and then vanish from /json/list. The
 * extension keeps a 30s alarm heartbeat for exactly this reason, but there is
 * still a window where it is asleep — so this retries briefly rather than
 * reporting "not installed" for something that is merely dozing.
 */
export async function findWorker(port, { retries = 3, delayMs = 1200 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const workers = await serviceWorkers(port);
    for (const w of workers) {
      try {
        const marker = await evaluateOn(w.webSocketDebuggerUrl, `globalThis.${MARKER} ? JSON.stringify(globalThis.${MARKER}) : null`, { timeoutMs: 4000 });
        if (marker) return { ...w, marker: JSON.parse(marker) };
      } catch {
        // A worker we cannot attach to is not ours; keep looking.
      }
    }
    if (attempt < retries) await new Promise(r => setTimeout(r, delayMs));
  }

  const seen = (await serviceWorkers(port)).length;
  throw new Error(
    `The cdp handoff extension is not loaded (checked ${seen} extension service worker${seen === 1 ? '' : 's'}).\n` +
    `Load it once: open chrome://extensions, enable Developer mode, "Load unpacked",\n` +
    `and pick ${new URL('../extension', import.meta.url).pathname}`
  );
}

/** Evaluate an arbitrary chrome.* expression inside the extension. */
export async function evaluate(port, expression, opts = {}) {
  const worker = await findWorker(port);
  const wrapped = `(async () => { const __r = await (${expression}); return typeof __r === 'string' ? __r : JSON.stringify(__r ?? null); })()`;
  const value = await evaluateOn(worker.webSocketDebuggerUrl, wrapped, opts);
  try { return JSON.parse(value); } catch { return value; }
}

/** Is the extension present, and what does it grant? */
export async function info(port) {
  const worker = await findWorker(port);
  const raw = await evaluateOn(
    worker.webSocketDebuggerUrl,
    `JSON.stringify({ id: chrome.runtime.id, name: chrome.runtime.getManifest().name, version: chrome.runtime.getManifest().version, permissions: chrome.runtime.getManifest().permissions })`,
  );
  return JSON.parse(raw);
}

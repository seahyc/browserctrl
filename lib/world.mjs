// The isolated world browserctrl's page scripts (overlay, recorders) live in.
//
// A page's own scripts share the DOM with these scripts but not their globals, and
// the __cdpSend binding is exposed to this world only. So a web page cannot call
// __cdpSend, cannot see window.__cdpOverlay, and cannot forge what they report.
// Everything that reads or drives those scripts has to evaluate here, not in the
// page's world; this is the one place that knows how.
export const WORLD = 'browserctrl';

// Execution context ids per target. A navigation gives the world a new context,
// so a stale id is not tracked: a failed evaluate drops it and asks again.
const contexts = new Map();
const STALE = /context|Cannot find|destroyed/i;

// `send(method, params, timeoutMs)` talks to one target (a daemon session or a conn bound to a tab).
export async function evaluateInWorld(send, key, expression, { awaitPromise = false, timeoutMs = 5000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let contextId = attempt === 0 ? contexts.get(key) : undefined;
    if (!contextId) {
      const tree = await send('Page.getFrameTree', {}, timeoutMs);
      ({ executionContextId: contextId } = await send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: WORLD }, timeoutMs));
      contexts.set(key, contextId);
    }
    let r;
    try {
      r = await send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise }, timeoutMs);
    } catch (e) {
      if (attempt === 0 && STALE.test(e.message)) { contexts.delete(key); continue; }
      throw e;
    }
    const ex = r?.exceptionDetails;
    if (ex) {
      const msg = ex.exception?.description || ex.text || 'JS exception';
      if (attempt === 0 && STALE.test(msg)) { contexts.delete(key); continue; }
      throw new Error(msg);
    }
    return r?.result?.value;
  }
}

// Registered for every future document of the target, in the named world.
export const addScript = (send, source, timeoutMs) => send('Page.addScriptToEvaluateOnNewDocument', { source, worldName: WORLD }, timeoutMs);

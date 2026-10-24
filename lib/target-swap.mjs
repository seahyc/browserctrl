// A tab whose page target is replaced under the same tab: Chrome activating a prerendered
// page (Speculation Rules) while any DevTools client watches tabs through tab targets. The
// prerender has its own page target; on activation it becomes the tab's page and the old
// target turns into a "disconnected" husk that Target.getTargets no longer lists and that
// never sends targetDestroyed. A session on the old target stops answering without being
// detached, so every later call on it times out.
//
// Discovery shows the prerender as a page target with subtype "prerender", and its
// activation as a targetInfoChanged without the subtype. The tab it replaced is the one
// known page in the same browser context that has just dropped out of Target.getTargets
// and reports subtype "disconnected". Exactly one such page is a
// swap; none is a plain prerender; more than one is ambiguous and is not followed.
export const SWAP_NOTE = to => `the tab's target changed (prerendered page activated); continuing on ${to.slice(0, 8)}`;

export function createSwapTracker({ getTargets, getTargetInfo, onSwap, onAmbiguous = () => {} }) {
  const pages = new Map(); // targetId -> {browserContextId, subtype}
  const replacedBy = new Map(); // old targetId -> {targetId, at, reason}
  let settling = Promise.resolve();

  const resolve = targetId => {
    let id = targetId;
    for (let hops = 0; id && replacedBy.has(id) && hops < 32; hops++) id = replacedBy.get(id).targetId;
    return id;
  };

  async function pair(next, info) {
    const { targetInfos } = await getTargets();
    const live = new Set(targetInfos.map(t => t.targetId));
    const candidates = [...pages].filter(([id, p]) => id !== next && !p.subtype && !live.has(id) &&
      (!p.browserContextId || !info.browserContextId || p.browserContextId === info.browserContextId)).map(([id]) => id);
    const gone = [];
    for (const id of candidates) {
      // A closed tab is gone altogether; only a replaced one lingers as a husk.
      const husk = await getTargetInfo(id).then(r => r?.targetInfo, () => null);
      if (husk?.subtype === 'disconnected') gone.push(id);
    }
    if (gone.length === 1) {
      const [previous] = gone;
      pages.delete(previous);
      replacedBy.set(previous, { targetId: next, at: Date.now(), reason: 'prerender' });
      await onSwap(previous, next, info);
    } else if (gone.length > 1) await onAmbiguous(gone, next, info);
  }

  return {
    resolve,
    replaced: targetId => replacedBy.get(targetId) ?? null,
    list: () => [...replacedBy].map(([from, r]) => ({ from, to: resolve(from), at: r.at, reason: r.reason })),
    // Resolves once any activation seen so far has been paired.
    settled: () => settling,
    // Every Target.* event from the browser connection.
    onEvent(d) {
      const info = d.params?.targetInfo;
      if (d.method === 'Target.targetDestroyed') { pages.delete(d.params.targetId); return; }
      if (!info || info.type !== 'page' || (d.method !== 'Target.targetCreated' && d.method !== 'Target.targetInfoChanged' && d.method !== 'Target.attachedToTarget')) return;
      const before = pages.get(info.targetId);
      if (info.subtype === 'disconnected') return; // a husk: keep what it was
      pages.set(info.targetId, { browserContextId: info.browserContextId ?? before?.browserContextId, subtype: info.subtype || null });
      if (before?.subtype === 'prerender' && !info.subtype) {
        const run = settling.then(() => pair(info.targetId, info)).catch(() => {});
        settling = run;
      }
    },
  };
}

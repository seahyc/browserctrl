import * as ops from '../ops.mjs';

// Ignore our annotations and pins when deciding whether a click changed the page.
export async function watchClick(ctx) {
  const key = `click-${Date.now()}-${Math.random()}`;
  await ops.evaluate(ctx.conn, ctx.tab, `(() => {
    window.__bcPlanClick?.observer.disconnect();
    const state = { key: ${JSON.stringify(key)}, changed: false };
    const internal = node => (node.nodeType === 1 ? node : node.parentElement)?.closest('[data-cdp],[data-cdp-internal="true"]');
    state.collect = records => {
      if (records.some(r => !internal(r.target) &&
        !(r.type === 'attributes' && /^(data-bc-|data-cdp)/.test(r.attributeName)) &&
        !(r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].every(internal)))) state.changed = true;
    };
    state.observer = new MutationObserver(state.collect);
    const observe = root => {
      state.observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) observe(el.shadowRoot);
        if (el.tagName === 'IFRAME' && el.contentDocument) observe(el.contentDocument);
      }
    };
    observe(document);
    window.__bcPlanClick = state;
  })()`);
  return key;
}

export async function clickChanged(ctx, key) {
  return ops.evaluate(ctx.conn, ctx.tab, `(() => {
    const state = window.__bcPlanClick;
    if (!state || state.key !== ${JSON.stringify(key)}) return true;
    state.collect(state.observer.takeRecords());
    state.observer.disconnect();
    delete window.__bcPlanClick;
    return state.changed;
  })()`);
}

export async function childTabs(ctx, before) {
  const { targetInfos } = await ctx.conn.browser('Target.getTargets');
  return targetInfos.filter(t => t.type === 'page' && t.openerId === ctx.tab && !before.has(t.targetId)).map(t => t.targetId);
}

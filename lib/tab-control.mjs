// Browser-independent tab planning and extension grouping. Platform adapters
// provide native inventory and optional focus; foreground fallback is opt-in.
export function planNativeGroup(windows, ids, groupId) {
  if (!Number.isSafeInteger(groupId) || groupId < 0) throw Error('An existing integer group ID is required');
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw Error('Provide distinct native tab UUIDs');
  const tabs = ids.map(id => {
    const matches = windows.flatMap(w => w.tabs.filter(t => t.id === id).map(t => ({...t, windowId:w.id})));
    if (matches.length !== 1) throw Error(`Native tab ${id} is missing or ambiguous`);
    return matches[0];
  });
  if (new Set(tabs.map(t => t.windowId)).size !== 1) throw Error('Native grouping requires tabs from one window');
  for (const tab of tabs) {
    if (windows.flatMap(w => w.tabs).filter(t => t.url === tab.url).length !== 1) throw Error(`URL is ambiguous for native tab ${tab.id}`);
  }
  return {groupId,tabs,restoreId:windows.find(w => w.id === tabs[0].windowId).activeTabId};
}

export async function groupNativeTabs(ids, groupId, {
  list, focus, evaluate, allowFocus = false, authorize = async () => {},
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now,
} = {}) {
  const plan = planNativeGroup(await list(), ids, groupId);
  await evaluate(`chrome.tabGroups.get(${groupId})`);
  const lookup = tab => evaluate(`chrome.tabs.query({}).then(ts=>ts.filter(t=>t.url===${JSON.stringify(tab.url)}).map(t=>({id:t.id,groupId:t.groupId})))`);
  // Preflight the whole batch before a missing tab can interrupt partial work.
  for (const tab of plan.tabs) {
    const candidates = await lookup(tab);
    if (candidates.length > 1) throw Error(`Extension tab match is ambiguous for ${tab.id}`);
    if (!candidates.length && !allowFocus) throw Error(`Native tab ${tab.id} needs foreground materialization. Re-run with --allow-focus to permit the adapter fallback.`);
    if (!candidates.length && typeof focus !== 'function') throw Error('The native adapter cannot materialize this tab');
  }
  const moved = [];
  let usedFocus = false;
  try {
    for (const tab of plan.tabs) {
      await authorize();
      let focused = false;
      let candidates = await lookup(tab);
      if (!candidates.length) {
        if (!allowFocus || typeof focus !== 'function') throw Error(`Native tab ${tab.id} needs foreground materialization`);
        usedFocus = focused = true;
        await focus(tab.id);
        const deadline = now() + 10000;
        do {
          candidates = await lookup(tab);
          if (candidates.length) break;
          if (now() >= deadline) throw Error(`Native tab ${tab.id} did not become available to the extension`);
          await sleep(100);
        } while (true);
      }
      if (candidates.length !== 1) throw Error(`Extension tab match is ambiguous for ${tab.id}`);
      let mutationError;
      if (candidates[0].groupId !== groupId) {
        try { await evaluate(`chrome.tabs.group({groupId:${groupId},tabIds:[${candidates[0].id}]})`); }
        catch (error) { mutationError = error; }
      }
      let observed = await lookup(tab);
      // Dia can retain an extension ID for a dormant native tab. This specific
      // refusal means no move occurred; materialize before using a new ID.
      if (mutationError && /Tab not found for session ID/.test(mutationError.message) && allowFocus && !focused && !observed.some(t => t.groupId === groupId)) {
        await authorize();
        usedFocus = true;
        await focus(tab.id);
        const refreshed = await lookup(tab);
        if (refreshed.length !== 1 || refreshed[0].id === candidates[0].id) throw mutationError;
        await authorize();
        await evaluate(`chrome.tabs.group({groupId:${groupId},tabIds:[${refreshed[0].id}]})`);
        observed = await lookup(tab);
      }
      // Re-read membership after errors; session replacement is not a retry.
      const current = observed.filter(t => t.groupId === groupId);
      if (current.length !== 1) throw mutationError || Error(`Grouping verification failed for ${tab.id}`);
      moved.push({...tab, extensionId:current[0].id});
    }
  } finally {
    try {
      if (usedFocus) await focus(plan.restoreId);
    } finally {
      await authorize();
      await evaluate(`chrome.tabGroups.update(${groupId},{collapsed:true})`);
    }
  }
  return {groupId, moved, usedFocus, restored:usedFocus ? plan.restoreId : null};
}

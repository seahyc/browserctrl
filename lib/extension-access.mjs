// Only these structured operations can run alongside page owners.
export const extensionReads = new Set(['outline', 'tabs.query', 'tabGroups.query', 'tabGroups.get']);
export const extensionScoped = new Set(['tabs.group', 'tabs.remove', 'tabGroups.update']);

export function affectedExtensionTabs(method, args, tabs) {
  const ids = value => Array.isArray(value) ? value : [value];
  let affected;
  if (method === 'tabs.group') {
    const options = args[0];
    if (!options || !Array.isArray(options.tabIds) || !options.tabIds.length) throw Error('tabs.group requires exact tabIds');
    affected = tabs.filter(t => options.tabIds.includes(t.id) || (Number.isInteger(options.groupId) && t.groupId === options.groupId));
    if (options.tabIds.some(id => !tabs.some(t => t.id === id))) throw Error('A selected extension tab is missing');
  } else if (method === 'tabs.remove') {
    const wanted = ids(args[0]);
    if (!wanted.length || wanted.some(id => !Number.isInteger(id) || !tabs.some(t => t.id === id))) throw Error('tabs.remove requires existing exact tab IDs');
    affected = tabs.filter(t => wanted.includes(t.id));
  } else if (method === 'tabGroups.update') {
    if (!Number.isInteger(args[0]) || !args[1] || Object.keys(args[1]).some(k => !['title','color','collapsed'].includes(k))) throw Error('Unsupported group update');
    affected = tabs.filter(t => t.groupId === args[0]);
    if (!affected.length) throw Error('The selected group is empty or missing');
  } else throw Error('Unsupported scoped extension operation');
  return affected;
}

export function assertExtensionClaims(tabs, targets, claims, owner, destroyed = new Set()) {
  for (const claim of claims.filter(c => c.owner !== owner)) {
    const target = targets.find(t => t.targetId === claim.targetId);
    if (!target && destroyed.has(claim.targetId)) continue;
    if (!target) throw Error(`Cannot resolve claimed tab ${claim.targetId.slice(0,8)}; no mutation was sent`);
    if (tabs.some(t => t.url === target.url)) throw Error(`Selected tab or group includes a tab claimed by ${claim.owner}; no mutation was sent`);
  }
}

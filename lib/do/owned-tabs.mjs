import * as ops from '../ops.mjs';
import * as rec from '../rec.mjs';

export async function openOwnedTab(ctx, url, { path, label, title, recordingUrl = url }) {
  const sourceTab = ctx.tab;
  const tab = (await ops.newTab(ctx.conn, url)).targetId;
  (ctx.report.owned_tabs ||= []).push(tab);
  (ctx.ownedRecordings ||= new Map()).set(tab, sourceTab);
  try {
    await rec.startChild(ctx.conn, sourceTab, tab, { path, label, title, url: recordingUrl });
  } catch (error) {
    await closeOwnedTab(ctx, tab);
    throw error;
  }
  return tab;
}

export async function closeOwnedTab(ctx, tab) {
  try {
    await rec.stopChild(ctx.conn, tab, ctx.ownedRecordings?.get(tab));
  } finally {
    await ops.closeTab(ctx.conn, tab);
    ctx.ownedRecordings?.delete(tab);
    ctx.report.owned_tabs = ctx.report.owned_tabs.filter(id => id !== tab);
  }
}

export async function stopOwnedRecordings(ctx) {
  const errors = [];
  for (const [tab, source] of ctx.ownedRecordings || []) {
    try { await rec.stopChild(ctx.conn, tab, source, { closed: false }); }
    catch (error) { errors.push(error); }
  }
  ctx.ownedRecordings?.clear();
  if (errors.length) throw new AggregateError(errors, 'Could not stop owned tab recordings');
}

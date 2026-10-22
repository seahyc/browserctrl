import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { itemsExpression, mainGroup, formatItems } from '../lib/items.mjs';
import { runSteps } from '../lib/steps.mjs';
import { fakeJev } from './fake-jev.mjs';

let fixture, browser, conn;
const haveBrowser = Boolean(chromeBinary());
before(async () => {
  if (!haveBrowser) return;
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => {
  conn?.close();
  await browser?.close();
  await fixture?.close();
});

const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
async function open() {
  const id = (await ops.newTab(conn, fixture.url + 'fixtures/plan-use2-items-dialog.html')).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  return id;
}

t('results survive the group cap with expanded filters and a nonmodal month grid', async () => {
  const id = await open();
  try {
    const capped = await ops.evaluate(conn, id, itemsExpression({ maxGroups: 1 }));
    console.log(`capped main list: ${mainGroup(capped)?.items[0]?.text}`);
    assert.match(mainGroup(capped)?.items[0]?.text || '', /Mountain and coast journey/, formatItems(capped));
    const read = await ops.evaluate(conn, id, itemsExpression());
    const main = mainGroup(read);
    console.log(`main list: ${main?.items[0]?.text}`);
    assert.match(main?.items[0]?.text || '', /Mountain and coast journey/, formatItems(read));
    assert.ok(read.groups.some(g => g.dialog && !g.dialog.modal), 'retain the nonmodal picker as a secondary group');
  } finally { await ops.closeTab(conn, id); }
});

t('a modal picker becomes the main list only when the last step opened it', async () => {
  const id = await open();
  try {
    await ops.evaluate(conn, id, 'picker.close(); picker.showModal()');
    const unchanged = await ops.evaluate(conn, id, itemsExpression());
    assert.match(mainGroup(unchanged)?.items[0]?.text || '', /Mountain and coast journey/);
    const opened = await ops.evaluate(conn, id, itemsExpression({ openedDialog: true }));
    const main = mainGroup(opened);
    console.log(`last step opened modal: ${main?.items[0]?.text}`);
    assert.match(main?.items[0]?.text || '', /Jan.*Unavailable/);
    assert.equal(main.dialog.modal, true);
    assert.equal(main.dialog.openedByLastStep, true);
  } finally { await ops.closeTab(conn, id); }
});

t('then items follows the newly opened modal and forgets it after a skipped step', async () => {
  const id = await open();
  try {
    await ops.evaluate(conn, id, 'picker.close()');
    const opened = await runSteps(conn, id, ['click "Choose departure"'], { jev: fakeJev(), noNotes: true, then: 'items' });
    assert.match(mainGroup(opened.items)?.items[0]?.text || '', /Jan.*Unavailable/);
    console.log(`plan opened modal: ${mainGroup(opened.items)?.items[0]?.text}`);
    await ops.evaluate(conn, id, 'picker.close()');
    const skipped = await runSteps(conn, id, ['click "Choose departure"', 'optional click "Missing preference"'], { jev: fakeJev(), noNotes: true, then: 'items' });
    assert.ok(skipped.steps[1].skipped);
    assert.match(mainGroup(skipped.items)?.items[0]?.text || '', /Mountain and coast journey/);
    console.log(`plan skipped last step: ${mainGroup(skipped.items)?.items[0]?.text}`);
  } finally { await ops.closeTab(conn, id); }
});

t('only the newly opened modal key can override results', async () => {
  const id = await open();
  try {
    await ops.evaluate(conn, id, `picker.close(); picker.showModal(); picker.dataset.browserctrlDialogKey='older';
      const d=document.createElement('dialog'); d.dataset.browserctrlDialogKey='newer';
      d.innerHTML='<div style="width:200px">'+[1,2,3].map(n=>'<button style="display:block;height:30px">New choice '+n+'</button>').join('')+'</div>';
      document.body.append(d); d.showModal();`);
    const read = await ops.evaluate(conn, id, itemsExpression({ openedDialog: ['newer'] }));
    assert.match(mainGroup(read)?.items[0]?.text || '', /New choice 1/);
    assert.equal(read.groups.find(g => g.items[0]?.text.includes('Jan'))?.dialog.openedByLastStep, false);
  } finally { await ops.closeTab(conn, id); }
});

t('transient result-list reads preserve user item history', async () => {
 const id=await open();
 try {
 const first=await ops.evaluate(conn,id,itemsExpression());
 const calls=await ops.evaluate(conn,id,'window.__bcItems.calls');
 await ops.evaluate(conn,id,itemsExpression({transient:true}));
 assert.equal(await ops.evaluate(conn,id,'window.__bcItems.calls'),calls);
 const second=await ops.evaluate(conn,id,itemsExpression());
 assert.deepEqual(second.groups.map(g=>g.items.map(i=>i.id)),first.groups.map(g=>g.items.map(i=>i.id)));
 } finally { await ops.closeTab(conn,id); }
});

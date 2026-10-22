import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { fakeJev } from './fake-jev.mjs';
process.env.BROWSERCTRL_CAPTURE = '0';
process.env.BROWSERCTRL_TRACE = '0';
let fixture, browser, conn;
before(async () => {
  if (!chromeBinary()) return;
  fixture = await startFixtureServer(); browser = await startHeadlessBrowser(TEST_PORT); conn = await connect(TEST_PORT);
});
after(async () => { try { conn?.close(); } finally { await browser?.close(); await fixture?.close(); } });
const model = () => fakeJev({ noul: (q, id) => /expect/.test(id) ? 0.98 : 0.04 });
async function run(lines) {
  const tab = (await ops.newTab(conn, fixture.url + 'fixtures/plan-use5-clicks.html')).targetId;
  await ops.waitForReady(conn, tab);
  try { const r = await runSteps(conn, tab, lines, { jev: model(), noNotes: true }); console.log(formatSteps(r)); return r; }
  finally { await ops.closeTab(conn, tab); }
}
const t = (name, fn) => test(name, { skip: !chromeBinary() }, fn);
t('blank link continues in the plan tab and reports its navigation', async () => {
  const r = await run(['click "Open catalogue"', 'click "A very long visible catalogue title"']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.match(r.steps[0].how, /opened here instead of a new tab/);
  assert.match(r.steps[0].url_after, /plan-use.html/);
});
t('blank link keeps commit guard before navigation', async () => {
  const r = await run(['click "Send message"']);
  assert.equal(r.done, false); assert.match(r.page.url, /plan-use5-clicks.html/);
});
for (const label of ['Open scripted tab', 'Open isolated tab', 'Browse catalogue']) t(`${label} reports its new tab and warns when the plan continues`, async () => {
  const before = new Set((await ops.tabs(conn)).map(t => t.targetId));
  try {
    const r = await run([`click "${label}"`, 'wait 1']);
    assert.equal(r.done, true, JSON.stringify(r.stopped));
    assert.equal(r.steps[0].unsure, true); assert.match(r.steps[0].unchecked, /the click opened a new tab .*; the rest of the plan ran here/);
    assert.equal(r.steps[0].opened_tabs.length, 1);
    assert.ok((await ops.tabs(conn)).some(t => t.targetId === r.steps[0].opened_tabs[0]));
  } finally { for (const tab of await ops.tabs(conn)) if (!before.has(tab.targetId)) await ops.closeTab(conn, tab.targetId); }
});
t('unchanged click cannot pass an expectation on existing text', async () => {
  const r = await run(['click "Unchanged click" => "Existing result"', 'wait 1']);
  assert.equal(r.done, true); assert.equal(r.steps[0].unsure, true);
  assert.equal(r.steps[0].unchecked, 'nothing changed after the click'); assert.equal(r.steps[0].expect_p, undefined);
});
t('unchanged final click cannot pass its expectation', async () => {
  const r = await run(['click "Unchanged click" => "Existing result"']);
  assert.equal(r.steps[0].unchecked, 'nothing changed after the click'); assert.equal(r.steps[0].expect_p, undefined);
});
t('changed page keeps passing its expectation', async () => {
  const r = await run(['click "Change result" => "Updated result"']);
  assert.equal(r.done, true); assert.equal(r.steps[0].expect_p, 0.98); assert.ok(!r.steps[0].unsure);
});
t('a click reserves its newly appeared control names for the next extraction', async () => {
  const tab = (await ops.newTab(conn, fixture.url + 'fixtures/plan-use5-clicks.html')).targetId;
  await ops.waitForReady(conn, tab);
  try {
    await ops.evaluate(conn, tab, `document.body.innerHTML = '<button id="next">Next Available</button>' + Array.from({length: 1480}, (_, i) => '<p>Tour number ' + i + ' has a price of ' + (i + 100) + ' dollars</p>').join(''); document.querySelector('#next').onclick = () => { const b = document.createElement('button'); b.setAttribute('aria-label', '11 Mar 2027 - Site E101 is available'); b.textContent = '11'; document.body.append(b); };`);
    const jev = fakeJev({ choice: (q, id) => {
      if (id !== 'extract') return 'none';
      const choice = Object.keys(q.criteria).find(key => String(q.criteria[key]).includes('11 Mar 2027 - Site E101 is available'));
      assert.ok(choice, 'new control name must be offered in the first extraction request');
      return choice;
    }, noul: (q, id) => id === 'extract_verify' ? .98 : .04 });
    const r = await runSteps(conn, tab, ['click "Next Available"', 'extract "the first available date"'], { jev, noNotes: true });
    assert.equal(r.done, true, JSON.stringify(r.stopped));
    assert.equal(r.extracted[0].value, '11 Mar 2027 - Site E101 is available');
    assert.ok(!r.steps[1].extract_second_pass);
  } finally { await ops.closeTab(conn, tab); }
});
t('a click changing an open shadow root keeps its passing expectation', async () => {
  const tab = (await ops.newTab(conn, fixture.url + 'fixtures/plan-use5-clicks.html')).targetId;
  await ops.waitForReady(conn, tab);
  try {
    await ops.evaluate(conn, tab, `const host=document.createElement('div');document.body.append(host);const shadow=host.attachShadow({mode:'open'});shadow.innerHTML='<button>Update shadow result</button><output>Old result</output>';shadow.querySelector('button').onclick=()=>shadow.querySelector('output').textContent='New result';`);
    const r = await runSteps(conn, tab, ['click "Update shadow result" => "New result"'], { jev: model(), noNotes: true });
    assert.equal(r.done, true); assert.equal(r.steps[0].expect_p, .98); assert.ok(!r.steps[0].unsure);
  } finally { await ops.closeTab(conn, tab); }
});
for (const mode of ['hidden', 'covered']) t(`a ${mode} blank link keeps normal target validation`, async () => {
  const tab = (await ops.newTab(conn, fixture.url + 'fixtures/plan-use5-clicks.html')).targetId;
  await ops.waitForReady(conn, tab);
  try {
    await ops.evaluate(conn, tab, mode === 'hidden' ? `document.querySelector('#new-tab-link').style.display='none'` : `document.body.insertAdjacentHTML('beforeend','<div style="position:fixed;inset:0;z-index:100;background:white">Covering panel</div>')`);
    const r = await runSteps(conn, tab, ['click "#new-tab-link"'], { jev: model(), noNotes: true });
    assert.equal(r.done, false); assert.match(r.page.url, /plan-use5-clicks.html/);
  } finally { await ops.closeTab(conn, tab); }
});
t('a checkbox state change keeps its expectation even without an attribute mutation', async () => {
  const tab = (await ops.newTab(conn, fixture.url + 'fixtures/plan-use5-clicks.html')).targetId;
  await ops.waitForReady(conn, tab);
  try {
    await ops.evaluate(conn, tab, `document.body.innerHTML='<label><input type="checkbox">Include breakfast</label>'`);
    const r = await runSteps(conn, tab, ['click "Include breakfast" => "Breakfast included"'], { jev: model(), noNotes: true });
    assert.equal(r.done, true); assert.equal(r.steps[0].expect_p, .98); assert.ok(!r.steps[0].unsure);
  } finally { await ops.closeTab(conn, tab); }
});

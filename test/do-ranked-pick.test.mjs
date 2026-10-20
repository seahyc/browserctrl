import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import * as notes from '../lib/notes.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { fakeJev } from './fake-jev.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

let fixture, browser, conn;
const haveBrowser = Boolean(chromeBinary());
before(async () => {
  if (!haveBrowser) return;
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => {
  try { await conn?.stop(); } catch {}
  conn?.close();
  await browser?.close();
  await fixture?.close();
});
const t = (name, fn) => test(name, { skip: !haveBrowser }, async () => {
  const tab = (await ops.newTab(conn, fixture.url + 'fixtures/page.html')).targetId;
  await ops.waitForReady(conn, tab);
  try { await fn(tab); } finally { await ops.closeTab(conn, tab); }
});
async function listing(tab, rows) {
  const cards = rows.map((row, i) => `<li style="width:600px;height:90px"${row.hint ? ` data-testid="${row.hint}"` : ''}><a href="/detail/${row.link || i + 1}">${row.name}</a><p>${row.price ?? ''}</p><span>${row.policy || 'free cancellation'}</span></li>`).join('');
  await ops.evaluate(conn, tab, `document.body.innerHTML=${JSON.stringify(`<button id="ready">Ready</button><main><h1>Hotels</h1><ul>${cards}</ul></main>`)}; window.sourceMarker=42`);
}
const rankedJev = (rules = {}) => fakeJev({
  noul: (q, id) => id.endsWith('.eligible') || id === 'prev_expect' ? .95 : .04,
  choice: (q, id) => id.endsWith('.key') ? Object.keys(q.criteria).find(k => k !== 'none') || 'none' : 'none',
  ...rules,
});
const run = (tab, plan, jev) => runSteps(conn, tab, plan, { jev, noNotes: true, traceRun: false, prefetch: false });
const choices = report => report.bindings.find(b => b.name === 'choices').value;
const selectionCall = jev => jev.calls.filter(call => Object.keys(call.questions).some(key => key.endsWith('.eligible')));

t('ranked top-k sorts numeric keys locally, preserves ties, and never opens details', async tab => {
  await listing(tab, [
    { name: 'First', price: 'SGD 200' },
    { name: 'Second', price: 'SGD 100' },
    { name: 'Third', price: 'SGD 100' },
  ]);
  const before = (await ops.tabs(conn)).map(t => t.id).sort();
  const source = await ops.evaluate(conn, tab, '({url:location.href,html:document.body.innerHTML})');
  const j = rankedJev();
  const r = await run(tab, ['pick "lowest listed price with free cancellation" top 3 as $choices'], j);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(choices(r).map(item => item.key), [100, 100, 200]);
  assert.match(choices(r)[0].text, /Second/);
  assert.match(choices(r)[1].text, /Third/);
  assert.equal(r.steps[0].tie_order, 'page order');
  assert.equal(selectionCall(j).length, 1);
  assert.equal(Object.keys(selectionCall(j)[0].questions).filter(k => k.endsWith('.eligible')).length, 3);
  assert.equal(Object.keys(selectionCall(j)[0].questions).filter(k => k.endsWith('.key')).length, 3);
  assert.equal(choices(r)[0].evidence.raw, 'SGD 100');
  assert.equal(choices(r)[0].eligibility_p, .95);
  assert.equal(r.steps[0].coverage.offered, 3);
  assert.deepEqual((await ops.tabs(conn)).map(t => t.id).sort(), before);
  assert.deepEqual(await ops.evaluate(conn, tab, '({url:location.href,html:document.body.innerHTML})'), source);
  assert.equal(await ops.evaluate(conn, tab, 'sourceMarker'), 42);
  assert.match(formatSteps(r), /✓ done:/);
});

t('ranked picks report fewer than k eligible matches and source exhaustion', async tab => {
  await listing(tab, [{ name: 'First', price: 'SGD 200' }, { name: 'Second', price: 'SGD 100' }, { name: 'Third', price: 'SGD 300' }]);
  const j = rankedJev({ noul: (q, id) => id.endsWith('.eligible') ? /First|Third/.test(q.instructions.split('Item ')[1]) ? .1 : .95 : .04 });
  const r = await run(tab, ['pick "lowest listed price" top 3 as $choices'], j);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(choices(r).length, 1);
  assert.equal(choices(r)[0].key, 100);
  assert.equal(r.steps[0].source_exhausted, true);
});

t('ranked shortlist excludes ad text and Spotlight hints before requesting judgments', async tab => {
  await listing(tab, [{ name: 'Organic', price: 'SGD 200' }, { name: 'Sponsored offer', price: 'SGD 1' }, { name: 'Featured offer', price: 'SGD 2', hint: 'spotlight' }, { name: 'Other organic', price: 'SGD 100' }]);
  const j = rankedJev();
  const r = await run(tab, ['pick "lowest price" top 3 as $choices'], j);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(choices(r).map(item => item.key), [100, 200]);
  const questions = selectionCall(j)[0].questions;
  assert.equal(Object.keys(questions).filter(k => k.endsWith('.eligible')).length, 2);
  assert.ok(!JSON.stringify(questions).includes('SGD 1"'));
  assert.ok(!JSON.stringify(questions).includes('Featured offer'));
});

t('ranked pick stops on an eligible item with no observable price', async tab => {
  await listing(tab, [{ name: 'First', price: 'SGD 200' }, { name: 'Second', price: 'Contact hotel' }, { name: 'Third', price: 'SGD 100' }]);
  const j = rankedJev();
  const r = await run(tab, ['pick "lowest price" top 2 as $choices'], j);
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /Missing or uncertain observable sort key/);
  assert.ok(!r.bindings?.length);
  assert.equal(selectionCall(j).length, 1);
});

t('ranked vague quality criteria stop without asking Jev', async tab => {
  await listing(tab, [{ name: 'First', price: 'SGD 200' }, { name: 'Second', price: 'SGD 100' }, { name: 'Third', price: 'SGD 300' }]);
  const j = rankedJev();
  const r = await run(tab, ['pick "best overall hotel" top 2 as $choices'], j);
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /observable numeric\/date/);
  assert.equal(selectionCall(j).length, 0);
});

t('ranked choice distributions select per-item keys, never a confidence runner-up list', async tab => {
  await listing(tab, [{ name: 'First', price: 'SGD 300', policy: 'free cancellation, rating 5' }, { name: 'Second', price: 'SGD 100', policy: 'free cancellation, rating 4' }, { name: 'Third', price: 'SGD 200', policy: 'free cancellation, rating 3' }]);
  const j = rankedJev({ choice: (q, id) => {
    if (!id.endsWith('.key')) return 'none';
    const price = Object.keys(q.criteria).find(key => q.criteria[key].startsWith('SGD '));
    const other = Object.keys(q.criteria).find(key => key !== 'none' && key !== price);
    return { choice: price, probabilities: { [price]: .8, ...(other ? { [other]: .15 } : {}), none: .05 } };
  } });
  const r = await run(tab, ['pick "lowest listed price" top 2 as $choices'], j);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(choices(r).map(item => item.key), [100, 200]);
  assert.equal(selectionCall(j).length, 1);
});

t('ranked entry bundles the pending expectation with all item questions', async tab => {
  await listing(tab, [{ name: 'First', price: 'SGD 200' }, { name: 'Second', price: 'SGD 100' }, { name: 'Third', price: 'SGD 300' }]);
  const j = rankedJev();
  const r = await run(tab, ['click "Ready" => "ready"', 'pick "lowest price" top 2 as $choices'], j);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  const request = selectionCall(j)[0];
  assert.ok(request.questions.prev_expect);
  assert.equal(Object.keys(request.questions).filter(k => k.endsWith('.key')).length, 3);
});

t('ranked date keys sort calendar dates locally', async tab => {
  await listing(tab, [{ name: 'First', price: '2026-03-04' }, { name: 'Second', price: '2026-01-02' }, { name: 'Third', price: '2026-02-03' }]);
  const r = await run(tab, ['pick "earliest listed date" top 2 as $choices'], rankedJev());
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(choices(r).map(item => item.key), ['2026-01-02', '2026-02-03']);
});

for (const p of [.749, .251]) {
  t(`ranked membership ${p} stops without rounding across confidence boundaries`, async tab => {
    await listing(tab, [{ name: 'First', price: 'SGD 200' }, { name: 'Second', price: 'SGD 100' }, { name: 'Third', price: 'SGD 300' }]);
    const j = rankedJev({ noul: (q, id) => id.endsWith('.eligible') ? p : .04 });
    const r = await run(tab, ['pick "lowest price" top 2 as $choices'], j);
    assert.equal(r.done, false);
    assert.match(r.stopped.reason, /eligibility unresolved/);
    assert.ok(!r.bindings?.length);
  });
}

t('ranked entry keeps source unchanged when a runnable on-note matches', async tab => {
  await listing(tab, [{ name: 'First', price: 'SGD 200' }, { name: 'Second', price: 'SGD 100' }, { name: 'Third', price: 'SGD 300' }]);
  await ops.evaluate(conn, tab, `document.body.insertAdjacentHTML('afterbegin','<button id="changeSource">Change source</button>'); changeSource.onclick=()=>{sourceMarker++;document.querySelector('main').remove()}`);
  const source = await ops.evaluate(conn, tab, '({url:location.href,html:document.body.innerHTML,marker:sourceMarker})');
  try {
    const added = await notes.add(source.url, 'The source filter is available', { force: true, on: { situation: 'the source filter is available', steps: ['click "Change source"'] } });
    assert.equal(added.ok, true, JSON.stringify(added));
    const j = rankedJev({ noul: (q, id) => id.startsWith('on_') || id.endsWith('.eligible') ? .95 : .04 });
    const r = await runSteps(conn, tab, ['pick "lowest price" top 2 as $choices'], { jev: j, noNotes: false, traceRun: false, prefetch: false });
    assert.equal(r.done, true, JSON.stringify(r.stopped));
    assert.deepEqual(choices(r).map(item => item.key), [100, 200]);
    assert.deepEqual(await ops.evaluate(conn, tab, '({url:location.href,html:document.body.innerHTML,marker:sourceMarker})'), source);
    assert.ok(j.calls.every(call => Object.keys(call.questions).every(id => !id.startsWith('on_'))));
  } finally {
    notes.clear(source.url);
  }
});

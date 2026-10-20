import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import * as notes from '../lib/notes.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { fakeJev, optionWith } from './fake-jev.mjs';
import { startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';
let server, browser, conn, base;
const haveBrowser = Boolean(chromeBinary());
const hits = [];
before(async () => {
  if (!haveBrowser) return;
  server = http.createServer((req, res) => {
    hits.push(req.url);
    const u = new URL(req.url, 'http://local');
    const id = u.searchParams.get('id') || '1';
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><html><head><title>Detail ${id}</title></head><body><main><h1>Hotel ${id}</h1><p>${"Comfortable hotel with a quiet room and excellent transport connections. ".repeat(8)}</p><p>SGD ${Number(id) * 100}</p><p>free cancellation</p><button id="go">Room details</button><script>go.onclick=()=>{document.body.dataset.clicked='yes';fetch('/input?id=${id}',{method:'POST'})}</script></main></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => { try { await conn?.stop(); } catch {} conn?.close(); await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
const card = (id, extra = '') => `<li style="height:80px;border:1px solid gray" ${extra}><a href="${base}/detail?id=${id}">Hotel ${id}</a><p>SGD ${Number(id) * 100} free cancellation</p></li>`;
const listing = cards => `<main><h1>Hotels</h1><p>${"Browse these listed hotels and their available rooms and policies. ".repeat(5)}</p><ul>${cards}</ul></main>`;
const run = (tab, lines, jev = good(), options = {}) => runSteps(conn, tab, lines, { jev, noNotes: true, traceRun: false, prefetch: false, ...options });
const good = (extra = {}) => fakeJev({ choice: (q, id) => optionWith(q, id.includes('cancellation') ? 'free cancellation' : 'SGD'), noul: (q, id) => ['extract_verify', 'prev_expect'].includes(id) ? .95 : .04, ...extra });
const t = (name, fn) => test(name, { skip: !haveBrowser }, async () => {
  const tab = (await ops.newTab(conn, base + '/source')).targetId;
  await ops.waitForReady(conn, tab);
  await ops.evaluate(conn, tab, `document.body.innerHTML=${JSON.stringify(listing([1, 2, 3].map(id => card(id)).join('')))}`);
  hits.length = 0;
  try { await fn(tab); } finally { await ops.closeTab(conn, tab); }
});
const source = tab => ops.evaluate(conn, tab, '({url:location.href,html:document.body.innerHTML,scroll:scrollY})');
const ids = r => r.item_loops[0].items.map(item => new URL(item.link).searchParams.get('id'));

t('three linked details batch extraction with pending checks and preserve source and unrelated tabs', async tab => {
  const other = (await ops.newTab(conn, base + '/unrelated')).targetId;
  try {
    const before = await source(tab), tabs = (await ops.tabs(conn)).map(t => t.id).sort();
    const j = good();
    const r = await run(tab, ['for top 3 { click "Room details" => "room details shown"; extract "price" as $price; extract "cancellation" as $policy }'], j);
    assert.equal(r.done, true, JSON.stringify(r.stopped));
    assert.deepEqual(ids(r), ['1', '2', '3']);
    assert.equal(r.items_completed, 3);
    assert.equal(r.items_requested, 3);
    assert.equal(hits.filter(hit => hit.startsWith('/input?')).length, 3);
    assert.equal(j.calls.filter(c => c.questions['extract.price'] && c.questions['extract.cancellation'] && c.questions.prev_expect).length, 3);
    assert.deepEqual(await source(tab), before);
    assert.deepEqual((await ops.tabs(conn)).map(t => t.id).sort(), tabs, JSON.stringify(await ops.tabs(conn)));
    assert.deepEqual(r.owned_tabs, []);
    assert.deepEqual(r.bindings || [], []);
    assert.ok(r.item_loops[0].items.every(item => item.bindings.length === 2));
    assert.equal(r.item_loops[0].items[2].extracted[0].value, 'SGD 300');
    assert.ok(r.steps.some(row => row.path === '1.item[3].3'));
    fs.writeFileSync('/tmp/codex-bc/dsl-b-loop-samples.txt', formatSteps(r) + '\n\n');
    assert.match(formatSteps(r).trim().split('\n').at(-1), /^✓ done:/);
  } finally { await ops.closeTab(conn, other); }
});

t('freeze order excludes Spotlight and ad hints, deduplicates identical links and preserves query differences', async tab => {
  await ops.evaluate(conn, tab, `document.body.innerHTML=${JSON.stringify(listing(card(9).replace('Hotel 9', 'Spotlight Hotel 9') + card(8, 'aria-label="Sponsored"') + card(1) + card(1) + card(2) + card(3)))}`);
  const r = await run(tab, ['for top 3 { extract "price" }']);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(ids(r), ['1', '2', '3']);
  assert.equal(hits.filter(h => h === '/detail?id=1').length, 1);
});

t('each membership accepts and rejects inclusive thresholds in one bounded entry request', async tab => {
  const j = good({ noul: (q, id) => id.startsWith('member.') ? ({ 'member.1': .25, 'member.2': .75, 'member.3': .9 }[id]) : id === 'extract_verify' ? .95 : .04 });
  const r = await run(tab, ['each "free cancellation" up to 2 { extract "price" }'], j);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(ids(r), ['2', '3']);
  const calls = j.calls.filter(c => c.questions['member.1']);
  assert.equal(calls.length, 1);
  assert.equal(Object.keys(calls[0].questions).filter(k => k.startsWith('member.')).length, 3);
});

t('membership uncertainty affecting prefix stops without opening, later uncertainty is irrelevant', async tab => {
  const j = good({ noul: (q, id) => id === 'member.1' ? .5 : id.startsWith('member.') ? .9 : .04 });
  const r = await run(tab, ['each "eligible" up to 1 { extract "price" }'], j);
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /membership unresolved/);
  assert.equal(hits.length, 0);
  const accepted = await run(tab, ['each "eligible" up to 1 { extract "price" }'], good({ noul: (q, id) => id === 'member.1' ? .75 : id.startsWith('member.') ? .5 : .04 }));
  assert.equal(accepted.done, true, JSON.stringify(accepted.stopped));
  assert.deepEqual(ids(accepted), ['1']);
});

t('zero and fewer items report source exhausted', async tab => {
  await ops.evaluate(conn, tab, `document.body.innerHTML=${JSON.stringify(listing(card(1) + card(8, 'aria-label="Sponsored"') + card(9, 'aria-label="Sponsored"')))}`);
  const fewer = await run(tab, ['for top 3 { extract "price" }']);
  assert.equal(fewer.done, true, JSON.stringify(fewer.stopped));
  assert.equal(fewer.item_loops[0].source_exhausted, true);
  assert.equal(fewer.items_completed, 1);
  await ops.evaluate(conn, tab, 'document.body.innerHTML="<main><h1>No hotels</h1></main>"');
  const zero = await run(tab, ['for top 3 { extract "price" }']);
  assert.equal(zero.done, true, JSON.stringify(zero.stopped));
  assert.equal(zero.items_completed, 0);
  assert.equal(zero.item_loops[0].source_exhausted, true);
});

t('200 item membership input cap stops when selection requires unseen items', async tab => {
  await ops.evaluate(conn, tab, `document.body.innerHTML=${JSON.stringify(listing(Array.from({ length: 205 }, (_, i) => card(i + 1)).join('')))}`);
  const j = good();
  const r = await run(tab, ['each "eligible" up to 3 { extract "price" }'], j);
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /truncat|unseen/);
  const call = j.calls.find(c => c.questions['member.1']);
  assert.equal(Object.keys(call.questions).filter(k => k.startsWith('member.')).length, 200);
  assert.equal(hits.length, 0);
});

t('ambiguous equal main groups and unlinked cards stop safely', async tab => {
  await ops.evaluate(conn, tab, `document.body.innerHTML='<main style="display:flex"><section style="width:400px"><ul>'+${JSON.stringify(card(1) + card(2) + card(3))}+'</ul></section><section style="width:400px"><ul>'+${JSON.stringify(card(4) + card(5) + card(6))}+'</ul></section></main>'`);
  const ambiguous = await run(tab, ['for top 1 { extract "price" }']);
  assert.equal(ambiguous.done, false);
  assert.match(ambiguous.stopped.reason, /Ambiguous main groups/);
  assert.equal(hits.length, 0);
  await ops.evaluate(conn, tab, `document.body.innerHTML=${JSON.stringify(listing(card(1).replace(/<a[^>]*>(.*?)<\/a>/, '<span>$1</span>') + card(2).replace(/<a[^>]*>(.*?)<\/a>/, '<span>$1</span>') + card(3).replace(/<a[^>]*>(.*?)<\/a>/, '<span>$1</span>')))}`);
  const unlinked = await run(tab, ['for top 1 { extract "price" }']);
  assert.equal(unlinked.done, false);
  assert.match(unlinked.stopped.reason, /detail link/);
});

t('SPA redraw after entry does not replace frozen detail links', async tab => {
  const j = good();
  const fetch = j.fetchImpl;
  let changed = false;
  j.fetchImpl = async (...args) => {
    if (!changed) { changed = true; await ops.evaluate(conn, tab, `document.querySelector('ul').innerHTML=${JSON.stringify(card(7) + card(8) + card(9))}`); }
    return fetch(...args);
  };
  const r = await run(tab, ['for top 3 { extract "price" }'], j);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(ids(r), ['1', '2', '3']);
});

t('missing optional extraction stays null in each item without binding leakage', async tab => {
  const j = good({ choice: (q, id) => id.includes('missing') ? 'none' : optionWith(q, 'SGD') });
  const r = await run(tab, ['for top 2 { extract "price" as $price; optional extract "missing" }'], j);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.ok(r.item_loops[0].items.every(item => item.extracted.some(e => e.what === 'missing' && e.value == null)));
  assert.equal(r.item_loops[0].items[0].bindings[0].value, 'SGD 100');
  assert.equal(r.item_loops[0].items[1].bindings[0].value, 'SGD 200');
  assert.deepEqual(r.bindings || [], []);
});

t('failure on item two preserves partial records, closes owned tabs and final stop line', async tab => {
  const before = await source(tab), tabs = (await ops.tabs(conn)).map(t => t.id).sort();
  const j = good({ choice: (q, id, state) => JSON.stringify(state).includes('Detail 2') && id.includes('price') ? 'none' : optionWith(q, 'SGD') });
  const r = await run(tab, ['for top 3 { extract "price" as $price }'], j);
  assert.equal(r.done, false, JSON.stringify(r));
  assert.equal(r.items_completed, 1);
  assert.equal(r.item_loops[0].items.length, 2);
  assert.equal(r.item_loops[0].items[1].completed, false);
  assert.equal(r.stopped.step, '1.item[2].1');
  assert.deepEqual(await source(tab), before);
  assert.deepEqual((await ops.tabs(conn)).map(t => t.id).sort(), tabs);
  assert.deepEqual(r.owned_tabs, []);
  fs.appendFileSync('/tmp/codex-bc/dsl-b-loop-samples.txt', formatSteps(r) + '\n');
  assert.match(formatSteps(r).trim().split('\n').at(-1), /^✗ stopped at step/);
});

t('failed per-item final page check stops before completion and preserves source and cleanup', async tab => {
  const before = await source(tab), tabs = (await ops.tabs(conn)).map(t => t.id).sort();
  const j = good(), fetch = j.fetchImpl;
  let extractionSeen = false, checkFailures = 0;
  j.fetchImpl = async (url, init) => {
    const questions = JSON.parse(init.body).questions;
    const extracting = Object.keys(questions).some(key => key.startsWith('extract.'));
    if (extracting) extractionSeen = true;
    if (extractionSeen && !extracting && questions.challenge && questions.error) {
      checkFailures++;
      throw new Error('Injected per-item final check transport failure');
    }
    return fetch(url, init);
  };
  const r = await run(tab, ['for top 3 { extract "price" }'], j);
  assert.equal(r.done, false, JSON.stringify(r));
  assert.match(r.stopped.reason, /Injected per-item final check transport failure/);
  assert.ok(checkFailures >= 1);
  assert.equal(r.items_completed, 0);
  assert.equal(r.item_loops[0].items.length, 1);
  assert.equal(r.item_loops[0].items[0].completed, false);
  assert.deepEqual(hits.filter(hit => hit.startsWith('/detail?')), ['/detail?id=1']);
  assert.deepEqual(await source(tab), before);
  assert.deepEqual((await ops.tabs(conn)).map(t => t.id).sort(), tabs);
  assert.deepEqual(r.owned_tabs, []);
});

t('deadline reached after first item cleanup prevents opening the second detail', async tab => {
  const before = await source(tab), tabs = (await ops.tabs(conn)).map(t => t.id).sort();
  const originalBrowser = conn.browser, originalNow = Date.now;
  const detailTabs = new Set();
  let advanced = false, r;
  conn.browser = async function (method, params, ...rest) {
    const result = await originalBrowser.call(this, method, params, ...rest);
    if (method === 'Target.createTarget' && params?.url?.includes('/detail?')) detailTabs.add(result.targetId);
    if (!advanced && method === 'Target.closeTarget' && detailTabs.has(params?.targetId)) {
      advanced = true;
      Date.now = () => originalNow() + 180000;
    }
    return result;
  };
  try {
    r = await run(tab, ['for top 3 { extract "price" }']);
  } finally {
    Date.now = originalNow;
    conn.browser = originalBrowser;
  }
  assert.equal(advanced, true);
  assert.equal(r.done, false, JSON.stringify(r));
  assert.match(r.stopped.reason, /deadline/i);
  assert.equal(detailTabs.size, 1);
  assert.deepEqual(hits.filter(hit => hit.startsWith('/detail?')), ['/detail?id=1']);
  assert.deepEqual(await source(tab), before);
  assert.deepEqual((await ops.tabs(conn)).map(t => t.id).sort(), tabs);
  assert.deepEqual(r.owned_tabs, []);
});

t('loop selection never runs an automatic note on the frozen source', async tab => {
  await ops.evaluate(conn, tab, `document.body.insertAdjacentHTML('afterbegin','<button id="change">Change source</button>'); window.sourceChanges=0; change.onclick=()=>{sourceChanges++;document.querySelector('ul').remove()}`);
  await notes.add(base + '/source', 'The source can change', { force: true, on: { situation: 'the source can change', steps: ['click "Change source"'] } });
  try {
    const before = await source(tab);
    const j = good({ noul: (q, id) => id.startsWith('on_') || id.startsWith('member.') ? .95 : .04 });
    const r = await run(tab, ['each "free cancellation" up to 1 {}'], j, { noNotes: false });
    assert.equal(r.done, true, JSON.stringify(r.stopped));
    assert.deepEqual(await source(tab), before);
    assert.equal(await ops.evaluate(conn, tab, 'sourceChanges'), 0);
    assert.ok(!j.calls.some(call => Object.keys(call.questions).some(key => key.startsWith('on_'))));
  } finally { notes.clear('127.0.0.1'); }
});

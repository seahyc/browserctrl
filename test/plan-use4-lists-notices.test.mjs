import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { page } from '../lib/page/index.mjs';
import { itemsExpression, mainGroup } from '../lib/items.mjs';
import { newNotices } from '../lib/do/outcome.mjs';
import { startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

let browser, conn;
const haveBrowser = Boolean(chromeBinary());
before(async () => { if (haveBrowser) { browser = await startHeadlessBrowser(TEST_PORT); conn = await connect(TEST_PORT); } });
after(async () => { conn?.close(); await browser?.close(); });
const fixture = async (html, fn) => {
  const id = (await ops.newTab(conn, 'data:text/html,' + encodeURIComponent('<meta charset="utf-8"><base href="https://fixture.example/">' + html))).targetId;
  await ops.waitForReady(conn, id, { waitUntil: 'load' });
  try { await fn(id); } finally { await ops.closeTab(conn, id); }
};

test('scrolling result cards beat their larger summary and pagination wrapper', { skip: !haveBrowser }, async () => {
  await fixture(`<style>body{margin:0}main{width:900px}.summary{height:120px}.panel{height:200px;overflow:auto}.card{height:130px;margin:8px}</style><main><div class=summary><h1>Search Results near Somewhere</h1></div><div class=summary>1 - 20 results of 87 · Sort By</div><div class=panel>${['Alley Creek Camp','Johnson Creek Camp','Johnson Creek Day Use','Quiet Creek Camp'].map((name,i)=>`<article class=card><span>Enter dates for availability</span><a href="/camp/${i}"><h2>${name}</h2></a><p>Camping by the lake</p></article>`).join('')}</div><div class=summary>1 - 20 results of 87 · 1 · 2 · 3 · 4 · 5</div></main>`, async id => {
    const r = await ops.evaluate(conn, id, itemsExpression());
    const chosen = mainGroup(r);
    console.log('main list:', chosen.items.map(i => i.text).join(' | '));
    assert.equal(chosen.count, 4);
    assert.match(chosen.items[0].text, /Alley Creek Camp/);
    assert.ok(chosen.items.every(i => i.link));
  });
});

test('navigation notices exclude static promos and alert button class names', { skip: !haveBrowser }, async () => {
  await fixture(`<div class=promo-banner>Black Friday Early Access up to 70% OFF</div><div class=notice>Looking for tours beyond Japan?</div><button class=availability-alert aria-label="Availability Alert Button">Set Availability Alert</button><div role=alert>Campers: a burn ban is in effect</div><div role=status>Search complete</div><div class=toast>Coupon available</div>`, async id => {
    const after = await ops.evaluate(conn, id, page('page-state'));
    const notices = newNotices({url:'https://old.example/',view:'',notices:[]}, after);
    console.log('navigation notices:', JSON.stringify(notices));
    assert.deepEqual(notices, ['Campers: a burn ban is in effect','Search complete']);
    const before = {...after, notices: [], liveNotices: [], view:''};
    assert.ok(newNotices(before, after).includes('Coupon available'));
    assert.ok(!after.notices.some(t => /Set Availability Alert/.test(t)));
  });
});

test('main list prefers heading and link cards over a larger summary group', () => {
  const summary = {count: 3, box:{w:900,h:1000}, items:[{text:'Search Results'}]};
  const cards = {count:20,cards:20, box:{w:600,h:200}, items:[{text:'Alley Creek Camp',link:'/camp/1'}]};
  assert.equal(mainGroup({groups:[summary,cards]}), cards);
});

test('explicit navigation suppresses static inline messages on reload and query navigation', () => {
  const before = {url:'https://example.org/results?q=one',view:'',notices:[]};
  for (const url of [before.url, 'https://example.org/results?q=two']) {
    const after = {url,view:'Coupon available',notices:['Black Friday sale','Search complete'],liveNotices:['Search complete']};
    assert.deepEqual(newNotices(before,after,{navigation:true}), ['Search complete']);
    assert.ok(newNotices(before,after).includes('Coupon available'));
  }
});

// How do picks a control for a step: exact names without Jev, refs, item ids and selectors, same-named
// and redrawn controls, wrong picks that must stop, and how steps parse.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { targetQuestion } from '../lib/jev.mjs';
import { itemsExpression } from '../lib/items.mjs';
import { parseStep, runSteps, formatSteps, missingFromPick, looksLikeSelector } from '../lib/steps.mjs';
import { fakeJev, planJev, optionWith } from './fake-jev.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-memo-'));
process.env.CDP_AGENT_ID = 'test-do-grounding';
process.env.BROWSERCTRL_NOTIFY = '0';
process.env.BROWSERCTRL_TRACES = TRACES;
process.env.BROWSERCTRL_NOTES = 'off';
process.env.BROWSERCTRL_READ_TOKENS = path.join(MEMO, 'read-tokens.json');
process.env.BROWSERCTRL_SETTLE_MEMORY = path.join(MEMO, 'never.json');
process.env.BROWSERCTRL_SITE_TROUBLE = path.join(MEMO, 'trouble.json');

// Jev answers "none" for every target and no overlay: only browserctrl's own logic acts.
const noJev = fakeJev();

const haveBrowser = Boolean(chromeBinary());
let fixture, browser, conn;
before(async () => {
  if (!haveBrowser) return;
  delete process.env.TYPESAFE_API_KEY;
  process.env.BROWSERCTRL_JEV_ENV = path.join(os.tmpdir(), 'no-such-jev.env');
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => {
  try { conn?.close(); } catch {}
  await browser?.close();
  await fixture?.close();
  fs.rmSync(TRACES, { recursive: true, force: true });
  fs.rmSync(MEMO, { recursive: true, force: true });
});
const t = (name, fn) => test(name, { skip: haveBrowser ? false : 'no Chromium-family browser installed' }, fn);
const url = (page) => fixture.url + 'fixtures/' + page;
const open = async (page, waitUntil = 'load') => {
  const id = (await ops.newTab(conn, url(page))).targetId;
  await ops.waitForReady(conn, id, { waitUntil });
  return id;
};
const text = (id, sel) => ops.evaluate(conn, id, `document.querySelector(${JSON.stringify(sel)}).textContent`);
const state = (id) => ops.evaluate(conn, id, `document.querySelector('#state').textContent`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));


t('exact visible link text bypasses a different accessible name', async () => {
 const id = await open('plan-use.html');
 const r = await runSteps(conn,id,['click A very long visible catalogue title'],{jev:noJev,noNotes:true});
 console.log(formatSteps(r));
 assert.equal(r.done,true,JSON.stringify(r.stopped));
 assert.equal(await state(id),'link');
 assert.doesNotMatch(r.steps[0].how,/jev p=/);
 await ops.closeTab(conn,id);
});
t('hover menu reveals an exact option before asking Jev', async () => {
 const id = await open('plan-use.html');
 const r = await runSteps(conn,id,['click Negative (2,756)'],{jev:noJev,noNotes:true});
 console.log(formatSteps(r));
 assert.equal(r.done,true,JSON.stringify(r.stopped));
 assert.equal(await state(id),'negative');
 assert.doesNotMatch(r.steps[0].how,/jev p=/);
 await ops.closeTab(conn,id);
});
t('covered click names the blocking dialog and appropriate advice', async () => {
 const id = await open('plan-use.html');
 await ops.evaluate(conn,id,`document.querySelector('#cover').style.display='block'`);
 await assert.rejects(ops.click(conn,id,{selector:'#under'}), /covered by.*Important edits.*dialog.*Close the covering dialog/);
 await ops.closeTab(conn,id);
});

t('an exact items entry text grounds its actionable link', async () => {
 const id = await open('items-market.html');
 const listing = await ops.evaluate(conn,id,itemsExpression({all:true}));
 const item = listing.groups.flatMap(g=>g.items).find(i=>i.text && i.link);
 assert.ok(item);
 const r = await runSteps(conn,id,[`click ${JSON.stringify(item.text)}`],{jev:noJev,noNotes:true});
 console.log(formatSteps(r));
 assert.ok(r.steps[0].target,JSON.stringify(r.stopped));
 assert.doesNotMatch(r.steps[0].how,/jev p=/);
 await ops.closeTab(conn,id);
});
t('a covering consent dialog is dismissed through overlay machinery and retried once', async () => {
 const id = await open('plan-use.html');
 await ops.evaluate(conn,id,`document.querySelector('#cover').remove();document.body.insertAdjacentHTML('beforeend','<div role="dialog" aria-labelledby="cookie-title consent-title" style="position:fixed;inset:0;z-index:20;background:white"><span id="cookie-title">Cookie</span><span id="consent-title">consent banner</span><button onclick="this.parentElement.remove()">Close</button></div>')`);
 const model=fakeJev({choice:(q,id)=> id==='category' ? 'c1' : optionWith(q,'Close')});
 const r=await runSteps(conn,id,['click #under'],{jev:model,noNotes:true});
 console.log(formatSteps(r));
 assert.equal(r.done,true,JSON.stringify(r.stopped));
 assert.match(r.steps[0].how,/dismissed covering consent banner/);
 assert.equal(await ops.evaluate(conn,id,`!!document.querySelector('[role=dialog]')`),false);
 await ops.closeTab(conn,id);
});

t('fixed page chrome scroll recovery is recorded in how', async () => {
 const id=await open('plan-use.html');
 await ops.evaluate(conn,id,`document.body.style.minHeight='3000px';const b=document.querySelector('#under');b.style.cssText='position:absolute;top:'+ (innerHeight-35)+'px;left:30px';b.onclick=()=>document.querySelector('#state').textContent='clear';document.body.insertAdjacentHTML('beforeend','<header aria-label="Page toolbar" style="position:fixed;bottom:0;left:0;right:0;height:100px;background:white;z-index:30">Toolbar</header>')`);
 const r=await runSteps(conn,id,['click #under'],{jev:noJev,noNotes:true});
 console.log(formatSteps(r));
 assert.equal(r.done,true,JSON.stringify(r.stopped));
 assert.match(r.steps[0].how,/scrolled clear/);
 assert.equal(await state(id),'clear');
 await ops.closeTab(conn,id);
});
t('automatic menu reveal refuses a checkout submit trigger', async () => {
 const id=await open('plan-use.html');
 await ops.evaluate(conn,id,`document.querySelector('#group').outerHTML='<form onsubmit="document.body.dataset.committed=1;return false"><input autocomplete="cc-number" aria-label="Card number"><button aria-controls="unsafe">Options</button><div id="unsafe" hidden><button>Hidden checkout option</button></div></form>'`);
 const r=await runSteps(conn,id,['click Hidden checkout option'],{jev:noJev,noNotes:true});
 assert.equal(r.done,false);
 assert.equal(await ops.evaluate(conn,id,'document.body.dataset.committed'),undefined);
 await ops.closeTab(conn,id);
});

t('exact visible link text also grounds links inside open shadow roots', async () => {
 const id=await open('plan-use.html');
 await ops.evaluate(conn,id,`const host=document.createElement('div');document.body.append(host);host.attachShadow({mode:'open'}).innerHTML='<a href="#shadow" aria-label="short accessible label" onclick="document.body.dataset.shadow=1;return false">Long visible title in a shadow root</a>'`);
 const r=await runSteps(conn,id,['click Long visible title in a shadow root'],{jev:noJev,noNotes:true});
 assert.equal(r.done,true,JSON.stringify(r.stopped));
 assert.equal(await ops.evaluate(conn,id,'document.body.dataset.shadow'),'1');
 await ops.closeTab(conn,id);
});
t('automatic consent recovery leaves a consent settings editor open', async () => {
 const id=await open('plan-use.html');
 await ops.evaluate(conn,id,`const c=document.querySelector('#cover');c.style.display='block';c.setAttribute('aria-label','Cookie preferences');c.innerHTML='<input aria-label="Preferences"><button onclick="this.parentElement.remove()">Close</button>'`);
 const r=await runSteps(conn,id,['click #under'],{jev:noJev,noNotes:true});
 assert.equal(r.done,false);
 assert.equal(await ops.evaluate(conn,id,`!!document.querySelector('#cover')`),true);
 await ops.closeTab(conn,id);
});

t('a closed details link with phantom geometry is revealed before grounding', async () => {
 const id=await open('plan-use.html');
 const html=`<details><summary>Education</summary><a href="#selected" onclick="document.querySelector('#state').textContent='selected';return false">Phantom geometry link</a></details><output id="state"></output>`;
 await ops.evaluate(conn,id,`document.body.innerHTML=${JSON.stringify(html)}`);
 const snap=await ops.readPage(conn,id,{includeHidden:true,all:true});
 assert.ok(snap.elements.find(e=>e.name==='Phantom geometry link')?.hidden);
 const r=await runSteps(conn,id,['click Phantom geometry link'],{jev:noJev,noNotes:true});
 console.log(formatSteps(r));
 assert.equal(r.done,true,JSON.stringify(r.stopped));
 assert.equal(await state(id),'selected');
 assert.match(r.steps[0].how,/opened "Education" first/);
 await ops.closeTab(conn,id);
});

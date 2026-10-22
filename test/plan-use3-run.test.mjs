// How do picks a control for a step: exact names without Jev, refs, item ids and selectors, same-named
// and redrawn controls, wrong picks that must stop, and how steps parse.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { detectSiteBlock } from '../lib/do/search-outcome.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { fakeJev, optionWith } from './fake-jev.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-memo-'));
process.env.CDP_AGENT_ID = 'test-plan-use3-run';
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
const state = (id) => ops.evaluate(conn, id, `document.querySelector('#state').textContent`);




t('acted failed expectation resumes after the input and counts only reached leaves', async () => {
 const id=await open('plan-use3-run.html');
 try {
 const r=await runSteps(conn,id,['click Change => "Missing"','optional click Absent','wait 1','wait 1'],{jev:noJev,noNotes:true});
 console.log(formatSteps(r));
 assert.equal(r.executed_leaves,1);
 assert.match(formatSteps(r),/step 1 already ran/);
 assert.match(formatSteps(r),/resume:.*'optional click Absent' 'wait 1' 'wait 1'/);
 assert.doesNotMatch(formatSteps(r).split('resume:')[1],/click Change/);
 } finally {await ops.closeTab(conn,id);}
});
t('acted failed expectation on a different URL has no resume', async () => {
 const id=await open('plan-use3-run.html');
 try {
 const r=await runSteps(conn,id,['click "Navigate wrong" => "Missing"','wait 1'],{jev:noJev,noNotes:true});
 console.log(formatSteps(r));
 assert.doesNotMatch(formatSteps(r),/resume:/);
 } finally {await ops.closeTab(conn,id);}
});
t('an empty extraction finishes unsure', async () => {
 const id=await open('plan-use3-run.html');
 try {
 const r=await runSteps(conn,id,['extract "number of results"'],{jev:noJev,noNotes:true});
 console.log(formatSteps(r));
 assert.equal(r.unsure,true);
 assert.match(formatSteps(r),/unsure: nothing answered "number of results"/);
 } finally {await ops.closeTab(conn,id);}
});
for (const when of ['start','end']) t('dismiss listed signup at '+when+' even if blocker judgment is no',async()=>{
 const id=await open('plan-use3-run.html');
 try {
 if(when==='start') await ops.evaluate(conn,id,'document.querySelector("dialog").showModal()');
 const j=fakeJev({choice:(q,id)=>id==='category'?optionWith(q,'sign-up popup'):id==='control'?Object.keys(q.criteria).find(k=>q.criteria[k]?.name==='Close')||'none':'none'});
 const r=await runSteps(conn,id,[when==='start'?'wait 1':'click "Show signup"'],{jev:j,noNotes:true,dismiss:'sign-up popup'});
 console.log(formatSteps(r));
 assert.equal(await ops.evaluate(conn,id,'document.querySelector("dialog").open'),false);
 assert.equal(r.events.filter(e=>e.type==='dismissed').length,1);
 } finally {await ops.closeTab(conn,id);}
});
t('nav then items marks an access denied landing as blocked', async()=>{
 const id=await open('plan-use3-run.html');
 try {
 const r=await runSteps(conn,id,['nav '+url('plan-use3-block.html')],{jev:noJev,noNotes:true,then:'items',prefetch:false});
 console.log(formatSteps(r));
 assert.equal(r.done,false);
 assert.match(r.stopped.reason,/site blocked this browser/);
 assert.doesNotMatch(formatSteps(r),/resume:/);
 } finally {await ops.closeTab(conn,id);}
});

t('a slider value alone cannot prove a result filter applied', async()=>{
 const id=await open('plan-use3-controls.html?stuck=1');
 try {
 await ops.evaluate(conn,id,'document.querySelector("#panel").hidden=false');
 const r=await runSteps(conn,id,['set "Shortest duration" = 11'],{jev:noJev,noNotes:true});
 console.log(formatSteps(r));
 assert.equal(r.unsure,true);
 assert.match(formatSteps(r),/neither the URL nor the results changed/);
 } finally {await ops.closeTab(conn,id);}
});

t('a stopped plan still dismisses its listed popup at the end',async()=>{
 const id=await open('plan-use3-run.html');
 try {
 const j=fakeJev({choice:(q,id)=>id==='category'?optionWith(q,'sign-up popup'):id==='control'?Object.keys(q.criteria).find(k=>q.criteria[k]?.name==='Close')||'none':'none'});
 const r=await runSteps(conn,id,['click "Show signup" => "Missing"','wait 1'],{jev:j,noNotes:true,dismiss:'sign-up popup'});
 assert.equal(r.done,false);
 assert.equal(await ops.evaluate(conn,id,'document.querySelector("dialog").open'),false);
 }finally {await ops.closeTab(conn,id);}
});

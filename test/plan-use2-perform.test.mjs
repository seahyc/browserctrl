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
import { fakeJev } from './fake-jev.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-memo-'));
process.env.CDP_AGENT_ID = 'test-plan-use2-perform';
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



t('Enter waits for autocomplete suggestions to reflect the typed value', async () => {
 const id=await open('plan-use2-perform.html');
 const r=await runSteps(conn,id,['fill "Destination" = "Iceland"','key Enter'],{jev:noJev,noNotes:true});
 console.log(formatSteps(r));
 assert.equal(r.done,true,JSON.stringify(r.stopped));
 assert.match(await ops.evaluate(conn,id,'document.title'),/Iceland/);
 await ops.closeTab(conn,id);
});
t('a search that navigates elsewhere stops unsure before the next step', async () => {
 const id=await open('plan-use2-perform.html?wrong');
 const r=await runSteps(conn,id,['fill "Destination" = "Iceland"','key Enter','wait 1'],{jev:noJev,noNotes:true});
 console.log(formatSteps(r));
 assert.equal(r.done,false);
 assert.equal(r.steps[1].unsure,true);
 assert.match(r.stopped.reason,/page shows.*Norway.*not the typed.*Iceland/);
 assert.equal(r.steps.length,2);
 await ops.closeTab(conn,id);
});
t('terminal denied interstitial stops without a resume command', async () => {
 const id=await open('plan-use2-perform.html');
 await ops.evaluate(conn,id,`document.title='Access denied';document.body.innerHTML='<h1>You have been blocked</h1><p>Your request was denied.</p>'`);
 const r=await runSteps(conn,id,['fill "Destination" = "Iceland"'],{jev:noJev,noNotes:true});
 console.log(formatSteps(r));
 assert.match(r.stopped.reason,/site blocked this browser/);
 assert.doesNotMatch(formatSteps(r),/resume:/);
 await ops.closeTab(conn,id);
});
t('plain click opens a pressed chip while check stays idempotent', async () => {
 const id=await open('plan-use2-perform.html');
 const r=await runSteps(conn,id,['click "Length: 5-10 days"','check "Pool"'],{jev:noJev,noNotes:true});
 console.log(formatSteps(r));
 assert.equal(r.done,true,JSON.stringify(r.stopped));
 assert.equal(await state(id),'editor opened');
 assert.equal(await ops.evaluate(conn,id,`document.querySelector('[role=checkbox]').getAttribute('aria-checked')`),'true');
 assert.equal(r.steps[1].already,true);
 await ops.closeTab(conn,id);
});
t('a fully clipped target names its covering container in both selector and ref paths', async () => {
 const id=await open('plan-use2-perform.html');
 await assert.rejects(ops.click(conn,id,{selector:'#clipped'}),/covered by.*Collapsed destinations.*clipping container/);
 const snap=await ops.readPage(conn,id,{all:true});
 const el=snap.elements.find(e=>e.name==='Hidden choice');
 assert.ok(el);
 await assert.rejects(ops.click(conn,id,{ref:el.ref,token:snap.token}),/covered by.*Collapsed destinations.*clipping container/);
 const r=await runSteps(conn,id,['click #clipped'],{jev:noJev,noNotes:true});
 console.log(formatSteps(r));
 assert.match(r.stopped.reason,/covered by.*Collapsed destinations/);
 await ops.closeTab(conn,id);
});

t('a submit button with an arbitrary name verifies changed results at the same URL', async () => {
 const id=await open('plan-use2-perform.html');
 await ops.evaluate(conn,id,`document.querySelector('main').innerHTML='<form><label>Destination<input></label><button>Explore</button></form><div id="results">Choose a trip</div>'; document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('#results').textContent='Norway excursion'}`);
 const r=await runSteps(conn,id,['fill "Destination" = "Iceland"','click "Explore"','wait 1'],{jev:noJev,noNotes:true});
 console.log(formatSteps(r));
 assert.equal(r.done,false);
 assert.equal(r.steps[1].unsure,true);
 assert.match(r.stopped.reason,/Norway.*not the typed.*Iceland/);
 await ops.closeTab(conn,id);
});
t('existing security challenges retain captcha handling', async () => {
 const id=await open('plan-use2-perform.html');
 await ops.evaluate(conn,id,`document.title='Security check';document.body.innerHTML='<h1>Verify you are human</h1>'`);
 assert.equal(await detectSiteBlock({conn,tab:id}),null);
 await ops.closeTab(conn,id);
});

t('ordinary travel headings containing forbidden are not block pages', async () => {
 const id=await open('plan-use2-perform.html');
 await ops.evaluate(conn,id,`document.title='Forbidden City tours';document.querySelector('main').innerHTML='<h1>Forbidden City tours</h1><p>Explore the palace</p>'`);
 assert.equal(await detectSiteBlock({conn,tab:id}),null);
 await ops.closeTab(conn,id);
});

t('a cleared challenge may retain its security-check title', async () => {
 const id=await open('plan-use2-perform.html');
 try {
 await ops.evaluate(conn,id,`document.title='Security check';document.body.innerHTML='<p>Verified</p>'`);
 assert.equal(await detectSiteBlock({conn,tab:id}),null);
 } finally { await ops.closeTab(conn,id); }
});
t('marketing copy outside the main result list cannot verify a search', async () => {
 const id=await open('plan-use2-perform.html');
 try {
 await ops.evaluate(conn,id,`document.querySelector('main').innerHTML='<label>Destination<input></label><p> Iceland holiday guide </p><ul>'+[1,2,3].map(i=>'<li style="height:80px;width:600px"><a href="#'+i+'">Choose a trip '+i+'</a></li>').join('')+'</ul>';document.querySelector('input').onkeydown=e=>{if(e.key==='Enter')document.querySelectorAll('li a').forEach((a,i)=>a.textContent='Norway excursion '+i)}`);
 const r=await runSteps(conn,id,['fill Destination = Iceland','key Enter'],{jev:noJev,noNotes:true});
 console.log('marketing mismatch:',formatSteps(r));
 assert.equal(r.done,false);
 assert.match(r.stopped.reason,/Norway.*not the typed.*Iceland/);
 } finally { await ops.closeTab(conn,id); }
});

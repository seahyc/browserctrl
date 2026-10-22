// Scroll recovery, committed slider values and collapsed search-header disclosure.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { fakeJev } from './fake-jev.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';

const TRACES = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-traces-'));
const MEMO = fs.mkdtempSync(path.join(os.tmpdir(), 'browserctrl-test-memo-'));
process.env.CDP_AGENT_ID = 'test-plan-use4-controls';
process.env.BROWSERCTRL_NOTIFY = '0';
process.env.BROWSERCTRL_TRACES = TRACES;
process.env.BROWSERCTRL_NOTES = 'off';
process.env.BROWSERCTRL_READ_TOKENS = path.join(MEMO, 'read-tokens.json');
process.env.BROWSERCTRL_SETTLE_MEMORY = path.join(MEMO, 'never.json');
process.env.BROWSERCTRL_SITE_TROUBLE = path.join(MEMO, 'trouble.json');

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
const js = (id, expr) => ops.evaluate(conn, id, expr);
const run = async (id, steps) => { const r = await runSteps(conn, id, steps, { jev: fakeJev(), noNotes: true }); console.log(formatSteps(r)); return r; };


// Synthetic pages isolate the dogfood failures without a live site's changing state.
t('a clipped scroll-panel link is scrolled and retried once', async () => {
 const id=await open('plan-use2-perform.html');
 await js(id, `document.querySelector('main').innerHTML='<div style="height:100px;overflow:auto" id="panel"><div style="height:350px"></div><a id="camp" href="#camp">Alley Creek Camp</a></div>';let el=document.querySelector('#camp');el.scrollIntoView=()=>{}`);
 const r=await run(id,['click "Alley Creek Camp"']);
 assert.equal(r.done,true,JSON.stringify(r.stopped));
 assert.match(r.steps[0].how,/scroll.*container.*retried once/);
 assert.match(await js(id,'location.hash'),/camp/);
 await ops.closeTab(conn,id);
});
t('a native slider reports a delayed committed value instead of its input value', async () => {
 const id=await open('plan-use2-perform.html');
 await js(id, `document.querySelector('main').innerHTML='<label>Shortest duration<input type="range" min="0" max="30" value="1"></label><output>1 days</output>';document.querySelector('input').onchange=e=>setTimeout(()=>{e.target.value=Number(e.target.value)+1;document.querySelector('output').textContent=e.target.value+' days';history.replaceState({},'', '?duration='+e.target.value+'-')},30)`);
 const r=await run(id,['set "Shortest duration" = 11']);
 assert.equal(r.done,true,JSON.stringify(r.stopped));
 assert.equal(r.steps[0].unsure,true);
 assert.equal(r.steps[0].slider,'12');
 assert.match(formatSteps(r),/set 11, the page applied 12/);
 await ops.closeTab(conn,id);
});
t('an exact hidden field opens its containing clickable header summary', async () => {
 const id=await open('plan-use2-perform.html');
 await js(id, `document.querySelector('main').innerHTML='<header><div id="summary" role="button" tabindex="0">Thailand When? 2</div><div><form style="display:none"><input aria-label="Where do you want to go?"></form></div></header>';document.querySelector('#summary').onclick=()=>document.querySelector('form').style.display='block'`);
 const r=await run(id,['fill "Where do you want to go?" = "Japan"']);
 assert.equal(r.done,true,JSON.stringify(r.stopped));
 assert.equal(await js(id,'document.querySelector("input").value'),'Japan');
 await ops.closeTab(conn,id);
});
t('a keyboard slider reads its committed URL and visible value without an extra arrow', async () => {
 const id=await open('plan-use2-perform.html');
 await js(id, `document.querySelector('main').innerHTML='<div><span id="label">Shortest duration</span><div role="slider" aria-labelledby="label" aria-valuenow="10" aria-valuemin="0" aria-valuemax="30" tabindex="0" style="width:30px;height:30px;background:gray"></div><output>10 days</output></div>';window.arrows=0;let slider=document.querySelector('[role=slider]');slider.onkeydown=e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){window.arrows++;slider.setAttribute('aria-valuenow',Number(slider.getAttribute('aria-valuenow'))+(e.key==='ArrowRight'?1:-1))}};slider.onchange=()=>{document.querySelector('output').textContent=(Number(slider.getAttribute('aria-valuenow'))+1)+' days';history.replaceState({},'', '?duration='+(Number(slider.getAttribute('aria-valuenow'))+1)+'-')}`);
 const r=await run(id,['set "Shortest duration" = 11']);
 assert.equal(r.done,true,JSON.stringify(r.stopped));
 assert.equal(await js(id,'window.arrows'),1);
 assert.equal(r.steps[0].unsure,true);
 assert.match(formatSteps(r),/set 11, the page applied 12/);
 await ops.closeTab(conn,id);
});
t('an unrelated cover is never scrolled away or clicked through', async () => {
 const id=await open('plan-use2-perform.html');
 await js(id, `document.querySelector('main').innerHTML='<a id="camp" href="#camp" style="position:absolute;left:20px;top:20px">Alley Creek Camp</a><div style="position:fixed;inset:0;background:white;z-index:99">Cover</div>'`);
 const r=await run(id,['click #camp']);
 assert.equal(r.done,false);
 assert.match(r.stopped.reason,/covers|covered/);
 assert.equal(await js(id,'location.hash'),'');
 await ops.closeTab(conn,id);
});
t('ambiguous header controls keep the hidden search field stopped', async () => {
 const id=await open('plan-use2-perform.html');
 await js(id, `document.querySelector('main').innerHTML='<header><div role="button" tabindex="0" onclick="window.opened=true">Thailand When? 2</div><div role="button" tabindex="0" onclick="window.opened=true">Account</div><div><form style="display:none"><input aria-label="Where do you want to go?"></form></div></header>';window.opened=false`);
 const r=await run(id,['fill "Where do you want to go?" = "Japan"']);
 assert.equal(r.done,false);
 assert.equal(await js(id,'window.opened'),false);
 assert.match(formatSteps(r),/Present but hidden/);
 assert.match(formatSteps(r),/likely openers:.*Thailand When/);
 await ops.closeTab(conn,id);
});
t('a slider removed after commit keeps the observed value and requests a check', async () => {
 const id=await open('plan-use2-perform.html');
 await js(id, `document.querySelector('main').innerHTML='<label>Shortest duration<input type="range" min="0" max="30" value="1"></label>';document.querySelector('input').onchange=e=>setTimeout(()=>e.target.remove(),30)`);
 const r=await run(id,['set "Shortest duration" = 11']);
 assert.equal(r.steps[0].slider,'11');
 assert.equal(r.steps[0].unsure,true);
 assert.match(r.steps[0].unchecked,/committed value is unavailable/);
 await ops.closeTab(conn,id);
});

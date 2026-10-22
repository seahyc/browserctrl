import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { fakeJev } from './fake-jev.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';
process.env.BROWSERCTRL_CAPTURE = '0';
process.env.BROWSERCTRL_NOTES = 'off';
let fixture, browser, conn;
before(async () => {
 if (!chromeBinary()) return;
 fixture = await startFixtureServer(); browser = await startHeadlessBrowser(TEST_PORT); conn = await connect(TEST_PORT);
});
after(async () => { conn?.close(); await browser?.close(); await fixture?.close(); });
const t = (name, fn) => test(name, {skip: !chromeBinary()}, fn);
async function open(html) {
 const id = (await ops.newTab(conn, fixture.url)).targetId;
 await ops.waitForReady(conn,id,{waitUntil:'load'});
 await ops.evaluate(conn,id,`document.body.innerHTML=${JSON.stringify(html)}`);
 return id;
}

import { itemsExpression } from '../lib/items.mjs';
async function controls() { const id=(await ops.newTab(conn,fixture.url+'fixtures/plan-use3-controls.html')).targetId;await ops.waitForReady(conn,id,{waitUntil:'load'});return id; }
t('unique items title grounds without Jev despite rating suffix',async()=>{
 const id=await controls();try {
 await ops.evaluate(conn,id,itemsExpression());
 const model=fakeJev();const r=await runSteps(conn,id,['click "Beef Sirloin Tip Roast with Mushrooms"'],{jev:model,noNotes:true});
 console.log('item title:',formatSteps(r));assert.equal(r.done,true);assert.match(r.steps[0].how,/exact visible text/);assert.equal(await ops.evaluate(conn,id,'location.hash'),'#recipe');
 }finally{await ops.closeTab(conn,id)}
});
t('expanded attribute with hidden controlled content still clicks disclosure',async()=>{
 const id=await controls();try{const r=await runSteps(conn,id,['click Length','set "Shortest duration" = 11'],{jev:fakeJev(),noNotes:true});console.log('hidden disclosure:',formatSteps(r));assert.equal(await ops.evaluate(conn,id,'document.querySelector("#length").dataset.clicks'),'1');assert.equal(r.done,true);}finally{await ops.closeTab(conn,id)}
});
for(const kind of ['native','custom']) t(`${kind} slider commits pointerup filter`,async()=>{
 const id=await controls();try{await ops.evaluate(conn,id,'document.querySelector("#panel").hidden=false');const name=kind==='native'?'Shortest duration':'Commit duration';const r=await runSteps(conn,id,[`set "${name}" = 11`],{jev:fakeJev(),noNotes:true});console.log(kind+' commit:',formatSteps(r));assert.equal(r.done,true);assert.equal(await ops.evaluate(conn,id,'document.body.dataset.committed'),'11');assert.match(await ops.evaluate(conn,id,'location.search'),/duration=11/);}finally{await ops.closeTab(conn,id)}
});
t('visible controlled content keeps an already open disclosure open',async()=>{
 const id=await controls();try{await ops.evaluate(conn,id,'document.querySelector("#panel").hidden=false');const r=await runSteps(conn,id,['click Length','wait 1'],{jev:fakeJev(),noNotes:true});assert.equal(r.steps[0].already,true);assert.equal(await ops.evaluate(conn,id,'document.querySelector("#length").dataset.clicks'),undefined);}finally{await ops.closeTab(conn,id)}
});
t('duplicate items titles require disambiguation',async()=>{
 const id=await controls();try{await ops.evaluate(conn,id,`document.querySelector('#cards').insertAdjacentHTML('beforeend','<article><a href="#duplicate"><h2>Beef Sirloin Tip Roast with Mushrooms</h2><span>12 Ratings</span></a></article>')`);await ops.evaluate(conn,id,itemsExpression());const r=await ops.evaluate(conn,id,(await import('../lib/page/index.mjs')).page('find-direct',{kind:'text',value:'Beef Sirloin Tip Roast with Mushrooms',key:'duplicate-test',action:'click'}));assert.equal(r.error,'none');}finally{await ops.closeTab(conn,id)}
});

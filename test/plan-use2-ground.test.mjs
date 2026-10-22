import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { fakeJev, optionWith } from './fake-jev.mjs';
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
const guessed = p => fakeJev({choice:(q,id)=>id==='target'?{choice:optionWith(q,'5 to 10 days'),p}:'none'});
t('unrelated guessed name at p=0.8 stops before changing a filter', async () => {
 const id=await open('<button onclick="document.body.dataset.clicked=1">5 to 10 days</button>');
 try {
 const r=await runSteps(conn,id,['click Duration'],{jev:guessed(.8),noNotes:true});
 console.log('unrelated guess:',formatSteps(r));
 assert.equal(r.done,false); assert.match(r.stopped.reason,/no content word.*Duration.*0\.9/i);
 assert.equal(await ops.evaluate(conn,id,'document.body.dataset.clicked'),undefined);
 } finally {await ops.closeTab(conn,id);}
});
t('high-confidence synonyms remain usable', async () => {
 const id=await open('<button onclick="document.body.dataset.clicked=1">5 to 10 days</button>');
 try {const r=await runSteps(conn,id,['click Duration'],{jev:guessed(.94),noNotes:true}); assert.equal(r.done,true,JSON.stringify(r.stopped));}finally{await ops.closeTab(conn,id);}
});
t('plural and region words support a non-exact pick',async()=>{
 const id=await open('<section aria-label="Durations"><button onclick="document.body.dataset.clicked=1">5 to 10 days</button></section>');
 try {const r=await runSteps(conn,id,['click Duration'],{jev:guessed(.8),noNotes:true}); assert.equal(r.done,true,JSON.stringify(r.stopped));}finally{await ops.closeTab(conn,id);}
});
t('exact duplicate click prefers the filled field suggestion',async()=>{
 const id=await open('<input aria-label="Destination" role="combobox" aria-controls="choices"><a href="#wrong">Albania</a><div id="choices"><a href="#right">Albania</a></div>');
 try {const r=await runSteps(conn,id,['fill Destination = Albania','click Albania'],{jev:fakeJev(),noNotes:true});console.log('suggestion:',formatSteps(r));assert.equal(await ops.evaluate(conn,id,'location.hash'),'#right');}finally{await ops.closeTab(conn,id);}
});
t('optional absent control skips without any model or screenshot request',async()=>{
 const id=await open('<button>View details</button>');
 const model=fakeJev();
 try {const r=await runSteps(conn,id,['optional click "Accept all"'],{jev:model,noNotes:true});console.log(`optional absent: ${r.ms} ms, ${r.jev_calls} Jev calls`); assert.ok(r.steps[0].skipped);assert.equal(model.calls.length,0);}finally{await ops.closeTab(conn,id);}
});

t('far-off exact links keep their original page-order tie behavior',async()=>{
 const id=await open('<input aria-label="Destination"><a href="#first">Albania</a><a href="#second">Albania</a>');
 try {await runSteps(conn,id,['fill Destination = Albania','click Albania'],{jev:fakeJev(),noNotes:true});assert.equal(await ops.evaluate(conn,id,'location.hash'),'#first');}finally{await ops.closeTab(conn,id);}
});
t('a positioned listbox option wins over a far-off exact link',async()=>{
 const id=await open('<input style="position:absolute;left:10px;top:10px;width:200px;height:30px" aria-label="Destination"><a href="#wrong" style="position:absolute;top:400px">Albania</a><div role="listbox" style="position:absolute;left:10px;top:45px;width:200px"><a href="#right">Albania</a></div>');
 try {const r=await runSteps(conn,id,['fill Destination = Albania','click Albania'],{jev:fakeJev(),noNotes:true});assert.equal(await ops.evaluate(conn,id,'location.hash'),'#right');assert.match(r.steps[1].how,/suggestion/);}finally{await ops.closeTab(conn,id);}
});

t('an open consent overlay permits a plausible synonym precheck',async()=>{
 const id=await open('<div role="dialog" aria-label="Cookie consent"><button onclick="this.parentElement.remove()">I agree</button></div>');
 const model=fakeJev({choice:(q,id)=>id==='target'?{choice:optionWith(q,'I agree'),p:.94}:'none'});
 try {const r=await runSteps(conn,id,['optional click "Accept all"'],{jev:model,noNotes:true});assert.equal(r.done,true);assert.ok(!r.steps[0].skipped,JSON.stringify(r.steps));assert.equal(await ops.evaluate(conn,id,'!!document.querySelector("[role=dialog]")'),false);}finally{await ops.closeTab(conn,id);}
});
t('screenshot matching cannot bypass the unrelated-name confidence threshold',async()=>{
 const id=await open('<button style="position:absolute;left:100px;top:100px;width:140px;height:40px" onclick="document.body.dataset.clicked=1">5 to 10 days</button>');
 const b=await ops.evaluate(conn,id,'({width:innerWidth,height:innerHeight})');
 const model=fakeJev({choice:()=> 'none',noul:(q,k)=>k==='visible'?.99:k==='match'?.8:.04,box:()=>({box:{left:100/b.width,right:240/b.width,top:100/b.height,bottom:140/b.height},confidence:.99})});
 try {const r=await runSteps(conn,id,['click Duration'],{jev:model,noNotes:true});console.log('visual unsupported:',formatSteps(r));assert.equal(r.done,false);assert.equal(await ops.evaluate(conn,id,'document.body.dataset.clicked'),undefined);}finally{await ops.closeTab(conn,id);}
});

t('filled-field suggestion preference traverses an open shadow root',async()=>{
 const id=await open('<a href="#wrong">Albania</a><div id="host"></div>');
 try {
 await ops.evaluate(conn,id,`document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<input aria-label="Destination" aria-controls="choices"><div id="choices"><a href="#right">Albania</a></div>'`);
 const r=await runSteps(conn,id,['fill Destination = Albania','click Albania'],{jev:fakeJev(),noNotes:true});
 assert.equal(r.done,true,JSON.stringify(r.stopped));
 assert.equal(await ops.evaluate(conn,id,'location.hash'),'#right');
 }finally{await ops.closeTab(conn,id);}
});

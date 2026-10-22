import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { page, helperSource } from '../lib/page/index.mjs';
let fixture,browser,conn;
const haveBrowser=Boolean(chromeBinary());
before(async()=>{if(!haveBrowser)return;fixture=await startFixtureServer();browser=await startHeadlessBrowser(TEST_PORT);conn=await connect(TEST_PORT);});
after(async()=>{conn?.close();await browser?.close();await fixture?.close();});
const t=(name,fn)=>test(name,{skip:!haveBrowser},fn);
async function open(query=''){const id=(await ops.newTab(conn,fixture.url+'fixtures/plan-use5-visibility.html'+query)).targetId;await ops.waitForReady(conn,id,{waitUntil:'load'});return id;}
t('snapshot excludes clipped sr copies but keeps visible small containers',async()=>{
 const id=await open();try{
 const snap=await ops.readPage(conn,id,{all:true});
 const names=snap.elements.map(e=>e.name);
 for(const name of ['Hidden sr link','Hidden inset link','Hidden legacy link','Hidden overflow sr link'])assert.ok(!names.includes(name),name);
 for(const name of ['Visible thin link','Visible icon link','Visible ordinary link','Collapsed choice'])assert.ok(names.includes(name),name);
 }finally{await ops.closeTab(conn,id);}
});
t('hiddenWhy agrees for own clipping and sr ancestors',async()=>{
 const id=await open();try{
 const reasons=await ops.evaluate(conn,id,`(()=>{${helperSource('findKit')}const kit=findKit();return Object.fromEntries(['sr','inset','legacy','thin','icon','visible','overflow-sr','collapsed'].map(id=>[id,kit.hiddenWhy(document.getElementById(id))]));})()`);
 assert.deepEqual(reasons,{sr:'screen-reader only',inset:'screen-reader only',legacy:'screen-reader only',thin:'',icon:'',visible:'','overflow-sr':'screen-reader only',collapsed:''});
 }finally{await ops.closeTab(conn,id);}
});
t('5000-link snapshot benchmark (optional baseline source)',async()=>{
 const id=await open('?benchmark');try{
 let expression=page('snapshot',{all:true,max:6000});
 if(process.env.BC_VISIBILITY_BASELINE){const before=fs.readFileSync(process.env.BC_VISIBILITY_BASELINE,'utf8').trim().replace(/;+$/,'');const current=fs.readFileSync(new URL('../lib/page/snapshot.js',import.meta.url),'utf8').trim().replace(/;+$/,'');expression=expression.replace(current,before);}
 const result=await ops.evaluate(conn,id,`(()=>{let times=[],count;for(let i=0;i<9;i++){let start=performance.now();let snap=${expression};let ms=performance.now()-start;if(i>1)times.push(ms);count=snap.elements.length;}times.sort((a,b)=>a-b);return {links:document.querySelectorAll('a').length,count,medianMs:times[3],samplesMs:times};})()`);
 assert.equal(result.links,5000);assert.equal(result.count,5000);console.log('VISIBILITY BENCHMARK '+JSON.stringify(result));
 }finally{await ops.closeTab(conn,id);}
});

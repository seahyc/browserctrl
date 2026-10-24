import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {startFixtureServer,startHeadlessBrowser,TEST_PORT,scaled} from './helpers.mjs';
import {connect} from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import {page} from '../lib/page/index.mjs';
import {runSteps,formatSteps} from '../lib/steps.mjs';
import {fakeJev} from './fake-jev.mjs';
let fixture,browser,conn;
before(async()=>{fixture=await startFixtureServer();browser=await startHeadlessBrowser(TEST_PORT);conn=await connect(TEST_PORT)});
after(async()=>{conn?.close();await browser?.close();await fixture?.close()});
const open=async()=>{const id=(await ops.newTab(conn,fixture.url+'fixtures/plan-use3-notices.html')).targetId;await ops.waitForReady(conn,id);return id};
test('plan-use3 notices keep messages and omit media status and short counters',async()=>{const id=await open();await ops.evaluate(conn,id,"document.querySelector('#messages').hidden=false");const state=await ops.evaluate(conn,id,page('page-state'));console.log('notices:',JSON.stringify(state.notices));assert.deepEqual(state.notices,['We expanded your search area to show more results.','Added to bag']);await ops.closeTab(conn,id)});
test('plan-use3 dialog reports its accessible name',async()=>{const id=await open();await ops.evaluate(conn,id,"document.querySelector('dialog').showModal()");const snap=await ops.readPage(conn,id,{maxText:0});console.log('dialog:',JSON.stringify(snap.modal));assert.equal(snap.modal.name,'Travel more. Save more.');const r=await runSteps(conn,id,['wait 1'],{jev:fakeJev(),noNotes:true});console.log(formatSteps(r));assert.match(formatSteps(r),/flags:.*dialog.*Travel more\. Save more\./);await ops.closeTab(conn,id)});
test('plan-use3 heavy then items phase profile',async()=>{for(let n=0;n<3;n++){const id=(await ops.newTab(conn,'about:blank')).targetId;const start=Date.now();const r=await runSteps(conn,id,[`nav ${fixture.url}fixtures/plan-use3-notices.html`],{then:'items',jev:fakeJev(),noNotes:true,prefetch:false});console.log('PROFILE',n,JSON.stringify({wall:Date.now()-start,phases:r.phases,groups:r.items?.groups.length,count:r.items?.groups[0]?.count}));assert.ok(r.items.groups.some(g=>g.count===900));assert.ok((r.phases.setup||0)<scaled(3000),'navigation must not wait for content on the page it replaces');await ops.closeTab(conn,id)}});

test('plan-use3 loaded heavy page items profile',async()=>{const id=await open();for(let n=0;n<3;n++){const start=Date.now();const r=await runSteps(conn,id,['wait 1'],{then:'items',jev:fakeJev(),noNotes:true,prefetch:false});console.log('LOADED PROFILE',n,JSON.stringify({wall:Date.now()-start,phases:r.phases}));assert.ok(r.items.groups.some(g=>g.count===900))}await ops.closeTab(conn,id)});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../lib/ops.mjs';
import {safariReload} from '../lib/safari-reload.mjs';
import {safariCLI,safariMCP} from '../lib/safari-frontend.mjs';

test('focus and wake select only; refresh is the same reload function', async () => {
  const calls=[];
  const conn={browser:async (...args)=>calls.push(args)};
  await ops.focus(conn,'tab');await ops.wake(conn,'tab');
  assert.deepEqual(calls,[['Target.activateTarget',{targetId:'tab'}],['Target.activateTarget',{targetId:'tab'}]]);
  assert.equal(ops.refresh,ops.reload);
  assert.deepEqual(safariCLI('focus',['focus','native'],{}),safariCLI('wake',['wake','native'],{}));
  assert.deepEqual(safariMCP('browser_focus',{tab:'native'}),safariMCP('browser_wake',{tab:'native'}));
});

test('reload waits past the old complete document without navigating or focusing', async () => {
  const calls=[];let frames=0;
  const conn={send:async (_tab,method)=>{
    calls.push(method);
    if(method==='Page.getFrameTree')return {frameTree:{frame:{loaderId:++frames<3?'old':'new'}}};
    if(method==='Page.reload')return {};
    if(method==='Runtime.evaluate')return {result:{value:{ready:true,url:'https://example.test',focused:false}}};
    throw Error(method);
  }};
  assert.equal((await ops.reload(conn,'tab')).reloaded,true);
  assert.equal(calls.filter(m=>m==='Page.reload').length,1);
  assert.equal(frames,3);
  assert.ok(!calls.includes('Page.navigate')&&!calls.includes('Target.activateTarget'));
});

test('reload timeout does not replay the mutation or report old document ready', async () => {
  let reloads=0;
  const conn={send:async (_tab,method)=>{
    if(method==='Page.reload'){reloads++;return {};}
    return {frameTree:{frame:{loaderId:'unchanged'}}};
  }};
  await assert.rejects(ops.reload(conn,'tab',{timeoutMs:25}),/timed out.*not replayed/);
  assert.equal(reloads,1);
});

test('Safari reload schedules once and observes new document, including transient read failure', async () => {
  const calls=[];let reads=0;
  const call=async (_name,args,options)=>{
    calls.push({args,options});
    if(options.activityMethod==='Page.reload')return {content:[]};
    reads++;
    if(reads===1)return {isError:true,content:[]};
    return {content:[{type:'text',text:JSON.stringify({oldDocument:reads<3,state:'complete',focused:false,url:'https://example.test'})}]};
  };
  assert.equal((await safariReload('native',{call})).reloaded,true);
  assert.equal(calls.filter(c=>c.options.activityMethod==='Page.reload').length,1);
  assert.equal(reads,3);
});

test('failed Safari reload is never replayed', async () => {
  let calls=0;
  await assert.rejects(safariReload('native',{call:async()=>{calls++;return {isError:true};}}),/uncertain.*not replayed/);
  assert.equal(calls,1);
});


test('reload network quiet probes respect the remaining deadline', async () => {
  let frames=0,reloads=0;
  const conn={send:async (_tab,method,params)=>{
    if(method==='Page.getFrameTree') return {frameTree:{frame:{loaderId:++frames===1?'old':'new'}}};
    if(method==='Page.reload'){reloads++;return {};}
    if(params.expression.includes('getEntriesByType'))return new Promise(()=>{});
    return {result:{value:{ready:true,focused:false}}};
  }};
  await assert.rejects(ops.reload(conn,'tab',{waitUntil:'networkidle',timeoutMs:40}),/deadline|timed out/);
  assert.equal(reloads,1);
});

import './isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {createSafariVault} from '../lib/safari-vault.mjs';
import {runtimePath} from '../lib/env.mjs';

const target='00000000-0000-4000-8000-000000000001';
const request=()=>({version:1,request_id:crypto.randomUUID(),deadline:Date.now()/1000+60,destination:{browser:'safari',tab_id:target,origin:'https://example.test',fields:{password:'#password',totp:'#code'},submit:'#submit'},fields:{password:'SYNTHETIC-ONLY',totp:'123456'}});
const result=v=>({content:[{type:'text',text:JSON.stringify(v)}]});
function setup({owned=true,created=true,failClose=false,retained=false,entry=null}={}) {
  for(const name of ['vault-sensitive-9228.json','vault-requests-9228.json']) fs.rmSync(runtimePath(name),{force:true});
  const calls=[];let released=false;
  const api={callTool:async(name,args)=>{
    calls.push({name,args});
    if(name==='switch_tab') return result({});
    if(name==='evaluate_javascript') return entry?entry():result({ok:true,attempted:true,submitted:true});
    if(name==='close_tab') return failClose?{isError:true}:result({});
    if(name==='list_tabs') return result(retained?[{handle:target}]:[]);
    throw Error('unexpected_tool');
  }};
  const gate=createSafariVault({port:9228,client:async()=>api,busy:()=>false,owns:()=>owned,fresh:new Set(created?[target]:[]),release:()=>released=true});
  return {gate,calls,released:()=>released};
}
test('Safari only enters a fresh owned tab, closes it and protects Inspector history',async()=>{
  const f=setup();const r=await f.gate.run(request(),'owner');
  assert.equal(r.status,'completed');assert.equal(r.verification,'submitted');
  assert.deepEqual(f.calls.map(c=>c.name),['switch_tab','evaluate_javascript','close_tab','list_tabs']);
  assert.ok(f.released());assert.ok(!f.gate.blocked());assert.ok(f.gate.historyProtected());
  assert.ok(!JSON.stringify(r).includes('SYNTHETIC'));
});
test('Safari refuses unowned or non-disposable tabs before any native call',async()=>{
  for(const options of [{owned:false},{created:false}]) {
    const f=setup(options);await assert.rejects(f.gate.run(request(),'owner'),/not_owned/);assert.equal(f.calls.length,0);
  }
});
test('Safari uncertain entry retains protection if tab closure cannot be verified',async()=>{
  for(const options of [{failClose:true},{retained:true}]) {
    const f=setup(options);const r=await f.gate.run(request(),'owner');
    assert.equal(r.status,'indeterminate');assert.ok(f.gate.blocked());assert.ok(f.gate.historyProtected());assert.equal(f.released(),false);
  }
});
test('Safari transport failure closes the target without replaying credentials',async()=>{
  const f=setup({entry:()=>{throw Error('SYNTHETIC-ONLY');}});const r=await f.gate.run(request(),'owner');
  assert.equal(r.status,'indeterminate');assert.equal(f.calls.filter(c=>c.name==='evaluate_javascript').length,1);
  assert.ok(f.released());assert.ok(!f.gate.blocked());assert.ok(!JSON.stringify(r).includes('SYNTHETIC'));
});
test('Safari private entry blocks concurrent observations and persistent request replay',async()=>{
  let release;const hold=new Promise(r=>release=r);const f=setup({entry:async()=>{await hold;return result({ok:true,attempted:true,submitted:true});}});const r=request();const pending=f.gate.run(r,'owner');
  await new Promise(r=>setImmediate(r));assert.ok(f.gate.blocked());release();await pending;
  await assert.rejects(f.gate.run(r,'owner'),/not_owned/);assert.equal(f.calls.filter(c=>c.name==='evaluate_javascript').length,1);
});

test('Safari recovery verifies exact absence and releases the stale claim',async()=>{
  const f=setup({failClose:true});const r=request();await f.gate.run(r,'owner');
  assert.ok(f.gate.blocked());
  const result=await f.gate.recover({version:1,destination:{browser:'safari',tab_id:target,origin:r.destination.origin}},'owner');
  assert.equal(result.status,'completed');assert.ok(f.released());assert.ok(!f.gate.blocked());
});

test('Safari restart recovery cannot mistake a new native session for old-tab absence',async()=>{
  const f=setup({failClose:true});const r=request();await f.gate.run(r,'owner');
  let running=true,calls=0,released=false;
  const restarted=createSafariVault({port:9228,client:async()=>{calls++;throw Error('must_not_open_new_session');},busy:()=>false,owns:()=>true,fresh:new Set(),release:()=>released=true,browserRunning:()=>running});
  const recovery={version:1,destination:{browser:'safari',tab_id:target,origin:r.destination.origin}};
  assert.equal((await restarted.recover(recovery,'owner')).code,'recovery_unverified');
  assert.ok(restarted.blocked());assert.equal(calls,0);assert.equal(released,false);
  running=false;assert.equal((await restarted.recover(recovery,'owner')).status,'completed');assert.ok(released);assert.equal(calls,0);
});

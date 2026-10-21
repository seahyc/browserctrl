import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createVaultGate,validateVaultEntry,entryExpression} from '../lib/vault-entry.mjs';
import {runtimePath} from '../lib/env.mjs';

const request=()=>({version:1,request_id:crypto.randomUUID(),deadline:Date.now()/1000+60,destination:{browser:'dia',tab_id:'ABCDEF1234567890',origin:'https://example.test',fields:{password:'#password',totp:'#code'},submit:'#submit'},fields:{password:'private-password-123',totp:'654321'}});
let port=19800;
const gate=(options={})=>createVaultGate(++port,{recording:()=>false,busy:()=>false,reset:()=>{},evaluate:async(_t,e)=>e.includes('values={}')?{ok:true,document_replaced:true}:{ok:true,attempted:true,submitted:true},...options});

test('strict contract: exact HTTPS origin and matching field sets',()=>{
  assert.equal(validateVaultEntry(request()).version,1);
  for(const change of [r=>r.deadline=0,r=>r.destination.origin='https://example.test/path',r=>r.destination.origin='http://example.test',r=>r.fields.extra='secret',r=>delete r.fields.totp,r=>r.destination.fields.totp='#password',r=>r.destination.browser='safari']){const r=request();change(r);assert.throws(()=>validateVaultEntry(r));}
});
test('single-use request IDs survive new gate instances without storing secrets',async()=>{
  const p=++port, options={recording:()=>false,busy:()=>false,reset:()=>{},evaluate:async(_t,e)=>e.includes('values={}')?{ok:true,document_replaced:true}:{ok:true,attempted:true,submitted:true}};
  const r=request(), first=createVaultGate(p,options);
  assert.equal((await first.run(r)).status,'completed');
  assert.equal((await createVaultGate(p,options).run(r)).code,'request_already_used');
  const journal=fs.readFileSync(runtimePath(`vault-requests-${p}.json`),'utf8');assert.ok(!journal.includes(r.fields.password));assert.ok(!journal.includes(r.fields.totp));assert.ok(!journal.includes(r.request_id));
});
test('recording and concurrent actions prevent any entry',async()=>{
  for(const options of [{recording:()=>true},{busy:()=>true}]){let calls=0;const g=gate({...options,evaluate:async()=>{calls++;}});assert.equal((await g.run(request())).code,'capture_or_action_active');assert.equal(calls,0);}
});
test('sensitive gate is held across awaited secret entry including visible TOTP',async()=>{
  let unblock; const hold=new Promise(r=>unblock=r);let first=true;
  const g=gate({evaluate:async()=>{if(first){first=false;await hold;return {ok:true,attempted:true,submitted:true};}return {ok:true,document_replaced:true};}});
  const r=request(), pending=g.run(r);assert.equal(g.blocked(),true);assert.equal(g.suppressed('other-tab'),true);
  const recovery={version:1,destination:{browser:r.destination.browser,tab_id:r.destination.tab_id,origin:r.destination.origin}};
  let checked=false;assert.equal((await g.recover(recovery,'vault-owner',async()=>{checked=true;return true;})).code,'sensitive_phase_active');assert.equal(checked,false);
  unblock();assert.equal((await pending).status,'completed');assert.equal(g.blocked(),false);assert.equal(g.suppressed('ABCDEF1234567890'),true);
});
test('uncertain transport and unverified cleanup leave durable phase block',async()=>{
  const p=++port,options={recording:()=>false,busy:()=>false,reset:()=>{},evaluate:async()=>{throw Error('private-password-123');}};
  const g=createVaultGate(p,options), result=await g.run(request());assert.equal(result.status,'indeterminate');assert.ok(!JSON.stringify(result).includes('private-password'));
  assert.equal(g.blocked(),true);assert.equal(createVaultGate(p,options).blocked(),true);
});
test('cleanup clears all fields without dispatching credential-bearing events',()=>{
  const r=request(); const input={v:'secret'}; class HTMLInputElement {};
  Object.setPrototypeOf(input,HTMLInputElement.prototype);Object.defineProperty(HTMLInputElement.prototype,'value',{get(){return this.v;},set(v){this.v=v;}});
  const context={location:{origin:r.destination.origin},window:{},document:{querySelector:()=>null,querySelectorAll:()=>[input]},HTMLInputElement};context.window.top=context.window;
  assert.equal(vm.runInNewContext(entryExpression(r,true),context).ok,true);assert.equal(input.value,'');
});
test('origin mismatch, frames, ambiguous fields and expired request cannot enter',()=>{
  const r=request();let input=0;
  const context={location:{origin:'https://wrong.test'},window:{},document:{querySelector:()=>null,querySelectorAll:()=>{input++;return [];}},HTMLInputElement:class{}};context.window.top=context.window;
  assert.equal(vm.runInNewContext(entryExpression(r),context).ok,false);assert.equal(input,0);
  context.location.origin=r.destination.origin;context.document.querySelector=()=>({});assert.equal(vm.runInNewContext(entryExpression(r),context).ok,false);assert.equal(input,0);
});

test('stdio adapter rejects malformed and oversized secret-bearing requests without echoes',async()=>{
  const {spawnSync}=await import('node:child_process');
  for(const input of ['{"secret":"private-password-123"}', 'private-password-123'.repeat(3000)]) {
    const child=spawnSync(process.execPath,[new URL('../bin/browserctrl-vault.mjs',import.meta.url).pathname],{input,encoding:'utf8'});
    assert.equal(child.status,0);assert.equal(child.stderr,'');assert.ok(!child.stdout.includes('private-password'));assert.equal(JSON.parse(child.stdout).code,'invalid_request');
  }
});

test('owner recovery requires exact persisted target and trusted proof it is absent',async()=>{
  const p=++port, r=request(), options={recording:()=>false,busy:()=>false,reset:()=>{},evaluate:async()=>{throw Error('uncertain');}};
  const g=createVaultGate(p,options);await g.run(r,()=>{},'owner-one');
  const marker=fs.readFileSync(runtimePath(`vault-sensitive-${p}.json`),'utf8');assert.ok(!marker.includes(r.fields.password));assert.ok(!marker.includes(r.fields.totp));
  const recovery={version:1,destination:{browser:r.destination.browser,tab_id:r.destination.tab_id,origin:r.destination.origin}};
  const restarted=createVaultGate(p,options);
  assert.equal((await restarted.recover(recovery,'other-owner',async()=>true)).code,'recovery_mismatch');
  assert.equal((await restarted.recover({...recovery,destination:{...recovery.destination,tab_id:'DIFFERENT12345'}},'owner-one',async()=>true)).code,'recovery_mismatch');
  assert.equal((await restarted.recover(recovery,'owner-one',async()=>false)).code,'target_still_present');assert.equal(restarted.blocked(),true);
  assert.equal((await restarted.recover(recovery,'owner-one',async()=>{throw Error();})).code,'recovery_unverified');assert.equal(restarted.blocked(),true);
  assert.equal((await restarted.recover(recovery,'owner-one',async()=>true)).code,'closed_target_recovered');assert.equal(restarted.blocked(),false);
  assert.equal(fs.existsSync(runtimePath(`vault-sensitive-${p}.json`)),false);
});


test('empty same-document inputs do not release retained JS credential state',async()=>{
  const g=gate({evaluate:async(_target,_expression,meta)=>meta.cleanup?{ok:true}:{ok:true,attempted:true,submitted:true}});
  const result=await g.run(request());assert.equal(result.code,'cleanup_unverified');assert.equal(g.blocked(),true);
});

import test from 'node:test';
import fs from 'node:fs';
import {runtimePath} from '../lib/env.mjs';
import assert from 'node:assert/strict';
import {validateAuthWorkflow} from '../lib/auth-workflow.mjs';
import {createVaultGate} from '../lib/vault-entry.mjs';

export const workflowPolicy=()=>({login:{fields:{username:'#username',password:'#password'},submit:'#submit'},challenge:{selector:'#email-code',submit:'@auto',resend:{selector:'button',text:'Resend',max_attempts:1,cooldown_seconds:30}},success:{path:'/session',required_keys:['id']},cleanup_path:'/checkpoint',return_path:'/'});
const request=()=>({version:1,request_id:crypto.randomUUID(),workflow_id:'',deadline:Date.now()/1000+115,action:'begin',destination:{browser:'dia',tab_id:'ABCDEF1234567890',origin:'https://example.com'},workflow:workflowPolicy(),fields:{username:'synthetic-user',password:'synthetic-private-password'}});
const begin=()=>{const r=request();r.workflow_id=r.request_id;return r;};
const step=(r,action,fields={})=>({...r,request_id:crypto.randomUUID(),action,fields});
let port=21100;

test('workflow schema fixes origins, operations, selectors and same-origin cleanup',()=>{
  assert.equal(validateAuthWorkflow(begin()).action,'begin');
  for(const change of [r=>r.destination.origin='http://example.com',r=>r.workflow.cleanup_path='//evil.com',r=>r.workflow.cleanup_path='/%2fexample.com',r=>r.workflow.success.path='/\\evil.com',r=>r.workflow.challenge.resend.max_attempts=2,r=>r.workflow.challenge.resend.cooldown_seconds=0,r=>r.workflow.extra='code',r=>r.fields.extra='secret',r=>r.workflow_id='different-workflow-id']){
    const r=begin();change(r);assert.throws(()=>validateAuthWorkflow(r));
  }
});

test('whole workflow keeps the guard through status/code and renews only its matched owner',async()=>{
  const r=begin();let renewed=0,finished=0,called=0;
  const gate=createVaultGate(++port,{recording:()=>false,busy:()=>false,reset:()=>{},evaluate:async(_target,_expression,meta)=>{called++;return meta.workflowAction==='status'?{state:'waiting_for_email',resend_available:true}:{ok:true,attempted:true,submitted:true};},finishTarget:async(target,meta)=>{assert.equal(target,r.destination.tab_id);assert.equal(meta.cleanupPath,'/checkpoint');assert.ok(meta.forbidden.includes(r.fields.password));assert.ok(meta.forbidden.includes('123456'));finished++;return true;}});
  const authorize=renew=>{if(renew)renewed++;};
  assert.equal((await gate.workflow(r,authorize,'owner')).status,'completed');
  assert.equal(gate.blocked(),true);
  const legacy={version:1,request_id:crypto.randomUUID(),deadline:r.deadline,destination:{...r.destination,fields:{totp:'#different'},submit:'@auto'},fields:{totp:'123456'}};
  assert.equal((await gate.continue(legacy,authorize,'owner')).code,'workflow_scope_required');
  const before=called;
  assert.equal((await gate.workflow(step(r,'status'),authorize,'other')).code,'workflow_scope_mismatch');
  assert.equal(called,before);assert.equal(renewed,0);
  assert.equal((await gate.workflow(step(r,'status'),authorize,'owner')).state,'waiting_for_email');
  assert.equal(gate.progress().state,'waiting_for_email');assert.ok(!JSON.stringify(gate.progress()).includes(r.fields.password));
  assert.ok(renewed>0);
  assert.equal((await gate.workflow(step(r,'code',{totp:'123456'}),authorize,'owner')).status,'completed');
  assert.equal((await gate.workflow(step(r,'code',{totp:'123456'}),authorize,'owner')).code,'code_already_attempted');
  assert.equal((await gate.workflow(step(r,'finish'),authorize,'owner')).state,'cleaned');
  assert.equal(finished,1);assert.equal(gate.blocked(),false);
});

test('resend count and cooldown are enforced inside the protected browser gate',async()=>{
  const r=begin();let clock=Date.now()/1000,mutations=0;
  const gate=createVaultGate(++port,{now:()=>clock,recording:()=>false,busy:()=>false,reset:()=>{},evaluate:async()=>{mutations++;return {ok:true,attempted:true,submitted:true};},finishTarget:async()=>true});
  await gate.workflow(r,()=>{},'owner');
  assert.equal((await gate.workflow(step(r,'resend'),()=>{},'owner')).code,'resend_limit');
  assert.equal(mutations,1);clock+=31;
  assert.equal((await gate.workflow(step(r,'resend'),()=>{},'owner')).status,'completed');
  assert.equal(mutations,2);clock+=31;
  assert.equal((await gate.workflow(step(r,'resend'),()=>{},'owner')).code,'resend_limit');
  assert.equal(mutations,2);
  await gate.workflow(step(r,'finish'),()=>{},'owner');
});

test('workflow refuses scope/deadline changes and keeps guard when cleanup fails',async()=>{
  const r=begin();let calls=0;
  const gate=createVaultGate(++port,{recording:()=>false,busy:()=>false,reset:()=>{},evaluate:async()=>{calls++;return {ok:true,attempted:true,submitted:true};},finishTarget:async()=>false});
  await gate.workflow(r,()=>{},'owner');
  for(const change of [v=>v.destination.origin='https://other.com',v=>v.workflow.success.path='/other',v=>v.deadline+=1,v=>v.workflow_id='other-workflow-id']){
    const v=structuredClone(step(r,'status'));change(v);assert.equal((await gate.workflow(v,()=>{},'owner')).code,'workflow_scope_mismatch');
  }
  assert.equal(calls,1);
  assert.equal((await gate.workflow(step(r,'finish'),()=>{},'owner')).code,'cleanup_unverified');assert.equal(gate.blocked(),true);
});


test('unauthorized begin cannot create a global guard',async()=>{
  const gate=createVaultGate(++port,{recording:()=>false,busy:()=>false,reset:()=>{},evaluate:async()=>{throw Error('must not evaluate');}});
  assert.equal((await gate.workflow(begin(),()=>{throw Error('not owner');},'other')).code,'protected_target_not_owned');
  assert.equal(gate.blocked(),false);assert.equal(gate.progress(),null);
});

test('expired workflow refuses entry but permits exact owner-bound cleanup',async()=>{
  const r=begin();let clock=Date.now()/1000;
  const gate=createVaultGate(++port,{now:()=>clock,recording:()=>false,busy:()=>false,reset:()=>{},evaluate:async()=>({ok:true,attempted:true,submitted:true}),finishTarget:async()=>true});
  await gate.workflow(r,()=>{},'owner');clock=r.deadline+1;
  assert.equal((await gate.workflow(step(r,'code',{totp:'123456'}),()=>{},'owner')).code,'invalid_workflow_request');
  assert.equal((await gate.workflow(step(r,'resend'),()=>{},'owner')).code,'invalid_workflow_request');
  assert.equal((await gate.workflow(step(r,'finish'),()=>{},'other')).code,'workflow_scope_mismatch');
  assert.equal((await gate.workflow(step(r,'finish'),()=>{},'owner')).state,'cleaned');assert.equal(gate.blocked(),false);
});


test('journal capacity cannot prevent owner-bound cleanup',async()=>{
  const r=begin(),p=++port;
  const gate=createVaultGate(p,{recording:()=>false,busy:()=>false,reset:()=>{},evaluate:async()=>({ok:true,attempted:true,submitted:true}),finishTarget:async()=>true});
  await gate.workflow(r,()=>{},'owner');
  const journal=runtimePath(`vault-requests-${p}.json`);
  fs.writeFileSync(journal,JSON.stringify(Object.fromEntries(Array.from({length:10000},(_,i)=>[String(i),true]))));
  assert.equal((await gate.workflow(step(r,'code',{totp:'123456'}),()=>{},'owner')).code,'journal_full');
  assert.equal((await gate.workflow(step(r,'finish'),()=>{},'other')).code,'workflow_scope_mismatch');
  assert.equal((await gate.workflow(step(r,'finish'),()=>{},'owner')).state,'cleaned');
  assert.equal(gate.blocked(),false);
  assert.equal((await gate.workflow(step(r,'finish'),()=>{},'owner')).code,'workflow_context_lost');
});

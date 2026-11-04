import './isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {validateReference,validateTransferCapture,validateTransferFill,validTransferFields,submitVaultTransfer} from '../lib/vault-transfer.mjs';
import {safeTransferReceipt,parseTransferRead,normalizeTransfer,inputTypes} from '../lib/vault-transfer-profiles.mjs';
const spec = (selector='#token',format='token') => ({selector,format,min_length:1,max_length:1024,prefix:''});
const ref = () => ({profile:'fields',source:{browser:'dia',origin:'https://source.example',tab_owner:'transfer-test',guards:[{selector:'#account',text:'Test account'}],fields:{token:spec()}}});
const capture = () => ({version:6,request_id:crypto.randomUUID(),deadline:Date.now()/1000+60,reference:ref()});
const fill = () => ({version:7,request_id:crypto.randomUUID(),deadline:Date.now()/1000+60,reference:ref(),destination:{browser:'dia',origin:'https://dest.example',tab_owner:'transfer-test',tab_id:'ABCDEF1234567890',fields:{token:{selector:'#token',frames:[],input_type:'password'}}},fields:{token:'SYNTHETIC_token'}});
test('generic shapes are exact, HTTPS, bounded, and name/type consistent',()=>{
  assert.equal(validateTransferCapture(capture()).version,6);assert.equal(validateTransferFill(fill()).version,7);
  for(const change of [r=>r.extra=1,r=>r.deadline=0,r=>r.reference.profile='unknown',r=>r.reference.extra=1,r=>r.reference.source.fields={},r=>r.reference.source.fields['0bad']=spec(),r=>r.reference.source.fields.token.min_length=0,r=>r.reference.source.fields.token.max_length=1025,r=>r.reference.source.fields.token.prefix='x'.repeat(33),r=>r.reference.source.guards=[],r=>r.reference.source.origin='http://source.example',r=>r.reference.source.fields.token.frames=[]]){const r=capture();change(r);assert.throws(()=>validateTransferCapture(r));}
  for(const change of [r=>r.destination.browser='chrome',r=>r.destination.tab_owner='other',r=>r.destination.fields.other=r.destination.fields.token,r=>r.destination.fields.token.input_type='email',r=>r.destination.fields.token.frames=[{selector:'iframe',origin:'http://frame.example'}],r=>r.destination.fields.token.frames=Array.from({length:4},()=>({selector:'iframe',origin:'https://frame.example'})),r=>r.fields.other='extra']){const r=fill();change(r);assert.throws(()=>validateTransferFill(r));}
  const inherited=ref();inherited.source.fields={constructor:spec('#constructor')};assert.equal(validateReference(inherited),inherited);
});
test('formats use codepoints, literal prefixes, and aggregate serialized UTF8 byte limits',()=>{
  const r=ref();r.source.fields.token=spec('#token','text');r.source.fields.token.min_length=2;r.source.fields.token.max_length=2;
  assert.ok(validTransferFields({token:'😀a'},r));assert.ok(!validTransferFields({token:'😀'},r));
  for(const v of ['a\n','a\u0000','a\u007f']) assert.ok(!validTransferFields({token:v},r));
  r.source.fields.token=spec();assert.ok(validTransferFields({token:'a~!'},r));assert.ok(!validTransferFields({token:'a b'},r));assert.ok(!validTransferFields({token:'é'},r));
  r.source.fields.token=spec('#token','digits');assert.ok(validTransferFields({token:'0123'},r));assert.ok(!validTransferFields({token:'１２３'},r));
  r.source.fields.token.prefix='12';assert.ok(!validTransferFields({token:'0123'},r));assert.ok(validTransferFields({token:'1234'},r));
  const big=ref();big.source.fields=Object.fromEntries(Array.from({length:8},(_,i)=>['f'+i,spec('#f'+i,'text')]));
  assert.ok(!validTransferFields(Object.fromEntries(Object.keys(big.source.fields).map(k=>[k,'😀'.repeat(200)])),big));
  assert.ok(validTransferFields(Object.fromEntries(Object.keys(big.source.fields).map(k=>[k,'a'.repeat(700)])),big));
});
test('generic readback is exact and card profile retains normalization',()=>{
  const r=ref();assert.deepEqual(parseTransferRead({token:'a~!'},r),{token:'a~!'});assert.equal(parseTransferRead({token:'bad token'},r),null);
  assert.equal(normalizeTransfer(r,'token',' a - b '),' a - b ');assert.deepEqual(inputTypes(r,fill().destination,'token'),['password']);
  assert.equal(normalizeTransfer({profile:'payment-card'},'number','4242-4242 4242 4242'),'4242424242424242');
});
test('private fixed receipts reject arbitrary echoed error text and extra fields',()=>{
  const ok={status:'completed',verification:'filled',input_attempted:true,action_may_have_run:false};assert.ok(safeTransferReceipt(ok));assert.ok(!safeTransferReceipt({...ok,extra:'secret'}));
  const failed={status:'failed',verification:'not_verified',input_attempted:false,action_may_have_run:false,code:'source_changed'};assert.ok(safeTransferReceipt(failed));assert.ok(!safeTransferReceipt({...failed,code:'synthetic_secret_token'}));assert.ok(!safeTransferReceipt({...failed,input_attempted:true}));
});
test('invalid transfer request is rejected before private transport',async()=>{assert.equal((await submitVaultTransfer({...capture(),extra:'secret'})).code,'invalid_request');});
test('card compatibility and v6/v7 share one private capture correlation',async()=>{
  const {createTransferGate}=await import('../lib/vault-transfer.mjs');
  const owner='transfer-test',targetId='SOURCE1234567890',card={number:'4242424242424242',expiry:'12/30',cvc:'123'},source={browser:'dia',origin:'https://source.example',tab_owner:owner,element:'#card',last4:'4242',expires:'2030-12',guards:[{selector:'#account',text:'Test account'}]};
  let tainted=false;
  const fillGate={tainted:()=>tainted,hasOrphan:()=>false,card:{created:()=>true,owner:()=>owner,secrets:()=>[],useRequestId:()=>null,taint:()=>{tainted=true;}}};
  const send=async method=>{
    if(method==='Target.getTargets')return {targetInfos:[{type:'page',targetId,url:source.origin+'/source'}]};
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id:targetId,loaderId:'loader',url:source.origin+'/source'}}};
    if(method==='Page.createIsolatedWorld')return {executionContextId:1};
    if(method==='Runtime.evaluate')return {result:{subtype:'node',objectId:'root'}};
    if(method==='Runtime.callFunctionOn')return {result:{value:{ok:true,values:{card:'4242 4242 4242 4242 Expires 12/30 CVC 123'}}}};
    if(method==='Runtime.releaseObject')return {};
    throw Error('unexpected synthetic method');
  };
  const gate=createTransferGate({fillGate,send,sessionFor:async()=> 'S',withInput:async(_id,_sid,fn)=>fn(),recording:()=>false});
  const hooks={claimOf:()=>owner,authorize:()=>null};
  const captured=await gate.captureCard({version:4,request_id:crypto.randomUUID(),deadline:Date.now()/1000+60,source},owner,hooks);assert.equal(captured.status,'completed');
  const destination={browser:'dia',origin:'https://dest.example',tab_owner:owner,tab_id:'MISSING1234567890',fields:Object.fromEntries(['number','expiry','cvc'].map(k=>[k,{selector:'#'+k,frames:[]}]))};
  const result=await gate.fill({version:7,request_id:crypto.randomUUID(),deadline:Date.now()/1000+60,reference:{profile:'payment-card',source},destination,fields:card},owner,hooks);
  assert.equal(result.code,'tab_not_found','v7 recognized the v4 capture before checking destination');
  const oldFill=await gate.fillCard({version:5,request_id:crypto.randomUUID(),deadline:Date.now()/1000+60,destination,fields:card},owner,hooks);assert.equal(oldFill.code,'tab_not_found');
});
test('private transport refuses an error code copied from a generic value',async t=>{
  const net=await import('node:net');const {SOCK}=await import('../lib/env.mjs');const port=21673;
  const server=net.createServer(socket=>socket.once('data',()=>socket.end(JSON.stringify({reqId:1,result:{status:'failed',verification:'not_verified',input_attempted:false,action_may_have_run:false,code:'synthetic_secret_token'}})+'\n')));
  await new Promise(resolve=>server.listen(SOCK(port),resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const request=fill();request.fields.token='synthetic_secret_token';const result=await submitVaultTransfer(request,{port,trusted:async()=>true});assert.equal(result.code,'adapter_response_invalid');assert.ok(!JSON.stringify(result).includes(request.fields.token));
});
const vaultReference=()=>({profile:'fields',source:{kind:'vault',refs:{token:'vault://synthetic-test/item/11111111-2222-3333-4444-555555555555#password'},fields:{token:{format:'token',min_length:1,max_length:128,prefix:''}}}});
test('vault-source references validate for v7 while v6 refuses them before connecting',async()=>{
  const reference=vaultReference();assert.equal(validateReference(reference),reference);
  const request=fill();request.reference=reference;assert.equal(validateTransferFill(request).version,7);
  let connected=false;const result=await submitVaultTransfer({...capture(),reference},{trusted:async()=>{connected=true;return true;}});assert.equal(result.code,'invalid_request');assert.equal(connected,false);
  for(const invalid of ['vault://-account/item/11111111-2222-3333-4444-555555555555#password','vault://synthetic/item/AAAAAAAA-2222-3333-4444-555555555555#password','vault://synthetic/item/11111111-2222-3333-4444-555555555555#card','https://synthetic/item/11111111-2222-3333-4444-555555555555#password','vault://synthetic/item/11111111-2222-3333-4444-555555555555#password?extra=1']){const r=vaultReference();r.source.refs.token=invalid;assert.throws(()=>validateReference(r));}
  for(const change of [r=>r.source.refs.other=r.source.refs.token,r=>r.source.browser='dia',r=>r.source.fields.token.selector='#token',r=>r.source.fields.token.max_length=1025]){const r=vaultReference();change(r);assert.throws(()=>validateReference(r));}
  for(const field of ['username','password','totp','notes']){const r=vaultReference();r.source.refs.token=r.source.refs.token.replace(/#.*$/,'#'+field);assert.equal(validateReference(r),r);}
});
const providerReference=()=>({profile:'fields',source:{kind:'provider',id:'a'.repeat(64),fields:{token:{format:'token',min_length:1,max_length:128,prefix:''}}}});
test('provider snapshots validate independently of browser source and v6 rejects them',async()=>{
  const reference=providerReference();assert.equal(validateReference(reference),reference);const request=fill();request.reference=reference;assert.equal(validateTransferFill(request).version,7);
  let connected=false;const result=await submitVaultTransfer({...capture(),reference},{trusted:async()=>{connected=true;return true;}});assert.equal(result.code,'invalid_request');assert.equal(connected,false);
  for(const change of [r=>r.source.id='a'.repeat(63),r=>r.source.id='A'.repeat(64),r=>r.source.id='g'.repeat(64),r=>r.source.browser='dia',r=>r.source.fields.token.selector='#token',r=>r.source.fields.token.min_length=0]){const r=providerReference();change(r);assert.throws(()=>validateReference(r));}
  const card={profile:'payment-card',source:{kind:'provider',id:'b'.repeat(64),last4:'4242',expires:'2030-12'}};assert.equal(validateReference(card),card);
  const cardFill={...fill(),reference:card,destination:{...fill().destination,fields:Object.fromEntries(['number','expiry','cvc'].map(k=>[k,{selector:'#'+k,frames:[]}]))},fields:{number:'4242424242424242',expiry:'12/30',cvc:'123'}};assert.equal(validateTransferFill(cardFill).version,7);
  for(const change of [r=>r.fields.number='4242424242424241',r=>r.reference.source.last4='0000',r=>r.reference.source.expires='2031-12',r=>r.reference.source.expires='2020-01',r=>r.reference.source.fields={}]){const r=structuredClone(cardFill);change(r);assert.throws(()=>validateTransferFill(r));}
  assert.equal((await submitVaultTransfer({...capture(),reference:card})).code,'invalid_request');
});

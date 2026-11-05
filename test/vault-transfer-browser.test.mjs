// Synthetic loopback HTTPS + a throwaway Chromium profile only.
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {runtimePath} from '../lib/env.mjs';
import {connect} from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import {submitVaultTransfer} from '../lib/vault-transfer.mjs';
import {chromeBinary,startHeadlessBrowser,TEST_PORT} from './helpers.mjs';
const OWNER='transfer-browser-test', TOKEN='SYNTHETIC_token_a4Yp8', LOGIN={username:'synthetic@example.invalid',password:'SYNTHETIC-password-!9'};
const sourceSpec=(selector,format='text')=>({selector,format,min_length:1,max_length:128,prefix:''});
test('generic protected transfer uses exact fields, shared safety gate and real OOPIF input', {skip:!chromeBinary(),timeout:180000},async t=>{
  const dir=fs.mkdtempSync(path.join((process.platform === 'win32' ? os.tmpdir() : '/tmp'), 'bc-transfer-tls-'));execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(dir,'key'),'-out',path.join(dir,'cert'),'-subj','/CN=localhost','-days','1'],{stdio:'ignore'});
  let origin,destOrigin,submitted=null;
  const server=https.createServer({key:fs.readFileSync(path.join(dir,'key')),cert:fs.readFileSync(path.join(dir,'cert'))},(q,r)=>{
    r.setHeader('content-type','text/html');r.setHeader('cache-control','no-store');const u=new URL(q.url,'https://fixture.invalid'),mode=u.searchParams.get('mode')||'token';
    if(u.pathname==='/submit'){let body='';q.on('data',c=>body+=c);q.on('end',()=>{submitted=JSON.parse(body);r.end('received');});return;}
    if(u.pathname==='/source')return r.end(`<p id="account">Fixture account</p><input id="token" readonly value="${TOKEN}"><span id="username">${u.searchParams.has('short')?'e':LOGIN.username}</span><input id="password" readonly value="${LOGIN.password}">`);
    if(u.pathname==='/outer')return r.end(`<iframe id="innerframe" src="${destOrigin}/field?mode=token"></iframe><script>addEventListener('message',e=>{if(e.data==='collect')document.querySelector('iframe').contentWindow.postMessage('collect','*');else if(e.data&&e.data.field)parent.postMessage(e.data,'*')})</script>`);
    if(u.pathname==='/field'&&mode==='card')return r.end(`<input id="number" type="tel"><input id="expiry" type="text"><input id="cvc" type="password"><script>document.querySelector('#number').oninput=e=>{const n=e.target.value.replace(/[^0-9]/g,'');e.target.value=(n.match(/.{1,4}/g)||[]).join(' ')};addEventListener('message',e=>{if(e.data==='collect')parent.postMessage({fields:{number:document.querySelector('#number').value.replace(/[^0-9]/g,''),expiry:document.querySelector('#expiry').value,cvc:document.querySelector('#cvc').value}},'*')})</script>`);
    if(u.pathname==='/field')return r.end(`<input id="${mode==='login'?'password':'token'}" type="${mode==='login'?'password':'text'}" value="old value"><script>addEventListener('message',e=>{if(e.data==='collect')parent.postMessage({field:'${mode==='login'?'password':'token'}',value:document.querySelector('input').value},'*')})</script>`);
    if(u.pathname==='/destination')return r.end(`<form>${mode==='login'?'<input id="username" type="text" value="replace existing">':''}<iframe id="secretframe" src="${origin}${mode==='nested'?'/outer':'/field?mode='+mode}"></iframe><button id="submit">Submit synthetic fixture</button></form><script>const fields={};document.querySelector('form').onsubmit=e=>{e.preventDefault();const n=document.querySelector('#username');if(n)fields.username=n.value;document.querySelector('iframe').contentWindow.postMessage('collect','*')};addEventListener('message',e=>{if(e.data&&(e.data.field||e.data.fields)){if(e.data.fields)Object.assign(fields,e.data.fields);else fields[e.data.field]=e.data.value;fetch('/submit',{method:'POST',body:JSON.stringify(fields)})}});${u.searchParams.has('partial')?"document.querySelector('#username').oninput=()=>document.querySelector('iframe').remove()":''}</script>`);
    r.end('<p>Clean fixture</p>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`https://127.0.0.1:${server.address().port}`;destOrigin=`https://localhost:${server.address().port}`;
  process.env.BROWSERCTRL_CAPTURE='0';process.env.BROWSERCTRL_AGENT_ID=OWNER;
  const browser=await startHeadlessBrowser(TEST_PORT);let raw,conn;
  t.after(async()=>{try{await raw?.stop();}catch{}raw?.close();conn?.close();await browser.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});delete process.env.BROWSERCTRL_AGENT_ID;});
  raw=await connect(TEST_PORT);conn=await connect(TEST_PORT,{mediated:true});await raw.browser('Security.setIgnoreCertificateErrors',{ignore:true});
  const wait=async(id,expression)=>{for(let i=0;i<100;i++){if(await ops.evaluate(conn,id,expression).catch(()=>false))return;await new Promise(resolve=>setTimeout(resolve,30));}throw Error('synthetic fixture did not load');};
  const tab=async(url,destination=false)=>{const {targetId}=await raw.browser('Target.createTarget',{url:(destination?destOrigin:origin)+url});await wait(targetId,"document.readyState==='complete'");return targetId;};
  const close=async id=>raw.browser('Target.closeTarget',{targetId:id});
  const reference=mode=>({profile:'fields',source:{browser:'dia',origin,tab_owner:OWNER,guards:[{selector:'#account',text:'Fixture account'}],fields:mode==='login'?{username:sourceSpec('#username'),password:sourceSpec('#password','token')}:{token:sourceSpec('#token','token')}}});
  const destination=mode=>({browser:'dia',origin:destOrigin,tab_owner:OWNER,fields:mode==='login'?{username:{selector:'#username',frames:[],input_type:'text'},password:{selector:'#password',frames:[{selector:'#secretframe',origin}],input_type:'password'}}:{token:{selector:'#token',frames:[{selector:'#secretframe',origin}],input_type:'text'}}});
  const capture=(ref,extra={})=>submitVaultTransfer({version:6,request_id:crypto.randomUUID(),deadline:Date.now()/1000+60,reference:ref,...extra},{port:TEST_PORT});
  const fillRequest=(ref,dest,id,fields)=>({version:7,request_id:crypto.randomUUID(),deadline:Date.now()/1000+60,reference:ref,destination:{...dest,tab_id:id},fields});
  const fill=request=>submitVaultTransfer(request,{port:TEST_PORT});
  const submit=async(id,fields)=>{submitted=null;await conn.send(id,'Runtime.evaluate',{expression:"document.querySelector('form').requestSubmit()",returnByValue:true});for(let i=0;i<100&&!submitted;i++)await new Promise(resolve=>setTimeout(resolve,30));assert.deepEqual(submitted,fields);};
  await t.test('API token capture + OOPIF fill redacts ordinary reads and never submits',async()=>{
    submitted=null;const src=await tab('/source'),dst=await tab('/destination',true),ref=reference('token'),dest=destination('token');
    try{
      const {targetInfos}=await raw.browser('Target.getTargets',{});const frame=targetInfos.find(x=>x.type==='iframe'&&x.url===origin+'/field?mode=token');assert.ok(frame,'fixture field is a real OOPIF');
      assert.deepEqual(await capture(ref),{status:'completed',verification:'captured',fields:{token:TOKEN}});
      const request=fillRequest(ref,dest,dst,{token:TOKEN});assert.deepEqual(await fill(request),{status:'completed',verification:'filled',input_attempted:true,action_may_have_run:false});
      assert.equal(submitted,null);assert.equal((await fill(request)).code,'request_already_used');
      const html=await ops.html(conn,src);assert.ok(!html.includes(TOKEN)&&html.includes('[redacted]'));
      for(const id of [src,dst,frame.targetId]){await assert.rejects(conn.send(id,'Page.captureScreenshot',{}),/tab_tainted/);await assert.rejects(ops.evaluate(conn,id,'1',{caller:true}),/tab_tainted/);}
      assert.equal(await ops.evaluate(conn,frame.targetId,"document.querySelector('input').value"),'[redacted]');
      await submit(dst,{token:TOKEN});
    }finally{await close(src);await close(dst);}
  });
  await t.test('nested OOPIF targets keep their own approved origin and document metadata',async()=>{
    submitted=null;const src=await tab('/source'),dst=await tab('/destination?mode=nested',true),ref=reference('token'),dest=destination('token');
    dest.fields.token.frames.push({selector:'#innerframe',origin:destOrigin});
    try{
      const {targetInfos}=await raw.browser('Target.getTargets',{}),outer=targetInfos.find(x=>x.type==='iframe'&&x.url===origin+'/outer'),inner=targetInfos.find(x=>x.type==='iframe'&&x.url===destOrigin+'/field?mode=token');assert.ok(outer,'outer fixture is an OOPIF');assert.ok(inner,'inner fixture is an OOPIF');
      assert.equal((await capture(ref)).status,'completed');assert.equal((await fill(fillRequest(ref,dest,dst,{token:TOKEN}))).status,'completed');assert.equal(submitted,null);
      const marker=JSON.parse(fs.readFileSync(runtimePath(`vault-taint-${TEST_PORT}.json`),'utf8'));
      assert.deepEqual(marker.tabs[outer.targetId].origins,[origin]);assert.deepEqual(marker.tabs[inner.targetId].origins,[destOrigin]);
      for(const id of [outer.targetId,inner.targetId]){await assert.rejects(conn.send(id,'Page.captureScreenshot',{}),/tab_tainted/);await assert.rejects(ops.evaluate(conn,id,'1',{caller:true}),/tab_tainted/);}
      await submit(dst,{token:TOKEN});
    }finally{await close(src);await close(dst);}
  });
  await t.test('trusted provider field snapshot fills OOPIF without a browser source',async()=>{
    submitted=null;const dst=await tab('/destination?mode=login',true),ref={profile:'fields',source:{kind:'provider',id:'c'.repeat(64),fields:{username:{format:'text',min_length:1,max_length:128,prefix:''},password:{format:'token',min_length:1,max_length:128,prefix:''}}}};
    try{
      const {targetInfos}=await raw.browser('Target.getTargets',{});assert.ok(!targetInfos.some(x=>x.type==='page'&&x.url.startsWith(origin+'/source')));
      const malformed=structuredClone(ref);malformed.source.id='not-a-sha256';const rejected=await fill(fillRequest(malformed,destination('login'),dst,LOGIN));assert.equal(rejected.code,'invalid_request');assert.equal(rejected.input_attempted,false);
      const request=fillRequest(ref,destination('login'),dst,LOGIN);assert.equal((await fill(request)).status,'completed');assert.equal(submitted,null);assert.equal((await fill(request)).code,'request_already_used');await submit(dst,LOGIN);
    }finally{await close(dst);}
  });
  await t.test('trusted provider card snapshot preserves checks, normalization and OOPIF protection',async()=>{
    submitted=null;const dst=await tab('/destination?mode=card',true),ref={profile:'payment-card',source:{kind:'provider',id:'d'.repeat(64),last4:'4242',expires:'2030-12'}},fields={number:'4242424242424242',expiry:'12/30',cvc:'123'},dest={browser:'dia',origin:destOrigin,tab_owner:OWNER,fields:Object.fromEntries(['number','expiry','cvc'].map(name=>[name,{selector:'#'+name,frames:[{selector:'#secretframe',origin}]}]))};
    try{
      const {targetInfos}=await raw.browser('Target.getTargets',{});assert.ok(!targetInfos.some(x=>x.type==='page'&&x.url.startsWith(origin+'/source')));const frame=targetInfos.find(x=>x.type==='iframe'&&x.url===origin+'/field?mode=card');assert.ok(frame);
      for(const change of [r=>r.reference.source.id='D'.repeat(64),r=>r.reference.source.last4='0000',r=>r.fields.number='4242424242424241',r=>r.fields.expiry='11/30']){const wrong=fillRequest(structuredClone(ref),dest,dst,{...fields});change(wrong);const result=await fill(wrong);assert.equal(result.code,'invalid_request');assert.equal(result.input_attempted,false);}
      assert.equal((await fill(fillRequest(ref,dest,dst,fields))).status,'completed');assert.equal(submitted,null);
      assert.equal(await ops.evaluate(conn,frame.targetId,"document.querySelector('#number').value"),'[redacted]');
      for(const id of [dst,frame.targetId]){await assert.rejects(conn.send(id,'Page.captureScreenshot',{}),/tab_tainted/);await assert.rejects(ops.evaluate(conn,id,'1',{caller:true}),/tab_tainted/);}
      await submit(dst,fields);
    }finally{await close(dst);}
  });
  await t.test('approved vault-source fields fill a real OOPIF without a source page',async()=>{
    submitted=null;const dst=await tab('/destination?mode=login',true),ref={profile:'fields',source:{kind:'vault',refs:{username:'vault://synthetic-test/item/11111111-2222-3333-4444-555555555555#username',password:'vault://synthetic-test/item/11111111-2222-3333-4444-555555555555#password'},fields:{username:{format:'text',min_length:1,max_length:128,prefix:''},password:{format:'token',min_length:1,max_length:128,prefix:''}}}};
    try{
      const {targetInfos}=await raw.browser('Target.getTargets',{});assert.ok(!targetInfos.some(x=>x.type==='page'&&x.url.startsWith(origin+'/source')));
      const malformed=structuredClone(ref);malformed.source.refs.password='vault://synthetic-test/item/not-a-uuid#password';assert.equal((await fill(fillRequest(malformed,destination('login'),dst,LOGIN))).code,'invalid_request');
      const request=fillRequest(ref,destination('login'),dst,LOGIN);const result=await fill(request);assert.deepEqual(result,{status:'completed',verification:'filled',input_attempted:true,action_may_have_run:false});assert.equal(submitted,null);assert.equal((await fill(request)).code,'request_already_used');
      const frame=targetInfos.find(x=>x.type==='iframe'&&x.url===origin+'/field?mode=login');assert.ok(frame);
      for(const id of [dst,frame.targetId]){await assert.rejects(conn.send(id,'Page.captureScreenshot',{}),/tab_tainted/);await assert.rejects(ops.evaluate(conn,id,'1',{caller:true}),/tab_tainted/);}
      await submit(dst,LOGIN);
    }finally{await close(dst);}
  });
  await t.test('two approved fields are captured together and typed into exact input kinds',async()=>{
    submitted=null;const src=await tab('/source'),dst=await tab('/destination?mode=login',true),ref=reference('login');
    try{
      assert.deepEqual(await capture(ref),{status:'completed',verification:'captured',fields:LOGIN});
      const wrong=fillRequest(ref,destination('login'),dst,LOGIN);wrong.destination.fields.password.input_type='text';const rejected=await fill(wrong);assert.equal(rejected.code,'element_kind_mismatch');assert.equal(rejected.input_attempted,false);
      assert.equal((await fill(fillRequest(ref,destination('login'),dst,LOGIN))).status,'completed');assert.equal(submitted,null);
      const html=await ops.html(conn,src);assert.ok(!html.includes(LOGIN.username)&&!html.includes(LOGIN.password));
      await submit(dst,LOGIN);
    }finally{await close(src);await close(dst);}
  });
  await t.test('reference, account, origin, frame, replay and source drift fail closed',async()=>{
    const src=await tab('/source'),dst=await tab('/destination',true),ref=reference('token'),dest=destination('token');
    try{
      const account=structuredClone(ref);account.source.guards[0].text='Another account';assert.equal((await capture(account)).code,'guard_mismatch');
      const expired=await capture(ref,{deadline:Date.now()/1000-1});assert.equal(expired.code,'invalid_request');
      const repeated=crypto.randomUUID();assert.equal((await capture(ref,{request_id:repeated})).status,'completed');assert.equal((await capture(ref,{request_id:repeated})).code,'request_already_used');
      const changedRef=structuredClone(ref);changedRef.source.guards[0].text='Another account';assert.equal((await fill(fillRequest(changedRef,dest,dst,{token:TOKEN}))).code,'source_unavailable');
      const changedSource=structuredClone(ref);changedSource.source.fields.token.selector='input';assert.equal((await fill(fillRequest(changedSource,dest,dst,{token:TOKEN}))).code,'source_unavailable');
      const wrong=fillRequest(ref,dest,dst,{token:TOKEN});wrong.destination.origin='https://wrong.example';const wrongResult=await fill(wrong);assert.equal(wrongResult.code,'origin_mismatch');assert.equal(wrongResult.input_attempted,false);
      const frame=fillRequest(ref,dest,dst,{token:TOKEN});frame.destination.fields.token.frames[0].origin=destOrigin;assert.equal((await fill(frame)).input_attempted,false);
      const absent=fillRequest(ref,dest,dst,{token:TOKEN});absent.destination.fields.token.frames[0].selector='#unrelated';assert.equal((await fill(absent)).input_attempted,false);
      await conn.send(src,'Runtime.evaluate',{expression:"document.querySelector('#account').textContent='Changed account'",returnByValue:true});assert.equal((await fill(fillRequest(ref,dest,dst,{token:TOKEN}))).code,'source_changed');
      await conn.send(src,'Runtime.evaluate',{expression:"document.querySelector('#account').textContent='Fixture account';document.querySelector('#token').value='CHANGED_TOKEN'",returnByValue:true});assert.equal((await fill(fillRequest(ref,dest,dst,{token:TOKEN}))).code,'source_changed');
    }finally{await close(src);await close(dst);}
  });
  await t.test('a mid-fill frame removal is indeterminate and never retried',async()=>{
    const src=await tab('/source'),dst=await tab('/destination?mode=login&partial=1',true),ref=reference('login');
    try{assert.equal((await capture(ref)).status,'completed');const request=fillRequest(ref,destination('login'),dst,LOGIN),result=await fill(request);assert.equal(result.status,'indeterminate');assert.equal(result.input_attempted,true);assert.equal(result.action_may_have_run,false);assert.equal((await fill(request)).code,'request_already_used');}finally{await close(src);await close(dst);}
  });
  await t.test('real Python generic broker provider and executor', {skip:!process.env.BROWSERCTRL_TRANSFER_INTEGRATION_SCRIPT},async()=>{
    const src=await tab('/source'),dst=await tab('/destination?mode=login',true),ref=reference('login'),dest=destination('login');submitted=null;
    try{
      const env={...process.env,BROWSERCTRL_TRANSFER_SOURCE_PLAN:JSON.stringify(ref.source),BROWSERCTRL_TRANSFER_DEST_PLAN:JSON.stringify(dest),BROWSERCTRL_TRANSFER_REFERENCE:JSON.stringify(ref),BROWSERCTRL_TRANSFER_DRIVER:path.resolve('bin/browserctrl-vault.mjs'),BROWSERCTRL_TRANSFER_NODE:process.execPath,BROWSERCTRL_TRANSFER_SOURCE_TAB:src,BROWSERCTRL_TRANSFER_DEST_TAB:dst,BROWSERCTRL_TRANSFER_OWNER:OWNER,BROWSERCTRL_VAULT_TEST_PORT:String(TEST_PORT)};
      const result=await promisify(execFile)(process.env.BROWSERCTRL_TRANSFER_INTEGRATION_PYTHON||'python3',[process.env.BROWSERCTRL_TRANSFER_INTEGRATION_SCRIPT],{env,timeout:60000,maxBuffer:65536});const receipt=JSON.parse(result.stdout.trim());assert.equal(receipt.status,'completed',JSON.stringify(receipt));assert.equal(receipt.verification,'filled');assert.equal(submitted,null);await submit(dst,LOGIN);
    }finally{await close(src);await close(dst);}
  });
  await t.test('one-character secrets do not corrupt fixed private fill receipts',async()=>{
    const src=await tab('/source?short=1'),dst=await tab('/destination?mode=login',true),ref=reference('login'),values={...LOGIN,username:'e'};
    try{assert.equal((await capture(ref)).status,'completed');const result=await fill(fillRequest(ref,destination('login'),dst,values));assert.deepEqual(result,{status:'completed',verification:'filled',input_attempted:true,action_may_have_run:false});await submit(dst,values);}finally{await close(src);await close(dst);}
  });
});

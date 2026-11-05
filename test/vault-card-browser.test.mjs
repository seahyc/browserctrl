import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {execFile,execFileSync} from 'node:child_process';
import {connect} from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import {submitVaultFill} from '../lib/vault-fill.mjs';
import {submitVaultCard} from '../lib/vault-card.mjs';
import {chromeBinary,startHeadlessBrowser,TEST_PORT} from './helpers.mjs';
const OWNER='card-browser-test', F={number:'4242424242424242',expiry:'12/30',cvc:'123'};
test('private card capture and fill in isolated HTTPS Chromium including OOPIF', {skip:!chromeBinary(),timeout:180000},async t=>{
  const dir=fs.mkdtempSync(path.join((process.platform === 'win32' ? os.tmpdir() : '/tmp'), 'bc-card-tls-'));
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(dir,'key'),' -out'.trim(),path.join(dir,'cert'),'-subj','/CN=localhost','-days','1'],{stdio:'ignore'});
  let origin,remote,submitted=null;
  const server=https.createServer({key:fs.readFileSync(path.join(dir,'key')),cert:fs.readFileSync(path.join(dir,'cert'))},(q,r)=>{
    r.setHeader('content-type','text/html');r.setHeader('cache-control','no-store');const u=new URL(q.url,'https://fixture.test');
    if(u.pathname==='/submitted'){let b='';q.on('data',c=>b+=c);q.on('end',()=>{submitted=JSON.parse(b);r.end('submitted');});return;}
    if(u.pathname==='/source')return r.end(`<div id="guard">Owner test</div><input id="auth" type="password"><pre id="card">Card ${u.searchParams.has('bad')?'4242 4242 4242 4241':'4242 4242 4242 4242'}\nExpires 12/30\nCVC 123</pre>`);
    if(u.pathname==='/field')return r.end(`<input id="${u.searchParams.get('field')}" type="tel"><script>addEventListener('message',e=>{if(e.data==='collect')parent.postMessage({field:'${u.searchParams.get('field')}',value:document.querySelector('input').value},'*')})</script>`);
    if(u.pathname==='/checkout')return r.end(`<form><input id="number" type="tel"><iframe id="expiryframe" src="${remote}/field?field=expiry"></iframe><iframe id="cvcframe" src="${origin}/field?field=cvc"></iframe><button id="submit">Submit synthetic fixture</button></form><script>const out={};addEventListener('message',e=>{if(e.data&&e.data.field){out[e.data.field]=e.data.value;if(out.expiry&&out.cvc)fetch('/submitted',{method:'POST',body:JSON.stringify(out)})}});document.querySelector('form').onsubmit=e=>{e.preventDefault();out.number=document.querySelector('#number').value;for(const f of document.querySelectorAll('iframe'))f.contentWindow.postMessage('collect','*')};${u.searchParams.has('partial')?"document.querySelector('#number').oninput=()=>document.querySelector('#expiryframe').remove()":''}</script>`);
    return r.end('<p>Clean page</p>');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  origin=`https://127.0.0.1:${server.address().port}`;remote=`https://localhost:${server.address().port}`;
  process.env.BROWSERCTRL_CAPTURE='0';process.env.BROWSERCTRL_AGENT_ID=OWNER;
  const browser=await startHeadlessBrowser(TEST_PORT);let raw,conn;
  t.after(async()=>{try{await raw?.stop();}catch{}raw?.close();conn?.close();await browser.close();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});delete process.env.BROWSERCTRL_AGENT_ID;});
  raw=await connect(TEST_PORT);conn=await connect(TEST_PORT,{mediated:true});await raw.browser('Security.setIgnoreCertificateErrors',{ignore:true});
  const wait=async(id,expr,want=true)=>{for(let i=0;i<100;i++){if(await ops.evaluate(conn,id,expr).catch(()=>null)===want)return;await new Promise(r=>setTimeout(r,50));}throw Error('fixture did not load');};
  const tab=async url=>{const {targetId}=await raw.browser('Target.createTarget',{url:(url.startsWith('/checkout')?remote:origin)+url});await wait(targetId,"document.readyState==='complete'");return targetId;};
  const close=async id=>{await raw.browser('Target.closeTarget',{targetId:id});};
  const capture=(opts={})=>submitVaultCard({version:4,request_id:crypto.randomUUID(),deadline:Date.now()/1000+60,source:{browser:'dia',origin,tab_owner:OWNER,element:'#card',last4:'4242',expires:'2030-12',guards:[{selector:'#guard',text:'Owner test'}],...opts}},{port:TEST_PORT});
  const request=id=>({version:5,request_id:crypto.randomUUID(),deadline:Date.now()/1000+60,destination:{browser:'dia',origin:remote,tab_owner:OWNER,tab_id:id,fields:{number:{selector:'#number',frames:[]},expiry:{selector:'#expiry',frames:[{selector:'#expiryframe',origin:remote}]},cvc:{selector:'#cvc',frames:[{selector:'#cvcframe',origin}]}}},fields:{...F}});
  const fill=r=>submitVaultCard(r,{port:TEST_PORT});
  await t.test('guard, PAN, source identity and expiry mismatches fail closed',async()=>{
    const src=await tab('/source');
    assert.equal((await capture({guards:[{selector:'#guard',text:'Wrong owner'}]})).code,'guard_mismatch');
    assert.equal((await capture({last4:'0000'})).code,'card_shape_mismatch');
    assert.equal((await capture({expires:'2031-12'})).code,'card_shape_mismatch');
    assert.equal((await capture({origin:'https://wrong.example'})).code,'tab_not_found');
    assert.equal((await capture({tab_owner:'foreign-owner'})).code,'tab_not_found');
    await close(src);const bad=await tab('/source?bad');assert.equal((await capture()).code,'card_shape_mismatch');await close(bad);
  });
  await t.test('cross-origin OOPIF fields receive exact values; capture and fill never submit',async()=>{
    const src=await tab('/source'),dest=await tab('/checkout');
    const {targetInfos}=await raw.browser('Target.getTargets',{});
    assert.ok(targetInfos.some(x=>x.type==='iframe'&&x.url===origin+'/field?field=cvc'),'cross-site field is a real OOPIF');
    const captured=await capture();assert.deepEqual(captured,{status:'completed',verification:'captured',fields:F});
    assert.match(await ops.evaluate(conn,src,"document.querySelector('#card').textContent"),/Card \[redacted\]/);
    await assert.rejects(conn.send(src,'Page.captureScreenshot',{}),/tab_tainted/);
    await assert.rejects(ops.evaluate(conn,src,'1',{caller:true}),/tab_tainted/);
    const r=request(dest);assert.deepEqual(await fill(r),{status:'completed',verification:'filled',input_attempted:true,action_may_have_run:false});
    assert.equal(submitted,null);
    assert.equal((await fill(r)).code,'request_already_used');
    await assert.rejects(conn.send(dest,'Page.captureScreenshot',{}),/tab_tainted/);
    const oopif=targetInfos.find(x=>x.type==='iframe'&&x.url===origin+'/field?field=cvc').targetId;
    await assert.rejects(conn.send(oopif,'Page.captureScreenshot',{}),/tab_tainted/);
    await assert.rejects(ops.evaluate(conn,oopif,'1',{caller:true}),/tab_tainted/);
    await assert.rejects(ops.evaluate(conn,dest,'1',{caller:true}),/tab_tainted/);
    assert.equal(await ops.evaluate(conn,dest,"document.querySelector('#number').value"),'[redacted]');
    // Only this separate, explicit test submit invokes the form's submission path.
    await conn.send(dest,'Runtime.evaluate',{expression:"document.querySelector('form').requestSubmit()",returnByValue:true});
    for(let i=0;i<100&&!submitted;i++)await new Promise(r=>setTimeout(r,30));
    assert.deepEqual(submitted,F);
    await close(src);await close(dest);
  });
  await t.test('real Python agent-vault broker provider and executor', {skip:!process.env.BROWSERCTRL_CARD_INTEGRATION_SCRIPT},async()=>{
    submitted=null; const src=await tab('/source'),dest=await tab('/checkout');
    const destination=request(dest).destination;delete destination.tab_id;
    const source={browser:'dia',origin,tab_owner:OWNER,element:'#card',last4:'4242',expires:'2030-12',guards:[{selector:'#guard',text:'Owner test'}]};
    const env={...process.env,BROWSERCTRL_CARD_SOURCE_ORIGIN:origin,BROWSERCTRL_CARD_DEST_ORIGIN:remote,BROWSERCTRL_CARD_SOURCE_TAB:src,BROWSERCTRL_CARD_DEST_TAB:dest,BROWSERCTRL_CARD_OWNER:OWNER,BROWSERCTRL_VAULT_TEST_PORT:String(TEST_PORT),BROWSERCTRL_CARD_SOURCE_PLAN:JSON.stringify(source),BROWSERCTRL_CARD_DEST_PLAN:JSON.stringify(destination),BROWSERCTRL_CARD_DRIVER:path.resolve('bin/browserctrl-vault.mjs'),BROWSERCTRL_CARD_NODE:process.execPath};
    const result=await promisify(execFile)(process.env.BROWSERCTRL_CARD_INTEGRATION_PYTHON||'python3',[process.env.BROWSERCTRL_CARD_INTEGRATION_SCRIPT],{env,timeout:60000,maxBuffer:65536});
    const receipt=JSON.parse(result.stdout.trim());assert.equal(receipt.status,'completed');assert.equal(receipt.verification,'filled');
    assert.equal(submitted,null);
    await conn.send(dest,'Runtime.evaluate',{expression:"document.querySelector('form').requestSubmit()",returnByValue:true});
    for(let i=0;i<100&&!submitted;i++)await new Promise(r=>setTimeout(r,30));assert.deepEqual(submitted,F);
    await close(src);await close(dest);
  });
  await t.test('same-owner authentication taint is allowed; previously filled credentials cannot be laundered',async()=>{
    for (const [password,want] of [['SYNTHETIC_AUTH_PASSWORD','completed'],['123','failed']]) {
      const src=await tab('/source');
      const auth=await submitVaultFill({version:2,request_id:crypto.randomUUID(),deadline:Date.now()/1000+60,destination:{browser:'dia',origins:[origin],tab_id:src,element:'#auth'},field:'password',value:password},{port:TEST_PORT});
      assert.equal(auth.status,'completed');
      const result=await capture();assert.equal(result.status,want);
      if(want==='failed')assert.equal(result.code,'prior_secret_present');
      await close(src);
    }
  });
  await t.test('preflight destination errors insert nothing; partial failures are indeterminate',async()=>{
    const src=await tab('/source'),dest=await tab('/checkout?partial');assert.equal((await capture()).status,'completed');
    const wrong=request(dest);wrong.destination.origin='https://wrong.example';assert.equal((await fill(wrong)).input_attempted,false);
    const deadline=request(dest);deadline.deadline=Date.now()/1000-1;assert.equal((await fill(deadline)).code,'invalid_request');
    const denied=request(dest);denied.destination.tab_owner='other-owner';assert.equal((await fill(denied)).code,'source_unavailable');
    const changed=request(dest);changed.destination.fields.cvc.frames[0].origin=remote;assert.equal((await fill(changed)).input_attempted,false);
    const foreignConn=await connect(TEST_PORT,{owner:'card-foreign-owner'});
    const {targetId:foreign}=await foreignConn.browser('Target.createTarget',{url:remote+'/checkout'});
    try { const foreignResult=await fill(request(foreign));assert.equal(foreignResult.code,'tab_not_owned');assert.equal(foreignResult.input_attempted,false); }
    finally {await foreignConn.browser('Target.closeTarget',{targetId:foreign});foreignConn.close();}
    const kind=request(dest);kind.destination.fields.number.selector='#submit';const kindResult=await fill(kind);assert.equal(kindResult.code,'element_kind_mismatch');assert.equal(kindResult.input_attempted,false);
    const srcguard=request(dest);
    await conn.send(src,'Runtime.evaluate',{expression:"document.querySelector('#guard').textContent='Changed owner'",returnByValue:true});
    assert.equal((await fill(srcguard)).code,'source_changed');
    await conn.send(src,'Runtime.evaluate',{expression:"document.querySelector('#guard').textContent='Owner test'",returnByValue:true});
    const partial=await fill(request(dest));assert.equal(partial.status,'indeterminate');assert.equal(partial.input_attempted,true);assert.equal(partial.action_may_have_run,false);
    await close(src);await close(dest);
  });
});

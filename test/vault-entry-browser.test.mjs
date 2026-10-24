import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {connect} from '../lib/daemon.mjs';
import {SOCK,agentId} from '../lib/env.mjs';
import {chromeBinary,startHeadlessBrowser} from './helpers.mjs';

function raw(port,request,op='vault-entry') {return new Promise((resolve,reject)=>{const s=net.connect(SOCK(port));let b='';s.setTimeout(15000,()=>{s.destroy();reject(Error('timeout'));});s.on('connect',()=>s.write(JSON.stringify({reqId:1,op,owner:agentId(),request})+'\n'));s.on('data',c=>{b+=c;if(b.includes('\n')){s.destroy();resolve(JSON.parse(b.split('\n')[0]));}});s.on('error',reject);});}
test('isolated HTTPS Chromium: POST navigation, TOTP gate, reflection refusal and recovery', {skip:!chromeBinary(),timeout:90000}, async t=>{
  const dir=fs.mkdtempSync('/tmp/bc-vault-tls-');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(dir,'key.pem'),'-out',path.join(dir,'cert.pem'),'-subj','/CN=localhost','-days','1'],{stdio:'ignore'});
  const server=https.createServer({key:fs.readFileSync(path.join(dir,'key.pem')),cert:fs.readFileSync(path.join(dir,'cert.pem'))},(q,r)=>{
    r.setHeader('content-type','text/html');r.setHeader('cache-control','no-store');
    if(q.method==='POST') {
      let body='';q.on('data',chunk=>body+=chunk);q.on('end',()=>{
        const fields=new URLSearchParams(body), code=fields.get('code');
        assert.equal(fields.get('password'),'synthetic-private-password');assert.equal(code,'654321');
        const mode=new URL(q.url,'https://fixture.test').searchParams.get('mode');
        const output=mode==='text'?`<p>Entered code ${code}</p>`:mode==='attribute'?`<p data-code="${code}">Signed in</p>`:mode==='input'?`<input value="${code}">`:'<h1>Signed in</h1><p>synthetic-user</p>';
        setTimeout(()=>r.end(output),150);
      });return;
    }
    if(q.url==='/after-code?reflect=1'){r.end('<p>synthetic-private-password</p>');return;}
    r.end(`<form method="POST" onsubmit="window.retainedCode=document.querySelector('#code').value" action="/done${q.url.includes('?')?q.url.slice(q.url.indexOf('?')):''}"><input id="username" name="username"><input id="password" name="password" type="password"><input id="code" name="code" type="text"><button id="submit" onclick="console.log(document.querySelector('#code').value);const end=Date.now()+200;while(Date.now()<end){}">Sign in</button></form>`);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  process.env.BROWSERCTRL_CAPTURE='0';const browser=await startHeadlessBrowser(port);let client;
  t.after(async()=>{try{await client?.stop();}catch{}client?.close();await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  client=await connect(port);await client.browser('Security.setIgnoreCertificateErrors',{ignore:true});
  const origin=`https://127.0.0.1:${server.address().port}`;
  async function tab(suffix='') {
    const {targetId}=await client.browser('Target.createTarget',{url:origin+'/'+suffix});
    for(let i=0;i<40;i++){const v=await client.send(targetId,'Runtime.evaluate',{expression:"document.querySelectorAll('input').length",returnByValue:true});if(v.result?.value===3)return targetId;await new Promise(r=>setTimeout(r,30));}
    throw Error('fixture did not load');
  }
  const request=targetId=>({version:1,request_id:crypto.randomUUID(),deadline:Date.now()/1000+60,destination:{browser:'dia',tab_id:targetId,origin,fields:{username:'#username',password:'#password',totp:'#code'},submit:'#submit'},fields:{username:'synthetic-user',password:'synthetic-private-password',totp:'654321'}});
  async function closeAndRecover(targetId) {
    const recovery={version:1,destination:{browser:'dia',tab_id:targetId,origin}};
    assert.equal((await raw(port,recovery,'vault-recover')).result.code,'target_still_present');
    // Owner-close simulation touches only the isolated synthetic tab.
    await new Promise((resolve,reject)=>http.get(`http://127.0.0.1:${port}/json/close/${targetId}`,r=>{r.resume();r.on('end',resolve);}).on('error',reject));
    assert.equal((await raw(port,recovery,'vault-recover')).result.code,'closed_target_recovered');
    assert.equal((await client.status()).sensitivePhaseBlocked,false);
  }
  const targetId=await tab();
  const active=client.send(targetId,'Runtime.evaluate',{expression:'new Promise(r=>setTimeout(()=>r(true),250))',awaitPromise:true,returnByValue:true});
  await new Promise(r=>setTimeout(r,40));
  assert.ok((await client.status()).requestsInFlight>=1);assert.equal((await raw(port,undefined,'upgrade')).error,'daemon_busy_or_recording');await active;
  const normal=request(targetId), pending=raw(port,normal);await new Promise(r=>setTimeout(r,60));
  await assert.rejects(client.send(targetId,'Runtime.evaluate',{expression:'document.body.innerText',returnByValue:true}),/sensitive_phase_blocked/);
  const result=await pending;assert.equal(result.result?.status,'completed',JSON.stringify(result));assert.ok(!JSON.stringify(result).includes('654321'));
  assert.equal((await client.send(targetId,'Runtime.evaluate',{expression:'location.pathname',returnByValue:true})).result.value,'/done');
  const historyAfter=await client.send(targetId,'Page.getNavigationHistory',{});
  assert.equal(historyAfter.entries.length,1);assert.equal(historyAfter.currentIndex,0);
  assert.equal(new URL(historyAfter.entries[0].url).pathname,'/done');
  await client.send(targetId,'Runtime.evaluate',{expression:'history.back()'});
  await new Promise(resolve=>setTimeout(resolve,150));
  const restored=await client.send(targetId,'Runtime.evaluate',{expression:"({path:location.pathname,code:!!document.querySelector('#code'),retained:window.retainedCode=== '654321'})",returnByValue:true});
  assert.deepEqual(restored.result.value,{path:'/done',code:false,retained:false});

  const gatedTarget=await tab();
  await client.send(gatedTarget,'Runtime.evaluate',{expression: "const button=document.querySelector('#submit');button.disabled=true;document.querySelector('#code').addEventListener('input',()=>setTimeout(()=>button.disabled=false,50));"});
  assert.equal((await raw(port,request(gatedTarget))).result.status,'completed');
  for(const mode of ['disabled','replaced']) {
    const gated=await tab();
    await client.send(gated,'Runtime.evaluate',{expression: mode==='disabled'
      ? "document.querySelector('#submit').disabled=true;document.querySelector('form').onsubmit=()=>{throw Error('must not submit');};"
      : "const button=document.querySelector('#submit');button.disabled=true;document.querySelector('#code').addEventListener('input',()=>setTimeout(()=>{const replacement=button.cloneNode(true);replacement.disabled=false;button.replaceWith(replacement);},50));"});
    const rejected=await raw(port,request(gated));
    assert.equal(rejected.result.code,'cleanup_unverified');
    assert.equal(rejected.result.input_attempted,true);
    assert.equal((await client.status()).sensitivePhaseBlocked,true);
    await closeAndRecover(gated);
  }
  assert.equal((await raw(port,normal)).result.code,'request_already_used');assert.ok(!JSON.stringify(await client.events(targetId)).includes('654321'));
  const usedTarget=await tab();
  await client.send(usedTarget,'Page.navigate',{url:origin+'/used'});
  for(let i=0;i<40;i++){const v=await client.send(usedTarget,'Runtime.evaluate',{expression:"location.pathname==='/used' && !!document.querySelector('#code')",returnByValue:true});if(v.result?.value)break;await new Promise(r=>setTimeout(r,30));}
  assert.ok((await client.send(usedTarget,'Page.getNavigationHistory',{})).entries.length>1);
  const used=await raw(port,request(usedTarget));assert.equal(used.result.code,'entry_rejected');assert.equal(used.result.input_attempted,false);
  const untouched=await client.send(usedTarget,'Runtime.evaluate',{expression:"[...document.querySelectorAll('input')].every(e=>e.value==='')",returnByValue:true});assert.equal(untouched.result.value,true);
  const unownedTarget=await tab();const {release}=await import('../lib/claims.mjs');release(port,unownedTarget,{owner:agentId()});
  assert.equal((await raw(port,request(unownedTarget))).error,'protected_target_not_owned');
  const wrongTarget=await tab(), wrong=request(wrongTarget);wrong.destination.origin='https://wrong.test';
  assert.equal((await raw(port,wrong)).result.code,'entry_rejected');
  assert.equal((await raw(port,{...request(wrongTarget),deadline:0})).result.code,'invalid_request');
  // An SPA retains code in JavaScript state even after input.value is cleared.
  await client.send(wrongTarget,'Runtime.evaluate',{expression:"document.querySelector('form').onsubmit=e=>{e.preventDefault();window.retainedCode=document.querySelector('#code').value;}"});
  assert.equal((await raw(port,request(wrongTarget))).result.code,'cleanup_unverified');
  await assert.rejects(client.send(wrongTarget,'Runtime.evaluate',{expression:'window.retainedCode',returnByValue:true}),/sensitive_phase_blocked/);
  await closeAndRecover(wrongTarget);
  const continuationTarget=await tab();
  await client.send(continuationTarget,'Runtime.evaluate',{expression:`document.querySelector('form').onsubmit=e=>{e.preventDefault();window.retainedPassword=document.querySelector('#password').value;document.body.innerHTML='<div id="email-code">'+Array(6).fill('<input inputmode="numeric">').join('')+'</div>';document.querySelector('#email-code').onpaste=e=>{e.preventDefault();const code=e.clipboardData.getData('text');const form=document.createElement('form');form.method='POST';form.action='/done';for(const [name,value] of Object.entries({password:window.retainedPassword,code})){const input=document.createElement('input');input.name=name;input.value=value;form.append(input);}document.body.append(form);form.submit();};};`});
  assert.equal((await raw(port,request(continuationTarget))).result.code,'cleanup_unverified');
  await assert.rejects(client.send(continuationTarget,'Runtime.evaluate',{expression:'document.body.innerText',returnByValue:true}),/sensitive_phase_blocked/);
  const continuation={...request(continuationTarget),destination:{browser:'dia',tab_id:continuationTarget,origin,fields:{totp:'#email-code'},submit:'@auto'},fields:{totp:'654321'}};
  assert.equal((await raw(port,{...continuation,destination:{...continuation.destination,origin:'https://wrong.test'}},'vault-continue')).result.code,'recovery_mismatch');
  const continued=await raw(port,continuation,'vault-continue');
  assert.equal(continued.result.status,'completed',JSON.stringify(continued));
  assert.ok(!JSON.stringify(continued).includes('654321'));
  assert.equal((await client.status()).sensitivePhaseBlocked,false);
  assert.ok((await client.browser('Target.getTargets')).targetInfos.some(t=>t.targetId===continuationTarget));
  assert.equal((await client.send(continuationTarget,'Page.getNavigationHistory',{})).entries.length,1);
  assert.equal((await client.send(continuationTarget,'Runtime.evaluate',{expression:'window.retainedPassword===undefined',returnByValue:true})).result.value,true);
  assert.ok((await client.browser('Target.getTargets')).targetInfos.some(t=>t.targetId===targetId));
  const reflectedContinuation=await tab();
  await client.send(reflectedContinuation,'Runtime.evaluate',{expression:`document.querySelector('form').onsubmit=e=>{e.preventDefault();document.body.innerHTML='<div id="email-code">'+Array(6).fill('<input inputmode="numeric">').join('')+'</div>';document.querySelector('#email-code').onpaste=e=>{e.preventDefault();location.href='/after-code?reflect=1';};};`});
  assert.equal((await raw(port,request(reflectedContinuation))).result.code,'cleanup_unverified');
  const reflectedStep={...request(reflectedContinuation),destination:{browser:'dia',tab_id:reflectedContinuation,origin,fields:{totp:'#email-code'},submit:'@auto'},fields:{totp:'654321'}};
  assert.equal((await raw(port,reflectedStep,'vault-continue')).result.code,'cleanup_unverified');
  assert.equal((await client.status()).sensitivePhaseBlocked,true);
  await closeAndRecover(reflectedContinuation);
  for(const mode of ['text','attribute','input']) {
    const reflectedTarget=await tab('?mode='+mode);
    const reflected=await raw(port,request(reflectedTarget));
    assert.equal(reflected.result.status,'indeterminate',JSON.stringify(reflected));
    await assert.rejects(client.send(reflectedTarget,'Page.captureScreenshot',{}),/sensitive_phase_blocked/);
    await closeAndRecover(reflectedTarget);
  }
});

test('cooperative idle upgrade preserves Chromium tabs and stored claims', {skip:!chromeBinary(),timeout:30000},async t=>{
  const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  process.env.BROWSERCTRL_CAPTURE='0';const browser=await startHeadlessBrowser(port);let client;
  t.after(async()=>{try{await client?.stop();}catch{}client?.close();await browser.close();});
  client=await connect(port);const before=await client.status();
  const {targetId}=await client.browser('Target.createTarget',{url:'about:blank'});
  const {list}=await import('../lib/claims.mjs');const claimBefore=list(port).find(r=>r.targetId===targetId);
  assert.equal((await raw(port,undefined,'upgrade')).result,'stopping');client.close();
  await new Promise(r=>setTimeout(r,150));client=await connect(port);const after=await client.status();
  assert.notEqual(after.pid,before.pid);
  assert.ok((await client.browser('Target.getTargets')).targetInfos.some(t=>t.targetId===targetId));
  const claimAfter=list(port).find(r=>r.targetId===targetId);assert.equal(claimAfter.owner,claimBefore.owner);assert.equal(claimAfter.ts,claimBefore.ts);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {validateVaultFill, elementSpec, createRedactor, containsSecret, createFillGate, daemonTrusted, submitVaultFill} from '../lib/vault-fill.mjs';
import {runtimePath} from '../lib/env.mjs';

const request=(change=()=>{})=>{const r={version:2,request_id:crypto.randomUUID(),deadline:Date.now()/1000+60,destination:{browser:'dia',origins:['https://accounts.example.com','https://example.com'],tab_id:'ABCDEF1234567890',element:'@e12'},field:'password',value:'private-password-123'};change(r);return r;};
let port=19900;
const gate=(options={})=>createFillGate(++port,{recording:()=>false,send:async()=>{throw Error('no browser');},sessionFor:async()=>'S',withInput:async(_t,_s,fn)=>fn(),...options});

test('v2 request validation is exact and bounded',()=>{
  assert.equal(validateVaultFill(request()).version,2);
  const bad=[
    r=>r.version=1, r=>r.extra=1, r=>delete r.value, r=>r.request_id='short', r=>r.request_id='x'.repeat(129), r=>r.request_id='has space and more chars',
    r=>r.deadline=Date.now()/1000-1, r=>r.deadline=Date.now()/1000+121, r=>r.deadline='soon',
    r=>r.destination.browser='safari', r=>r.destination.browser='toString', r=>r.destination.extra='x', r=>delete r.destination.element,
    r=>r.destination.origins=[], r=>r.destination.origins=Array.from({length:9},(_,i)=>`https://a${i}.example.com`),
    r=>r.destination.origins=['http://example.com'], r=>r.destination.origins=['https://example.com/'], r=>r.destination.origins=['https://example.com/login'],
    r=>r.destination.origins=['https://user:pw@example.com'], r=>r.destination.origins=['https://example.com','https://example.com'], r=>r.destination.origins=['not a url'],
    r=>r.destination.tab_id='short', r=>r.destination.tab_id='A'.repeat(129), r=>r.destination.element='', r=>r.destination.element='x'.repeat(513),
    r=>r.field='otp', r=>r.field='__proto__', r=>r.value='', r=>r.value='x'.repeat(8193), r=>r.value=123,
  ];
  for(const change of bad) assert.throws(()=>validateVaultFill(request(change)),undefined,change.toString());
  assert.equal(validateVaultFill(request(r=>{r.destination.origins=Array.from({length:8},(_,i)=>`https://a${i}.example.com`);r.value='x'.repeat(8192);r.deadline=Date.now()/1000+119;})).version,2);
});

test('element names refs with or without @, otherwise CSS',()=>{
  assert.deepEqual(elementSpec('@e12'),{ref:'e12'});
  assert.deepEqual(elementSpec('ref_3'),{ref:'ref_3'});
  assert.deepEqual(elementSpec('input[type=password]'),{selector:'input[type=password]'});
  assert.deepEqual(elementSpec('@e12 input'),{selector:'@e12 input'});
});

test('redactor replaces raw, URI-encoded and HTML-entity forms everywhere in a reply',()=>{
  const secret='p@ss w&rd"<1>\'';
  const redact=createRedactor([secret,'654321']);
  const forms=[secret,encodeURIComponent(secret),encodeURIComponent(secret).replace(/%20/g,'+'),encodeURIComponent(secret).toLowerCase(),
    'p@ss w&amp;rd&quot;&lt;1&gt;&#39;','p@ss w&amp;rd&#34;&lt;1&gt;&#x27;','p@ss w&amp;rd"&lt;1&gt;\'',[...secret].map(c=>`&#${c.codePointAt(0)};`).join(''),JSON.stringify(secret).slice(1,-1)];
  for(const form of forms) {
    const out=redact({result:{value:`before ${form} after`,list:[form],[form]:1},warnings:[`x${form}`]});
    const text=JSON.stringify(out);
    assert.ok(!text.includes(form),form);assert.ok(text.includes('[redacted]'));assert.ok(text.includes('before [redacted] after'));
  }
  assert.equal(redact('code 654321 ok'),'code [redacted] ok');
  assert.deepEqual(redact({n:1,b:true,z:null}),{n:1,b:true,z:null});
  assert.equal(createRedactor([])('654321'),'654321');
  assert.ok(containsSecret('https://x.test/?c=p%40ss+w%26rd',['p@ss w&rd']));assert.ok(!containsSecret('nothing here',['p@ss w&rd']));
});

test('refusal classification on a tainted tab',async()=>{
  // A tab is tainted only through a fill; reach it through a fake browser.
  {
    const evaluated=[];
    const g2=gate({send:async(method,params)=>{if(method==='Runtime.evaluate')evaluated.push(params.expression);
      if(method==='Target.getTargets')return {targetInfos:[{targetId:'ABCDEF1234567890',type:'page'}]};
      if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'F',loaderId:'L1',url:'https://accounts.example.com/login'}}};
      if(method==='Page.createIsolatedWorld')return {executionContextId:7};
      if(method==='Runtime.evaluate')return {result:{subtype:'node',objectId:'O1'}};
      if(method==='DOM.describeNode')return {node:{backendNodeId:5}};
      if(method==='DOM.resolveNode')return {object:{objectId:'O2'}};
      if(method==='Runtime.callFunctionOn'){assert.ok(!JSON.stringify(params).includes('private-password'));return params.arguments[0].value.verify?{result:{value:{ok:true,length:20}}}:{result:{value:{ok:true}}};}
      if(method==='Input.insertText'){assert.equal(params.text,'private-password-123');return {};}
      return {};
    }});
    const result=await g2.run(request(),'owner');
    assert.deepEqual(result,{status:'completed',verification:'filled',input_attempted:true,action_may_have_run:false});
    assert.ok(evaluated.length && evaluated.every(e=>!e.includes('private-password')));
    const t='ABCDEF1234567890';
    const refused=[
      {op:'cdp',targetId:t,method:'Runtime.evaluate'},
      {op:'cdp',targetId:t,method:'Input.dispatchKeyEvent'},
      {op:'cdp',targetId:t,method:'Runtime.evaluate',mediated:true,caller:true},
      {op:'cdp',targetId:t,method:'Page.captureScreenshot',mediated:true},
      {op:'cdp',targetId:t,method:'Page.startScreencast',mediated:true},
      {op:'cdp',targetId:t,method:'Network.getRequestPostData',mediated:true},
      {op:'cdp',targetId:t,method:'Page.addScriptToEvaluateOnNewDocument',mediated:true},
      {op:'events',targetId:t,limit:100},{op:'events',targetId:t},
      {op:'browser',method:'Target.attachToTarget',params:{targetId:t}},
      {op:'browser',method:'Target.sendMessageToTarget',params:{targetId:t}},
      {op:'browser',method:'Tracing.start',params:{}},
    ];
    for(const req of refused) assert.match(String(g2.refusal(req)),/^tab_tainted/,JSON.stringify(req));
    const allowed=[
      {op:'cdp',targetId:t,method:'Runtime.evaluate',mediated:true},
      {op:'cdp',targetId:t,method:'Input.dispatchMouseEvent',mediated:true},
      {op:'cdp',targetId:t,method:'Page.navigate',mediated:true},
      {op:'events',targetId:t,limit:0},
      {op:'render',targetId:t},{op:'detach',targetId:t},
      {op:'browser',method:'Target.closeTarget',params:{targetId:t}},
      {op:'browser',method:'Target.getTargets',params:{}},
      {op:'vault-fill',request:request()},
      {op:'cdp',targetId:'OTHERTAB12345678',method:'Page.captureScreenshot'},
    ];
    for(const req of allowed) assert.equal(g2.refusal(req),null,JSON.stringify(req));
    assert.equal(g2.redact({text:'echo private-password-123'}).text,'echo [redacted]');
  }
});

test('fill refuses wrong origin, kind mismatch and reused IDs before any input',async()=>{
  const make=(topUrl,check)=>{const calls=[];return {calls,g:gate({send:async(method,params)=>{calls.push(method);
    if(method==='Target.getTargets')return {targetInfos:[{targetId:'ABCDEF1234567890',type:'page'}]};
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'F',loaderId:'L1',url:topUrl}}};
    if(method==='Page.createIsolatedWorld')return {executionContextId:7};
    if(method==='Runtime.evaluate')return {result:{subtype:'node',objectId:'O1'}};
    if(method==='DOM.describeNode')return {node:{backendNodeId:5}};
    if(method==='DOM.resolveNode')return {object:{objectId:'O2'}};
    if(method==='Runtime.callFunctionOn')return {result:{value:check}};
    return {};}})};};
  const wrong=make('https://evil.example.net/login',{ok:true});
  assert.equal((await wrong.g.run(request(),'o')).code,'origin_mismatch');assert.ok(!wrong.calls.includes('Input.insertText'));assert.equal(wrong.g.tainted('ABCDEF1234567890'),false);
  const kind=make('https://example.com/login',{code:'element_kind_mismatch'});
  const r=request();
  const out=await kind.g.run(r,'o');assert.equal(out.code,'element_kind_mismatch');assert.equal(out.input_attempted,false);assert.ok(!kind.calls.includes('Input.insertText'));
  assert.equal((await kind.g.run(r,'o')).code,'request_already_used');
  const journal=fs.readFileSync(runtimePath(`vault-requests-${port}.json`),'utf8');assert.ok(!journal.includes(r.request_id));assert.ok(!journal.includes(r.value));
  assert.equal((await kind.g.run(request(),'o',()=> 'tab_not_owned')).code,'tab_not_owned');
  assert.equal((await gate({recording:()=>true}).run(request(),'o')).code,'capture_or_action_active');
});

test('values-free marker survives a restart: only close and owner recovery are allowed',async()=>{
  const p=++port, t='ABCDEF1234567890';
  const send=async method=>{
    if(method==='Target.getTargets')return {targetInfos:[{targetId:t,type:'page'}]};
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'F',loaderId:'L1',url:'https://example.com/login'}}};
    if(method==='Page.createIsolatedWorld')return {executionContextId:7};
    if(method==='Runtime.evaluate')return {result:{subtype:'node',objectId:'O1'}};
    if(method==='DOM.describeNode')return {node:{backendNodeId:5}};
    if(method==='DOM.resolveNode')return {object:{objectId:'O2'}};
    if(method==='Runtime.callFunctionOn')return {result:{value:{ok:true}}};
    if(method==='Input.insertText')throw Error('transport lost');
    return {};
  };
  const options={recording:()=>false,send,sessionFor:async()=>'S',withInput:async(_t,_s,fn)=>fn()};
  const first=createFillGate(p,options), r=request();
  const result=await first.run(r,'owner-one');
  assert.equal(result.status,'indeterminate');assert.equal(result.input_attempted,true);assert.ok(!JSON.stringify(result).includes(r.value));
  const marker=fs.readFileSync(runtimePath(`vault-taint-${p}.json`),'utf8');assert.ok(!marker.includes(r.value));
  const restarted=createFillGate(p,options);
  assert.equal(restarted.tainted(t),true);assert.equal(restarted.active(),false);
  assert.match(restarted.refusal({op:'cdp',targetId:t,method:'Runtime.evaluate',mediated:true}),/tab_tainted/);
  assert.match(restarted.refusal({op:'cdp',targetId:t,method:'Input.dispatchMouseEvent',mediated:true}),/tab_tainted/);
  assert.equal((await restarted.run(request(),'owner-one')).code,'tab_tainted');
  assert.equal(restarted.refusal({op:'browser',method:'Target.closeTarget',params:{targetId:t}}),null);
  const recovery={version:1,destination:{browser:'dia',tab_id:t,origin:'https://example.com'}};
  assert.equal((await restarted.recover(recovery,'other',async()=>true)).code,'recovery_mismatch');
  assert.equal((await restarted.recover({...recovery,destination:{...recovery.destination,origin:'https://other.example'}},'owner-one',async()=>true)).code,'recovery_mismatch');
  assert.equal((await restarted.recover(recovery,'owner-one',async()=>false)).code,'target_still_present');
  assert.equal((await restarted.recover(recovery,'owner-one',async()=>true)).code,'closed_target_recovered');
  assert.equal(restarted.tainted(t),false);assert.equal(fs.existsSync(runtimePath(`vault-taint-${p}.json`)),false);
});

test('closing a live tainted tab lifts the taint and wipes the values',async()=>{
  const p=++port, t='ABCDEF1234567890';
  const g=createFillGate(p,{recording:()=>false,sessionFor:async()=>'S',withInput:async(_t,_s,fn)=>fn(),send:async(method,params)=>{
    if(method==='Target.getTargets')return {targetInfos:[{targetId:t,type:'page'}]};
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'F',loaderId:'L1',url:'https://example.com/login'}}};
    if(method==='Page.createIsolatedWorld')return {executionContextId:7};
    if(method==='Runtime.evaluate')return {result:{subtype:'node',objectId:'O1'}};
    if(method==='DOM.describeNode')return {node:{backendNodeId:5}};
    if(method==='DOM.resolveNode')return {object:{objectId:'O2'}};
    if(method==='Runtime.callFunctionOn')return {result:{value:params.arguments[0].value.verify?{ok:true,length:20}:{ok:true}}};
    return {};
  }});
  assert.equal((await g.run(request(),'o')).verification,'filled');
  assert.equal(g.redact('private-password-123'),'[redacted]');
  g.closed(t);
  assert.equal(g.tainted(t),false);assert.equal(g.redact('private-password-123'),'private-password-123');
  assert.equal(fs.existsSync(runtimePath(`vault-taint-${p}.json`)),false);
});

test('daemon trust check: the OS-reported listener must run this install root',async()=>{
  const root=path.resolve(new URL('..',import.meta.url).pathname);
  const script=fs.realpathSync(path.join(root,'lib','daemon-run.mjs'));
  const exec=(listing)=>async(cmd,args)=>{
    if(/lsof$/.test(cmd))return {stdout:'4242\n'};
    if(cmd==='/bin/ps'){assert.deepEqual(args,['-ww','-o','command=','-p','4242']);return {stdout:listing+'\n'};}
    throw Error('unexpected');
  };
  if(process.platform==='win32')return;
  if(fs.existsSync('/proc/4242/cmdline'))return;
  assert.equal(await daemonTrusted('/tmp/s.sock',9223,{root,exec:exec(`/usr/bin/node ${script} 9223`)}),true);
  assert.equal(await daemonTrusted('/tmp/s.sock',9223,{root,exec:exec(`/usr/bin/node /other/checkout/lib/daemon-run.mjs 9223`)}),false);
  assert.equal(await daemonTrusted('/tmp/s.sock',9223,{root,exec:exec(`/usr/bin/node ${script} 9224`)}),false);
  assert.equal(await daemonTrusted('/tmp/s.sock',9223,{root,exec:async()=>{throw Error('lsof missing');}}),false);
  assert.equal(await daemonTrusted('/tmp/s.sock',9223,{root,exec:async()=>({stdout:''})}),false);
  const other=fs.mkdtempSync(path.join(os.tmpdir(),'bc-root-'));fs.mkdirSync(path.join(other,'lib'));fs.writeFileSync(path.join(other,'lib','daemon-run.mjs'),'');
  assert.equal(await daemonTrusted('/tmp/s.sock',9223,{root:other,exec:exec(`/usr/bin/node ${script} 9223`)}),false);
  fs.rmSync(other,{recursive:true,force:true});
});

test('driver fails closed with daemon_untrusted and sends nothing',async()=>{
  const net=await import('node:net');const {SOCK}=await import('../lib/env.mjs');
  const p=++port;fs.mkdirSync(path.dirname(SOCK(p)),{recursive:true});
  let received='';const server=net.createServer(s=>s.on('data',c=>received+=c));
  await new Promise(r=>server.listen(SOCK(p),r));
  try {
    const result=await submitVaultFill(request(),{port:p,trusted:async()=>false});
    assert.deepEqual(result,{status:'failed',verification:'not_verified',input_attempted:false,action_may_have_run:false,code:'daemon_untrusted'});
    await new Promise(r=>setTimeout(r,50));assert.equal(received,'');
  } finally {await new Promise(r=>server.close(r));}
});

test('stdio driver dispatches v2 and never echoes a malformed value',()=>{
  const bin=new URL('../bin/browserctrl-vault.mjs',import.meta.url).pathname;
  for(const r of [request(x=>x.extra='private-password-123'),request(x=>x.destination.origins=['http://example.com'])]) {
    const child=spawnSync(process.execPath,[bin],{input:JSON.stringify(r),encoding:'utf8'});
    assert.equal(child.status,0);assert.equal(child.stderr,'');assert.ok(!child.stdout.includes('private-password'));assert.equal(JSON.parse(child.stdout).code,'invalid_request');
  }
});

test('a daemon that answers with an error never started the fill',async()=>{
  const net=await import('node:net');const {SOCK}=await import('../lib/env.mjs');
  const p=++port;fs.mkdirSync(path.dirname(SOCK(p)),{recursive:true});
  const server=net.createServer(s=>s.on('data',()=>s.write(JSON.stringify({reqId:1,error:'unknown op vault-fill'})+'\n')));
  await new Promise(r=>server.listen(SOCK(p),r));
  try {
    assert.deepEqual(await submitVaultFill(request(),{port:p,trusted:async()=>true}),{status:'failed',verification:'not_verified',input_attempted:false,action_may_have_run:false,code:'daemon_refused'});
  } finally {await new Promise(r=>server.close(r));}
});

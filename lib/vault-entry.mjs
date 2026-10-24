// Trusted credential entry. Values are accepted only through private stdio/IPC.
import fs from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import { BROWSERS, SOCK, runtimePath, agentId } from './env.mjs';
import {validateAuthWorkflow,workflowStates,workflowStateExpression,workflowResendExpression,workflowCodeExpression} from './auth-workflow.mjs';

const fail = (code, attempted = false, ran = false) => ({status: attempted ? 'indeterminate' : 'failed', verification:'not_verified', input_attempted:attempted, action_may_have_run:ran, code});
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).every(k => keys.includes(k));
export function validateVaultEntry(r, now = Date.now()/1000) {
  if (!exact(r,['version','request_id','deadline','destination','fields']) || r.version !== 1 || !/^[A-Za-z0-9_-]{16,128}$/.test(r.request_id) || !Number.isFinite(r.deadline) || r.deadline <= now || r.deadline > now+300) throw Error('invalid_request');
  const d = r.destination;
  if (!exact(d,['browser','tab_id','origin','fields','submit']) || !(BROWSERS[d.browser] || d.browser === 'safari') || !/^[A-Za-z0-9_-]{8,128}$/.test(d.tab_id) || typeof d.origin !== 'string') throw Error('invalid_destination');
  const u = new URL(d.origin);
  if (u.protocol !== 'https:' || u.origin !== d.origin || u.username || u.password) throw Error('invalid_destination');
  if (!exact(d.fields,['username','password','totp']) || !exact(r.fields,['username','password','totp'])) throw Error('invalid_fields');
  const keys = Object.keys(r.fields).sort();
  if (!keys.length || !keys.some(k => ['password','totp'].includes(k)) || keys.join() !== Object.keys(d.fields).sort().join()) throw Error('invalid_fields');
  if (new Set(Object.values(d.fields)).size !== keys.length) throw Error('invalid_fields');
  for (const k of keys) if (typeof r.fields[k] !== 'string' || !r.fields[k] || r.fields[k].length > 8192 || typeof d.fields[k] !== 'string' || !d.fields[k] || d.fields[k].length>512) throw Error('invalid_fields');
  if (typeof d.submit !== 'string' || !d.submit || d.submit.length>512 || Object.values(d.fields).includes(d.submit)) throw Error('invalid_fields');
  return r;
}

// One atomic page turn checks origin, frame, targets and focus, fills and submits.
// Never return DOM strings, exception details or credential values.
export function entryExpression(r, cleanup = false) {
  return `(async () => {const d=${JSON.stringify(r.destination)}, values=${JSON.stringify(cleanup ? {} : r.fields)}; let attempted=false; try {
    if (location.origin!==d.origin || window.top!==window || document.querySelector('iframe,frame')) return {ok:false};
    const fields=Object.entries(d.fields).map(([k,s])=>{const n=document.querySelectorAll(s); if(n.length!==1) throw 0; return [k,n[0]];});
    if (${cleanup}) { for(const [,e] of fields) { if(!(e instanceof HTMLInputElement)) throw 0; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,''); } return {ok:fields.every(([,e])=>e.value==='')}; }
    if (Date.now()/1000>=${JSON.stringify(r.deadline)}) return {ok:false};
    const bs=document.querySelectorAll(d.submit); if(bs.length!==1) return {ok:false}; const b=bs[0];
    if(!(b instanceof HTMLElement) || b.getClientRects().length===0) return {ok:false};
    for(const [k,e] of fields) { if(!(e instanceof HTMLInputElement) || e.disabled || e.readOnly || !e.getClientRects().length || (k==='password' && e.type!=='password') || (k==='totp' && !['text','tel','number','password'].includes(e.type))) return {ok:false}; }
    for(const [k,e] of fields) { if(location.origin!==d.origin || Date.now()/1000>=${JSON.stringify(r.deadline)}) return {ok:false,attempted}; e.focus(); if(document.activeElement!==e) return {ok:false,attempted}; attempted=true; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,values[k]); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); }
    if(location.origin!==d.origin || Date.now()/1000>=${JSON.stringify(r.deadline)} || document.querySelector('iframe,frame') || fields.some(([k,e])=>!e.isConnected || document.querySelectorAll(d.fields[k]).length!==1 || document.querySelector(d.fields[k])!==e || e.value!==values[k]) || document.querySelectorAll(d.submit).length!==1 || document.querySelector(d.submit)!==b) return {ok:false,attempted};
    const enabledDeadline=Math.min(Date.now()+2000,${JSON.stringify(r.deadline)}*1000);
    while(b.matches(':disabled') && Date.now()<enabledDeadline) await new Promise(resolve=>setTimeout(resolve,20));
    if(location.origin!==d.origin || Date.now()/1000>=${JSON.stringify(r.deadline)} || document.querySelector('iframe,frame') || fields.some(([k,e])=>!e.isConnected || document.querySelectorAll(d.fields[k]).length!==1 || document.querySelector(d.fields[k])!==e || e.value!==values[k]) || document.querySelectorAll(d.submit).length!==1 || document.querySelector(d.submit)!==b) return {ok:false,attempted};
    b.focus(); if(document.activeElement!==b || location.origin!==d.origin || Date.now()/1000>=${JSON.stringify(r.deadline)} || document.querySelector(d.submit)!==b || !b.isConnected || b.matches(':disabled')) return {ok:false,attempted}; b.click(); return {ok:true,attempted:true,submitted:true};
  } catch {return {ok:false,attempted};} })()`;
}

// Continue only an already protected authentication tab, then verify document cleanup.
export function validateVaultContinuation(r, now=Date.now()/1000) {
  validateVaultEntry(r,now);
  if(r.destination.browser==='safari' || Object.keys(r.fields).join()!=='totp' || !/^\d{6}$/.test(r.fields.totp) || r.destination.submit!=='@auto') throw Error('invalid_continuation');
  return r;
}

export function continuationExpression(r) {
  return `(async()=>{const d=${JSON.stringify(r.destination)},code=${JSON.stringify(r.fields.totp)};let attempted=false;try{
    if(location.origin!==d.origin || window.top!==window || document.querySelector('iframe,frame') || Date.now()/1000>=${JSON.stringify(r.deadline)}) return {ok:false};
    const matches=document.querySelectorAll(d.fields.totp);if(matches.length!==1)return {ok:false};const target=matches[0];
    if(!(target instanceof HTMLElement) || !target.getClientRects().length)return {ok:false};
    const inputs=target instanceof HTMLInputElement?[target]:[...target.querySelectorAll('input')];
    if(![1,6].includes(inputs.length) || inputs.some(e=>e.type==='password'||e.disabled||e.readOnly||!e.getClientRects().length||e.value!==''))return {ok:false};
    if(location.origin!==d.origin||document.querySelector(d.fields.totp)!==target||Date.now()/1000>=${JSON.stringify(r.deadline)})return {ok:false};
    inputs[0].focus();if(document.activeElement!==inputs[0])return {ok:false};attempted=true;
    if(inputs.length===1){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(inputs[0],code);inputs[0].dispatchEvent(new Event('input',{bubbles:true}));inputs[0].dispatchEvent(new Event('change',{bubbles:true}));}
    else {const data=new DataTransfer();data.setData('text',code);target.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));}
    return {ok:true,attempted:true,submitted:true};
  }catch{return {ok:false,attempted};}})()`;
}

export function secretFreeDocumentExpression(origin, values) {
  return `(() => {try {const origin=${JSON.stringify(origin)}, forbidden=${JSON.stringify(values)};
    if(location.origin!==origin || document.readyState!=='complete' || document.querySelector('iframe,frame')) return {ok:false};
    const contains=value=>{if(typeof value!=='string') return false; let decoded=value;try{decoded=decodeURIComponent(value.split('+').join(' '));}catch{} return forbidden.some(secret=>value.includes(secret)||decoded.includes(secret)||value.includes(encodeURIComponent(secret)));};
    if(contains(location.href)) return {ok:false};
    const scan=root=>{
      if(contains(root.textContent)||contains(root.documentElement?.textContent)) return false;
      for(const e of root.querySelectorAll('*')) {
        for(const a of e.attributes) if(contains(a.value)) return false;
        if(typeof e.value==='string' && contains(e.value)) return false;
        if(e.shadowRoot && !scan(e.shadowRoot)) return false;
        if(e instanceof HTMLTemplateElement && !scan(e.content)) return false;
      }
      return true;
    };
    return {ok:scan(document),document_replaced:true};
  }catch{return {ok:false};}})()`;
}

export function validateVaultRecovery(r) {
  if (!exact(r,['version','destination']) || r.version!==1 || !exact(r.destination,['browser','tab_id','origin'])) throw Error('invalid_request');
  const d=r.destination;
  if (!(BROWSERS[d.browser] || d.browser === 'safari') || !/^[A-Za-z0-9_-]{8,128}$/.test(d.tab_id) || typeof d.origin!=='string' || new URL(d.origin).protocol!=='https:' || new URL(d.origin).origin!==d.origin) throw Error('invalid_request');
  return r;
}

export function createVaultGate(port, {recording, busy, evaluate, reset, finishTarget, now=()=>Date.now()/1000}) {
  const marker=runtimePath(`vault-sensitive-${port}.json`);
  const journal=runtimePath(`vault-requests-${port}.json`);
  let active=fs.existsSync(marker);
  let executing=false;
  const suppressed = new Set();
  const pendingSecrets = new Map();
  const workflows = new Map();
  function save(file,value) {const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600});fs.renameSync(tmp,file);}
  return {
    progress:()=>{const session=[...workflows.values()][0];return session?{state:session.state,resends:session.resends,code_attempted:session.codeAttempted,remaining_seconds:Math.max(0,Math.floor(session.deadline-now()))}:null;},
    blocked:()=>active,
    suppressed:target=>active || suppressed.has(target),
    // A suppressed tab whose page target was replaced stays suppressed under its new id.
    replaced:(from,to)=>{if([].concat(from).some(id=>suppressed.has(id)))suppressed.add(to);},
    async recover(request,owner,verifyAbsent) {
      try {validateVaultRecovery(request);} catch {return fail('invalid_request');}
      if(executing) return fail('sensitive_phase_active');
      let saved;try {saved=JSON.parse(fs.readFileSync(marker,'utf8'));} catch {return fail('recovery_unavailable');}
      const d=request.destination;
      if(saved.version!==1 || saved.targetId!==d.tab_id || saved.browser!==d.browser || saved.origin!==d.origin || saved.owner!==owner) return fail('recovery_mismatch');
      // Absence is obtained by the trusted daemon, never caller attestation.
      try {if(!(await verifyAbsent(d.tab_id))) return fail('target_still_present');} catch {return fail('recovery_unverified');}
      if(executing) return fail('sensitive_phase_active');
      fs.unlinkSync(marker);active=false;pendingSecrets.delete(d.tab_id);reset();
      return {status:'completed',verification:'not_verified',input_attempted:false,action_may_have_run:false,code:'closed_target_recovered'};
    },
    async workflow(request,authorize,owner) {
      try{validateAuthWorkflow(request,now());}catch{return fail('invalid_workflow_request');}
      const d=request.destination,target=d.tab_id;
      if(request.action==='begin') {
        if(active || executing)return fail('sensitive_phase_blocked');
        try{authorize(false);}catch{return fail('protected_target_not_owned');}
        const session={owner,destination:d,policy:JSON.stringify(request.workflow),id:request.workflow_id,deadline:request.deadline,started:now(),resends:0,codeAttempted:false,state:'pending'};
        workflows.set(target,session);
        const result=await this.run({version:1,request_id:request.request_id,deadline:request.deadline,destination:{...d,...request.workflow.login},fields:request.fields},()=>authorize(false),owner,{deferCleanup:true});
        if(!active)workflows.delete(target);
        return {...result,state:'pending'};
      }
      const session=workflows.get(target);
      if(!active || executing || !session || !pendingSecrets.has(target))return fail('workflow_context_lost');
      if(session.owner!==owner || session.id!==request.workflow_id || JSON.stringify(session.destination)!==JSON.stringify(d) || session.policy!==JSON.stringify(request.workflow) || (request.action!=='finish' && request.deadline>session.deadline))return fail('workflow_scope_mismatch');
      if(recording() || busy())return fail('capture_or_action_active');
      try{authorize(true);}catch{return fail('protected_target_not_owned');}
      if(!['status','finish'].includes(request.action)) {
        let seen;try{seen=JSON.parse(fs.readFileSync(journal,'utf8'));}catch{return fail('journal_unavailable');}
        const key=crypto.createHash('sha256').update(request.request_id).digest('hex');
        if(seen[key])return fail('request_already_used');
        if(Object.keys(seen).length>=10000)return fail('journal_full');
        seen[key]=true;save(journal,seen);
      }
      executing=true;
      try {
        if(request.action==='finish') {
          let clean=false;try{clean=await finishTarget(target,{origin:d.origin,forbidden:pendingSecrets.get(target),cleanupPath:request.workflow.cleanup_path});}catch{}
          if(!clean)return fail('cleanup_unverified',true,true);
          fs.unlinkSync(marker);active=false;pendingSecrets.delete(target);workflows.delete(target);reset();
          return {status:'completed',verification:'not_verified',input_attempted:false,action_may_have_run:false,state:'cleaned'};
        }
        if(request.action==='status') {
          const result=await evaluate(target,workflowStateExpression(request),{origin:d.origin,authorize:()=>authorize(true),continuation:true,workflowAction:'status'});
          if(!workflowStates.has(result.state)||typeof result.resend_available!=='boolean')return fail('invalid_workflow_state');
          session.state=result.state;
          return {status:'completed',verification:'not_verified',input_attempted:false,action_may_have_run:false,state:result.state,resend_available:result.resend_available};
        }
        if(request.action==='resend') {
          const rule=request.workflow.challenge.resend;
          if(session.resends>=rule.max_attempts || now()-session.started<rule.cooldown_seconds)return fail('resend_limit');
          session.resends++;session.started=now();
        } else {
          if(session.codeAttempted)return fail('code_already_attempted');
          session.codeAttempted=true;pendingSecrets.set(target,[...new Set([...pendingSecrets.get(target),request.fields.totp])]);
        }
        const result=await evaluate(target,request.action==='resend'?workflowResendExpression(request):workflowCodeExpression(request),{origin:d.origin,authorize:()=>authorize(true),continuation:true});
        if(result.ok && result.submitted){session.state='pending';return {status:'completed',verification:'submitted',input_attempted:true,action_may_have_run:true,state:'pending'};}
        return fail('entry_rejected',result.attempted===true,result.submitted===true);
      }catch{return fail('workflow_step_uncertain',request.action!=='status',request.action!=='status');}
      finally{executing=false;reset();}
    },
    async continue(request,authorize,owner) {
      if(workflows.has(request?.destination?.tab_id))return fail('workflow_scope_required');
      try {validateVaultContinuation(request,now());} catch {return fail('invalid_request');}
      if(executing || !active || recording() || busy()) return fail('continuation_unavailable');
      let saved;try {saved=JSON.parse(fs.readFileSync(marker,'utf8'));}catch{return fail('recovery_unavailable');}
      const d=request.destination;
      if(saved.targetId!==d.tab_id || saved.browser!==d.browser || saved.origin!==d.origin || saved.owner!==owner) return fail('recovery_mismatch');
      if(!pendingSecrets.has(d.tab_id))return fail('continuation_context_lost');
      let seen;try {seen=JSON.parse(fs.readFileSync(journal,'utf8'));}catch{return fail('journal_unavailable');}
      const key=crypto.createHash('sha256').update(request.request_id).digest('hex');
      if(seen[key])return fail('request_already_used');
      if(Object.keys(seen).length>=10000)return fail('journal_full');
      seen[key]=true;save(journal,seen);executing=true;let attempted=false,submitted=false,clean=false;
      try {
        authorize();
        const result=await evaluate(d.tab_id,continuationExpression(request),{origin:d.origin,authorize,continuation:true});
        attempted=result.attempted===true;submitted=result.submitted===true;
      }catch{attempted=true;}
      finally {
        const forbidden=[...new Set([...pendingSecrets.get(d.tab_id),request.fields.totp])];
        pendingSecrets.set(d.tab_id,forbidden);
        try {clean=await finishTarget(d.tab_id,{origin:d.origin,forbidden});}catch{}
        executing=false;reset();
        if(clean){fs.unlinkSync(marker);active=false;pendingSecrets.delete(d.tab_id);}
      }
      if(submitted && clean)return {status:'completed',verification:'submitted',input_attempted:true,action_may_have_run:true};
      return fail(clean?'entry_rejected':'cleanup_unverified',attempted,submitted);
    },
    async run(request, authorize = () => {}, owner = 'vault-owner', options = {}) {
      try {validateVaultEntry(request,now());} catch {return fail('invalid_request');}
      if(request.destination.browser==='safari' && port!==9228) return fail('invalid_request');
      if(active) return fail('sensitive_phase_blocked');
      let seen; try {seen=JSON.parse(fs.readFileSync(journal,'utf8'));} catch(e) {if(e.code!=='ENOENT') return fail('journal_unavailable');seen={};}
      const key=crypto.createHash('sha256').update(request.request_id).digest('hex');
      if(seen[key]) return fail('request_already_used');
      if(Object.keys(seen).length>=10000) return fail('journal_full');
      if(recording() || busy()) return fail('capture_or_action_active');
      seen[key]=true;save(journal,seen);
      // Durable before any secret reaches the browser. On crash, all mediated
      // commands remain blocked; owner must close/recover the browser explicitly.
      save(marker,{version:1,blocked:true,targetId:request.destination.tab_id,browser:request.destination.browser,origin:request.destination.origin,selectors:request.destination.fields,owner});active=true;executing=true;
      const target=request.destination.tab_id; suppressed.add(target);reset();
      let attempted=false, submitted=false, clean=false;
      const cleanupMeta={cleanup:true,origin:request.destination.origin,forbidden:['password','totp'].filter(key=>request.fields[key]).map(key=>request.fields[key])};
      pendingSecrets.set(target,cleanupMeta.forbidden);
      const verifyCleanup=async()=>{
        const result=await evaluate(target,entryExpression(request,true),cleanupMeta);
        return result.ok===true && result.document_replaced===true;
      };
      try {
        authorize();
        const result=await evaluate(target,entryExpression(request),{origin:request.destination.origin,authorize});
        // Transport failure may mean input occurred. Never replay automatically.
        attempted=result.attempted===true; submitted=result.submitted===true;
        if(options.deferCleanup && attempted){if(result.ok && submitted)return {status:'completed',verification:'submitted',input_attempted:true,action_may_have_run:true};return fail('entry_rejected',attempted,submitted);}
        clean=(!attempted && !submitted) || await verifyCleanup();
        if(result.ok && submitted && clean) return {status:'completed',verification:'submitted',input_attempted:true,action_may_have_run:true};
        return fail(clean?'entry_rejected':'cleanup_unverified',attempted,submitted);
      } catch {
        attempted=true;
        if(!options.deferCleanup)try {clean=await verifyCleanup();} catch {}
        return fail('entry_outcome_uncertain',true,true);
      }
      finally {executing=false;reset();if(clean){fs.unlinkSync(marker);active=false;pendingSecrets.delete(target);}}
    }
  };
}

export async function submitVaultEntry(request, {recover = false, continuation = false} = {}) {
  try {(recover ? validateVaultRecovery : continuation ? validateVaultContinuation : validateVaultEntry)(request);} catch {return fail('invalid_request');}
  // No ensureDaemon(): an old daemon must never be restarted while holding tabs.
  return new Promise(resolve=>{
    const socket=net.connect(request.destination.browser === 'safari' ? runtimePath('safari.sock') : SOCK(BROWSERS[request.destination.browser].port));let buf='',sent=false;
    const done=result=>{socket.destroy();resolve(result);};
    socket.setTimeout(45000,()=>done(fail('adapter_timeout',sent,sent)));
    socket.on('connect',()=>{sent=true;socket.write(JSON.stringify({reqId:1,op:recover?'vault-recover':continuation?'vault-continue':'vault-entry',owner:agentId(),label:'vault-entry',request})+'\n');});
    socket.on('data',chunk=>{buf+=chunk;if(buf.length>8192)return done(fail('adapter_response_invalid',sent,sent));const nl=buf.indexOf('\n');if(nl<0)return;try{const row=JSON.parse(buf.slice(0,nl));const v=row.result;if(!exact(v,['status','verification','input_attempted','action_may_have_run','code']) || !['completed','failed','indeterminate'].includes(v.status) || !['submitted','not_verified'].includes(v.verification) || typeof v.input_attempted!=='boolean' || typeof v.action_may_have_run!=='boolean' || (v.code!==undefined&&!/^[a-z_]{1,64}$/.test(v.code)))return done(fail('adapter_unavailable',sent,sent));done(v);}catch{done(fail('adapter_response_invalid',sent,sent));}});
    socket.on('error',()=>done(fail('adapter_unavailable',sent,sent)));
    socket.on('end',()=>done(fail('adapter_disconnected',sent,sent)));
  });
}

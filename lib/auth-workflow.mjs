// Fixed-policy authentication steps. No page text or credential values leave this channel.
import net from 'node:net';
import {BROWSERS,SOCK,agentId} from './env.mjs';

const object=v=>v && typeof v==='object' && !Array.isArray(v);
const exact=(v,keys)=>object(v) && Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
const selector=v=>typeof v==='string' && v.length>0 && v.length<=512 && !/[\r\n\0]/.test(v);
const localPath=v=>{try{const decoded=decodeURIComponent(v);return typeof v==='string' && /^\/(?!\/)/.test(v) && /^\/(?!\/)/.test(decoded) && v.length<=512 && !/[\\\r\n\0#]/.test(decoded);}catch{return false;}};
export const workflowStates=new Set(['password_form','waiting_for_email','pending','authenticated','credentials_rejected','unexpected_origin','unsupported','cleaned']);

export function validateAuthWorkflow(r,now=Date.now()/1000) {
  if(!exact(r,['version','request_id','workflow_id','deadline','action','destination','workflow','fields']) || r.version!==1 || !/^[A-Za-z0-9_-]{16,128}$/.test(r.request_id) || !/^[A-Za-z0-9_-]{16,128}$/.test(r.workflow_id) || !Number.isFinite(r.deadline) || r.deadline<=0 || (r.action!=='finish' && r.deadline<=now) || r.deadline>now+300 || !['begin','status','code','resend','finish'].includes(r.action))throw Error('invalid_workflow_request');
  const d=r.destination,w=r.workflow;
  if(!exact(d,['browser','tab_id','origin']) || !BROWSERS[d.browser] || !/^[A-Za-z0-9_-]{8,128}$/.test(d.tab_id))throw Error('invalid_workflow_destination');
  const u=new URL(d.origin);if(u.protocol!=='https:' || u.origin!==d.origin || u.username || u.password)throw Error('invalid_workflow_destination');
  if(!exact(w,['login','challenge','success','cleanup_path','return_path']) || !exact(w.login,['fields','submit']) || !exact(w.login.fields,['username','password']) || !Object.values(w.login.fields).every(selector) || new Set(Object.values(w.login.fields)).size!==2 || !selector(w.login.submit))throw Error('invalid_workflow_policy');
  if(!exact(w.challenge,['selector','submit','resend']) || !selector(w.challenge.selector) || !selector(w.challenge.submit))throw Error('invalid_workflow_policy');
  const resend=w.challenge.resend;
  if(!exact(resend,['selector','text','max_attempts','cooldown_seconds']) || !selector(resend.selector) || typeof resend.text!=='string' || !resend.text.trim() || resend.text.length>128 || !Number.isInteger(resend.max_attempts) || resend.max_attempts<0 || resend.max_attempts>1 || !Number.isInteger(resend.cooldown_seconds) || resend.cooldown_seconds<30 || resend.cooldown_seconds>120)throw Error('invalid_workflow_policy');
  if(!exact(w.success,['path','required_keys']) || !localPath(w.success.path) || !Array.isArray(w.success.required_keys) || !w.success.required_keys.length || w.success.required_keys.length>8 || !w.success.required_keys.every(k=>typeof k==='string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)) || !localPath(w.cleanup_path) || !localPath(w.return_path))throw Error('invalid_workflow_policy');
  const fields=r.action==='begin'?['username','password']:r.action==='code'?['totp']:[];
  if(!exact(r.fields,fields) || Object.values(r.fields).some(v=>typeof v!=='string'||!v||v.length>8192) || (r.action==='code'&&!/^[0-9]{4,8}$/.test(r.fields.totp)) || (r.action==='begin'&&r.workflow_id!==r.request_id))throw Error('invalid_workflow_fields');
  return r;
}

export function workflowStateExpression(r) {
  return `(async()=>{const d=${JSON.stringify(r.destination)},w=${JSON.stringify(r.workflow)};try{
    if(location.origin!==d.origin)return {state:'unexpected_origin',resend_available:false};
    if(window.top!==window)return {state:'unsupported',resend_available:false};
    const visible=e=>e instanceof HTMLElement && e.getClientRects().length>0;
    try {const response=await fetch(w.success.path,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(2500)});if(response.status===200 && response.headers.get('content-type')?.includes('application/json')){const text=await response.text();if(text.length<=1048576){const data=JSON.parse(text);if(data && typeof data==='object' && w.success.required_keys.every(k=>Object.hasOwn(data,k)))return {state:'authenticated',resend_available:false};}}}catch{}
    const challenge=[...document.querySelectorAll(w.challenge.selector)].filter(visible);
    const resend=[...document.querySelectorAll(w.challenge.resend.selector)].filter(e=>visible(e)&&!e.matches(':disabled')&&e.textContent.toLowerCase().includes(w.challenge.resend.text.toLowerCase()));
    if(challenge.length===1)return {state:'waiting_for_email',resend_available:resend.length===1};
    if(Object.values(w.login.fields).every(s=>{const a=document.querySelectorAll(s);return a.length===1&&visible(a[0]);}))return {state:'password_form',resend_available:false};
    return {state:'pending',resend_available:false};
  }catch{return {state:'unsupported',resend_available:false};}})()`;
}

export function workflowResendExpression(r) {
  return `(()=>{let attempted=false;try{const d=${JSON.stringify(r.destination)},w=${JSON.stringify(r.workflow)};
    if(location.origin!==d.origin||window.top!==window||document.querySelector('iframe,frame')||Date.now()/1000>=${JSON.stringify(r.deadline)})return {ok:false};
    const visible=e=>e instanceof HTMLElement&&e.getClientRects().length>0;
    if([...document.querySelectorAll(w.challenge.selector)].filter(visible).length!==1)return {ok:false};
    const matches=[...document.querySelectorAll(w.challenge.resend.selector)].filter(e=>visible(e)&&!e.matches(':disabled')&&e.textContent.toLowerCase().includes(w.challenge.resend.text.toLowerCase()));
    if(matches.length!==1)return {ok:false};const button=matches[0];if(!(button instanceof HTMLButtonElement))return {ok:false};
    button.focus();if(document.activeElement!==button||location.origin!==d.origin)return {ok:false};attempted=true;button.click();return {ok:true,attempted:true,submitted:true};
  }catch{return {ok:false,attempted};}})()`;
}

export function workflowCodeExpression(r) {
  return `(async()=>{const d=${JSON.stringify(r.destination)},w=${JSON.stringify(r.workflow)},code=${JSON.stringify(r.fields.totp)};let attempted=false;try{
    if(location.origin!==d.origin||window.top!==window||document.querySelector('iframe,frame')||Date.now()/1000>=${JSON.stringify(r.deadline)})return {ok:false};
    const matches=document.querySelectorAll(w.challenge.selector);if(matches.length!==1)return {ok:false};const target=matches[0];
    if(!(target instanceof HTMLElement)||!target.getClientRects().length)return {ok:false};
    const inputs=target instanceof HTMLInputElement?[target]:[...target.querySelectorAll('input')];
    if(![1,code.length].includes(inputs.length)||inputs.some(e=>e.type==='password'||e.disabled||e.readOnly||!e.getClientRects().length||e.value!==''))return {ok:false};
    let button;if(w.challenge.submit!=='@auto'){const buttons=document.querySelectorAll(w.challenge.submit);if(buttons.length!==1||!(buttons[0] instanceof HTMLButtonElement)||!buttons[0].getClientRects().length)return {ok:false};button=buttons[0];}
    inputs[0].focus();if(document.activeElement!==inputs[0]||location.origin!==d.origin||Date.now()/1000>=${JSON.stringify(r.deadline)})return {ok:false};attempted=true;
    if(inputs.length===1){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(inputs[0],code);inputs[0].dispatchEvent(new Event('input',{bubbles:true}));inputs[0].dispatchEvent(new Event('change',{bubbles:true}));}
    else{const data=new DataTransfer();data.setData('text',code);target.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));}
    if(button){const until=Math.min(Date.now()+2000,${JSON.stringify(r.deadline)}*1000);while(button.matches(':disabled')&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,20));if(!button.isConnected||document.querySelector(w.challenge.submit)!==button||button.matches(':disabled')||location.origin!==d.origin||Date.now()/1000>=${JSON.stringify(r.deadline)})return {ok:false,attempted};button.click();}
    return {ok:true,attempted:true,submitted:true};
  }catch{return {ok:false,attempted};}})()`;
}

export async function submitAuthWorkflow(request) {
  const failed=(code,sent=false)=>({status:sent?'indeterminate':'failed',verification:'not_verified',input_attempted:sent,action_may_have_run:sent,code});
  try{validateAuthWorkflow(request);}catch{return failed('invalid_workflow_request');}
  return new Promise(resolve=>{const socket=net.connect(SOCK(BROWSERS[request.destination.browser].port));let buffer='',sent=false,done=false;
    const finish=result=>{if(done)return;done=true;socket.destroy();resolve(result);};
    socket.setTimeout(45000,()=>finish(failed('adapter_timeout',sent)));
    socket.on('connect',()=>{sent=true;socket.write(JSON.stringify({reqId:1,op:'vault-workflow',owner:agentId(),label:'protected-auth-workflow',request})+'\n');});
    socket.on('data',chunk=>{buffer+=chunk;if(buffer.length>8192)return finish(failed('adapter_response_invalid',sent));if(!buffer.includes('\n'))return;try{const result=JSON.parse(buffer.split('\n')[0]).result;if(!object(result)||Object.keys(result).some(k=>!['status','verification','input_attempted','action_may_have_run','state','resend_available','code'].includes(k))||!['completed','failed','indeterminate'].includes(result.status)||!['submitted','not_verified'].includes(result.verification)||typeof result.input_attempted!=='boolean'||typeof result.action_may_have_run!=='boolean'||(result.state!==undefined&&!workflowStates.has(result.state))||(result.resend_available!==undefined&&typeof result.resend_available!=='boolean')||(result.code!==undefined&&!/^[a-z_]{1,64}$/.test(result.code)))throw Error();finish(result);}catch{finish(failed('adapter_response_invalid',sent));}});
    socket.on('error',()=>finish(failed('adapter_unavailable',sent)));socket.on('end',()=>finish(failed('adapter_disconnected',sent)));
  });
}

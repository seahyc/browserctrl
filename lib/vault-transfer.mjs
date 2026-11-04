// Protected browser transfer: one private capture, one guarded fill engine for every profile.
import crypto from 'node:crypto';
import net from 'node:net';
import {BROWSERS,SOCK} from './env.mjs';
import {containsSecret,daemonTrusted,testPort} from './vault-fill.mjs';
import {object,exact,originOf,no,validateTransferCapture,validateTransferFill,validateCardCapture,validateCardFill,validTransferFields,TRANSFER_CODES,safeTransferReceipt,sourceSelectors,parseTransferRead,fieldNames,inputTypes,transferForms,normalizeTransfer,cardReference,trustedSource} from './vault-transfer-profiles.mjs';
export {validateReference,validateTransferCapture,validateTransferFill,validTransferFields} from './vault-transfer-profiles.mjs';

const FIND = selector => `(() => { try { const a = document.querySelectorAll(${JSON.stringify(selector)}); return a.length === 1 ? a[0] : null; } catch { return null; } })()`;
const SOURCE_READ = `function(a) { try {
  const visible = e => { if (!e || !e.isConnected || (e.checkVisibility && !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))) return false; const r = e.getBoundingClientRect(), s = getComputedStyle(e); return e.getClientRects().length > 0 && r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  if (window !== window.top || location.origin !== a.origin || this !== document.documentElement) return {code:'origin_mismatch'};
  for (const g of a.guards) { const n = document.querySelectorAll(g.selector); if (n.length !== 1 || !visible(n[0]) || (n[0].textContent || '').replace(/\\s+/g,' ').trim() !== g.text) return {code:'guard_mismatch'}; }
  const values = {};
  for (const [name,selector] of Object.entries(a.selectors)) {
    const nodes = document.querySelectorAll(selector);
    if (nodes.length !== 1 || !visible(nodes[0])) return {code:'source_changed'};
    const el = nodes[0], value = el.localName === 'input' ? el.value : el.textContent;
    if (typeof value !== 'string' || value.length > 8192) return {code:'value_shape_mismatch'};
    Object.defineProperty(values,name,{value,enumerable:true});
  }
  return {ok:true,values};
} catch { return {code:'source_changed'}; } }`;
const FRAME_CHECK = `function(a) { try {
  const n = document.querySelectorAll(a.selector), r = this.getBoundingClientRect(), s = getComputedStyle(this);
  return {ok: location.origin === a.origin && n.length === 1 && n[0] === this && this.localName === 'iframe' && this.isConnected && (!this.checkVisibility || this.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) && this.getClientRects().length > 0 && r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'};
} catch { return {ok:false}; } }`;
const INPUT_CHECK = `function(a) { try {
  const el = this, n = document.querySelectorAll(a.selector), r = el.getBoundingClientRect(), s = getComputedStyle(el);
  if (location.origin !== a.origin) return {code:'origin_mismatch'};
  if (n.length !== 1 || n[0] !== el || !el.isConnected) return {code:'element_changed'};
  if (el.localName !== 'input' || el.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !a.types.includes(el.type)) return {code:'element_kind_mismatch'};
  if (el.disabled || el.matches(':disabled') || el.readOnly || (el.checkVisibility && !el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) || !el.getClientRects().length || !r.width || !r.height || s.visibility === 'hidden' || s.display === 'none') return {code:'element_not_editable'};
  if (a.focus) { el.focus(); if (document.activeElement !== el) return {code:'focus_failed'}; el.select(); }
  if (a.verify && document.activeElement !== el) return {code:'focus_failed'};
  return a.verify || a.read ? {ok:true,value:el.value} : {ok:true};
} catch { return {code:'element_check_failed'}; } }`;
const stable = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(stable) : Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])) : value;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const captureKey = (reference,fields) => hash({reference,fields});
const sourceArgs = reference => ({origin:reference.source.origin,guards:reference.source.guards,selectors:sourceSelectors(reference)});

export function createTransferGate({ fillGate, send, sessionFor, withInput, recording, now = () => Date.now() / 1000 }) {
  const captured = new Map();
  const primitives = fillGate.transfer || fillGate.card;
  const collect = () => { for (const [k, c] of captured) if (c.deadline <= now() || !fillGate.tainted(c.targetId)) captured.delete(k); };
  const call = async (sid, objectId, declaration, value) => {
    const r = await send('Runtime.callFunctionOn', {objectId, functionDeclaration: declaration, arguments: [{value}], returnByValue: true}, sid, 5000);
    return r.exceptionDetails ? {code:'element_check_failed'} : r.result?.value || {code:'element_check_failed'};
  };
  const find = async (sid, frameId, selector) => {
    const {executionContextId} = await send('Page.createIsolatedWorld', {frameId, worldName:'browserctrl-vault'}, sid, 5000);
    const r = await send('Runtime.evaluate', {expression:FIND(selector), contextId:executionContextId, returnByValue:false}, sid, 5000);
    if (r.result?.subtype !== 'node') throw Error('element_not_found');
    return r.result.objectId;
  };
  const release = (sid, objectId) => send('Runtime.releaseObject', {objectId}, sid, 5000).catch(() => {});
  const dedicated = async id => primitives.created(id) || (await send('Page.getNavigationHistory', {}, await sessionFor(id), 5000)).entries?.length === 1;
  const taintValues = (id, fields, reference, owner, browser, origin, loaderId, extra = []) => {
    for (const value of [...transferForms(fields,reference), ...extra]) primitives.taint(id, {value, field:'password', destination:{browser,origins:[origin]}}, owner, loaderId);
  };
  // Each hop is tied to the approved parent DOM iframe's frameId. An origin search is
  // never sufficient to attach a frame target, including out-of-process frames.
  const resolve = async (targetId, d, spec, field, reference, expected) => {
    let sid = await sessionFor(targetId);
    const top = await send('Page.getFrameTree', {}, sid, 5000);
    if (originOf(top.frameTree.frame.url) !== d.origin) throw Error('origin_mismatch');
    let frameId = top.frameTree.frame.id, origin = d.origin;
    const chain = [{frameId, loaderId:top.frameTree.frame.loaderId}], targets = [targetId];
    const targetFrames = [{targetId,origin:d.origin,loaderId:top.frameTree.frame.loaderId}];
    for (const hop of spec.frames) {
      const objectId = await find(sid, frameId, hop.selector);
      let node;
      try {
        if (!(await call(sid, objectId, FRAME_CHECK, {selector:hop.selector,origin})).ok) throw Error('frame_changed');
        ({node} = await send('DOM.describeNode', {objectId}, sid, 5000));
      } finally { await release(sid, objectId); }
      if (!node.frameId || node.localName !== 'iframe') throw Error('frame_changed');
      frameId = node.frameId; let attached = false;
      try { await send('Page.createIsolatedWorld', {frameId,worldName:'browserctrl-vault'}, sid, 5000); }
      catch {
        const {targetInfo} = await send('Target.getTargetInfo', {targetId:frameId}, undefined, 5000);
        if (targetInfo?.type !== 'iframe' || targetInfo.targetId !== frameId || originOf(targetInfo.url) !== hop.origin) throw Error('frame_changed');
        sid = await sessionFor(frameId); targets.push(frameId); attached = true;
      }
      const tree = await send('Page.getFrameTree', {}, sid, 5000);
      const frames = nodeTree(tree.frameTree), frame = frames.find(f => f.id === frameId);
      if (!frame || originOf(frame.url) !== hop.origin) throw Error('origin_mismatch');
      if (attached) targetFrames.push({targetId:frameId,origin:hop.origin,loaderId:frame.loaderId});
      chain.push({frameId,loaderId:frame.loaderId}); origin = hop.origin;
    }
    if (expected && JSON.stringify(chain) !== JSON.stringify(expected.chain)) throw Error('frame_changed');
    const objectId = await find(sid, frameId, spec.selector);
    const args = {origin,selector:spec.selector,types:inputTypes(reference,d,field)};
    const check = await call(sid, objectId, INPUT_CHECK, args);
    if (!check.ok) { await release(sid, objectId); throw Error(check.code || 'element_check_failed'); }
    const {node} = await send('DOM.describeNode', {objectId}, sid, 5000);
    if (expected && node.backendNodeId !== expected.backendNodeId) { await release(sid, objectId); throw Error('element_changed'); }
    return {sid,objectId,args,chain,targets,targetFrames,backendNodeId:node.backendNodeId,loaderId:top.frameTree.frame.loaderId};
  };
  const codes = new Set(['origin_mismatch','element_not_found','frame_changed','element_changed','element_kind_mismatch','element_not_editable','focus_failed','element_check_failed']);
  const gate = {
    async capture(request, owner, {claimOf,authorize}) {
      try { validateTransferCapture(request, now()); } catch { return no('invalid_request'); }
      const reference = request.reference, s = reference.source;
      if (owner !== s.tab_owner) return no('tab_not_owned');
      if (recording()) return no('capture_or_action_active');
      let targetId, sid, objectId;
      try {
        const {targetInfos} = await send('Target.getTargets', {}, undefined, 5000);
        const targets = targetInfos.filter(t => t.type === 'page' && claimOf(t.targetId) === owner && originOf(t.url) === s.origin);
        if (!targets.length) return no('tab_not_found');
        if (targets.length !== 1) return no('tab_ambiguous');
        targetId = targets[0].targetId;
        if (fillGate.hasOrphan(targetId) || (fillGate.tainted(targetId) && primitives.owner(targetId) !== owner)) return no('tab_tainted');
        if (!await dedicated(targetId)) return no('tab_not_dedicated');
        const denied = authorize(targetId); if (denied) return no(denied);
        const used = primitives.useRequestId(request.request_id); if (used) return no(used);
        sid = await sessionFor(targetId);
        const {frameTree} = await send('Page.getFrameTree', {}, sid, 5000);
        if (originOf(frameTree.frame.url) !== s.origin) return no('origin_mismatch');
        objectId = await find(sid, frameTree.frame.id, 'html');
        if (recording()) return no('capture_or_action_active');
        if (now() >= request.deadline) return no('deadline_passed');
        if (claimOf(targetId) !== owner) return no('tab_not_owned');
        const read = await call(sid, objectId, SOURCE_READ, sourceArgs(reference));
        if (!read.ok) return no(['origin_mismatch','source_changed','guard_mismatch','value_shape_mismatch'].includes(read.code) ? read.code : 'source_changed');
        if (Object.values(read.values).some(value => containsSecret(value,primitives.secrets()))) return no('prior_secret_present');
        if (now() >= request.deadline) return no('deadline_passed');
        const fields = parseTransferRead(read.values,reference);
        if (!fields) return no(reference.profile === 'payment-card' ? 'card_shape_mismatch' : 'value_shape_mismatch');
        if (Object.values(fields).some(value => containsSecret(value,primitives.secrets()))) return no('prior_secret_present');
        taintValues(targetId, fields, reference, owner, s.browser, s.origin, frameTree.frame.loaderId, Object.values(read.values));
        collect(); captured.set(captureKey(reference,fields), {targetId, owner, browser:s.browser, origin:s.origin, reference:structuredClone(reference), loaderId:frameTree.frame.loaderId, deadline:Math.min(request.deadline,now()+120)});
        return {status:'completed',verification:'captured',fields};
      } catch { return no('capture_failed'); }
      finally { if (objectId) await release(sid, objectId); }
    },
    async fill(request, owner, {claimOf,authorize}) {
      try { validateTransferFill(request, now()); } catch { return no('invalid_request',false); }
      const reference = request.reference, d = request.destination, targetId = d.tab_id;
      if (owner !== d.tab_owner) return no('tab_not_owned',false);
      if (recording()) return no('capture_or_action_active',false);
      collect(); const source = trustedSource(reference) ? null : captured.get(captureKey(reference,request.fields));
      if (!trustedSource(reference) && (!source || source.owner !== owner || source.browser !== d.browser)) return no('source_unavailable',false);
      if (source && source.targetId === targetId) return no('destination_is_source',false);
      if (fillGate.hasOrphan(targetId) || (fillGate.tainted(targetId) && primitives.owner(targetId) !== owner)) return no('tab_tainted',false);
      let attempted = false;
      const heldObjects = [];
      try {
        const {targetInfos} = await send('Target.getTargets', {}, undefined, 5000);
        if (!targetInfos.some(t => t.targetId === targetId && t.type === 'page')) return no('tab_not_found',false);
        if (source && (!targetInfos.some(t => t.targetId === source.targetId && t.type === 'page' && originOf(t.url) === source.origin) || claimOf(source.targetId) !== owner || primitives.owner(source.targetId) !== owner)) return no('source_changed',false);
        if (!await dedicated(targetId)) return no('tab_not_dedicated',false);
        for (const id of source ? [source.targetId,targetId] : [targetId]) { const denied = authorize(id); if (denied) return no(denied,false); }
        const used = primitives.useRequestId(request.request_id); if (used) return no(used,false);
        const verifySource = async () => {
          if (!source) return;
          const ssid = await sessionFor(source.targetId), st = await send('Page.getFrameTree', {}, ssid, 5000);
          if (originOf(st.frameTree.frame.url) !== source.origin || st.frameTree.frame.loaderId !== source.loaderId) throw Error('source_changed');
          const obj = await find(ssid,st.frameTree.frame.id,'html');
          try { const read = await call(ssid,obj,SOURCE_READ,sourceArgs(source.reference)); const f = read.ok && parseTransferRead(read.values,source.reference); if (!f || captureKey(source.reference,f) !== captureKey(reference,request.fields)) throw Error('source_changed'); } finally { await release(ssid,obj); }
        };
        await verifySource();
        const resolved = {};
        for (const field of fieldNames(reference)) { resolved[field] = await resolve(targetId,d,d.fields[field],field,reference); heldObjects.push(resolved[field]); }
        if (new Set(Object.values(resolved).map(r => `${r.sid}:${r.backendNodeId}`)).size !== fieldNames(reference).length) return no('element_ambiguous',false);
        const frameTargets = [...new Set(Object.values(resolved).flatMap(r => r.targets))];
        for (const id of frameTargets) if (id !== targetId) { const denied = authorize(id); if (denied) return no(denied,false); }
        return await withInput(targetId, await sessionFor(targetId), async () => {
          const checkState = async () => {
            if (now() >= request.deadline || (source && now() >= source.deadline)) throw Error('deadline_passed');
            if (recording()) throw Error('capture_or_action_active');
            if (claimOf(targetId) !== owner || (source && claimOf(source.targetId) !== owner)) throw Error('tab_not_owned');
            await verifySource();
            for (const id of frameTargets) if (claimOf(id) !== owner) throw Error('tab_not_owned');
          };
          await checkState();
          for (const id of frameTargets) {
            const meta = Object.values(resolved).flatMap(r => r.targetFrames).find(f => f.targetId === id);
            taintValues(id,request.fields,reference,owner,d.browser,meta.origin,meta.loaderId);
          }
          if (source) taintValues(source.targetId,request.fields,reference,owner,source.browser,source.origin,source.loaderId);
          for (const field of fieldNames(reference)) {
            await checkState();
            let current = await resolve(targetId,d,d.fields[field],field,reference,resolved[field]); heldObjects.push(current);
            const focused = await call(current.sid,current.objectId,INPUT_CHECK,{...current.args,focus:true});
            if (!focused.ok) throw Error(focused.code || 'focus_failed');
            // Focus handlers can replace frames or fields. Re-resolve the full ancestry.
            await checkState();
            current = await resolve(targetId,d,d.fields[field],field,reference,resolved[field]); heldObjects.push(current);
            if (!(await call(current.sid,current.objectId,INPUT_CHECK,{...current.args,verify:true})).ok) throw Error('focus_failed');
            attempted = true;
            await send('Input.insertText',{text:request.fields[field]},current.sid,10000);
            let after = await call(current.sid,current.objectId,INPUT_CHECK,{...current.args,verify:true});
            if (after.ok && normalizeTransfer(reference,field,after.value) !== request.fields[field] && after.value?.length > request.fields[field].length) {
              if (!(await call(current.sid,current.objectId,INPUT_CHECK,{...current.args,focus:true})).ok) throw Error('focus_failed');
              for (const character of request.fields[field]) {
                await checkState();
                const checked = await resolve(targetId,d,d.fields[field],field,reference,resolved[field]); heldObjects.push(checked);
                if (!(await call(checked.sid,checked.objectId,INPUT_CHECK,{...checked.args,verify:true})).ok) throw Error('focus_failed');
                await send('Input.dispatchKeyEvent',{type:'char',text:character},checked.sid,10000);
              }
              after = await call(current.sid,current.objectId,INPUT_CHECK,{...current.args,verify:true});
            }
            if (!after.ok || normalizeTransfer(reference,field,after.value) !== request.fields[field]) throw Error('fill_value_mismatch');
            await checkState();
            const last = await resolve(targetId,d,d.fields[field],field,reference,resolved[field]); heldObjects.push(last);
          }
          for (const field of fieldNames(reference)) {
            await checkState();
            const final = await resolve(targetId,d,d.fields[field],field,reference,resolved[field]); heldObjects.push(final);
            const read = await call(final.sid,final.objectId,INPUT_CHECK,{...final.args,read:true});
            if (!read.ok || normalizeTransfer(reference,field,read.value) !== request.fields[field]) throw Error('fill_value_mismatch');
          }
          return {status:'completed',verification:'filled',input_attempted:true,action_may_have_run:false};
        });
      } catch (e) { return no(codes.has(e.message) || ['deadline_passed','capture_or_action_active','tab_not_owned','source_changed','fill_value_mismatch'].includes(e.message) ? e.message : attempted ? 'fill_outcome_uncertain' : 'fill_failed',attempted); }
      finally { for (const r of heldObjects) await release(r.sid,r.objectId); }
    },
  };
  gate.captureCard = async (request,owner,hooks) => {
    try { validateCardCapture(request,now()); } catch { return no('invalid_request'); }
    return gate.capture({version:6,request_id:request.request_id,deadline:request.deadline,reference:cardReference(request.source)},owner,hooks);
  };
  gate.fillCard = async (request,owner,hooks) => {
    try { validateCardFill(request,now()); } catch { return no('invalid_request',false); }
    collect();
    const matches = [...captured.values()].filter(c => c.reference.profile === 'payment-card' && c.owner === owner && c.browser === request.destination.browser && captured.has(captureKey(c.reference,request.fields)));
    if (matches.length !== 1) return no('source_unavailable',false);
    return gate.fill({version:7,request_id:request.request_id,deadline:request.deadline,reference:matches[0].reference,destination:request.destination,fields:request.fields},owner,hooks);
  };
  return gate;
}
const nodeTree = tree => [tree.frame,...(tree.childFrames || []).flatMap(nodeTree)];

export async function submitVaultTransfer(request, {trusted = daemonTrusted, port, legacy = false} = {}) {
  const capture = request?.version === (legacy ? 4 : 6), failure = code => no(code,capture ? undefined : false);
  try { (legacy ? capture ? validateCardCapture : validateCardFill : capture ? validateTransferCapture : validateTransferFill)(request); } catch { return failure('invalid_request'); }
  const reference = legacy ? capture ? cardReference(request.source) : null : request.reference;
  const d = capture ? reference.source : request.destination;
  port ??= testPort() ?? BROWSERS[d.browser].port;
  const sock = SOCK(port);
  return new Promise(resolve => {
    const socket = net.connect(sock); let buf = '', finished = false, sent = false;
    const done = r => { if (finished) return; finished = true; buf = ''; socket.destroy(); resolve(r); };
    const uncertain = code => no(code,capture ? undefined : sent);
    socket.setTimeout(Math.max(5000,Math.min(45000,(request.deadline-Date.now()/1000)*1000+5000)),()=>done(uncertain('adapter_timeout')));
    socket.on('connect',async()=>{
      let ok = false; try { ok = await trusted(sock,port); } catch {}
      if (finished) return;
      if (!ok) return done(failure('daemon_untrusted'));
      sent = true; socket.write(JSON.stringify({reqId:1,op:legacy ? capture ? 'vault-card-capture' : 'vault-card-fill' : capture ? 'vault-transfer-capture' : 'vault-transfer-fill',owner:d.tab_owner,label:'vault-transfer',request})+'\n');
    });
    socket.on('data',chunk=>{
      buf += chunk; if (buf.length > 65536) return done(uncertain('adapter_response_invalid'));
      const nl = buf.indexOf('\n'); if (nl < 0) return;
      try {
        const row = JSON.parse(buf.slice(0,nl)), v = row.result;
        if (row.error !== undefined && v === undefined) return done(failure('daemon_refused'));
        if (capture && exact(v,['status','verification','fields']) && v.status === 'completed' && v.verification === 'captured' && validTransferFields(v.fields,reference)) return done(v);
        if (capture && exact(v,['status','verification','code']) && v.status === 'failed' && v.verification === 'not_verified' && TRANSFER_CODES.has(v.code)) return done(v);
        if (!capture && safeTransferReceipt(v)) return done(v);
        done(uncertain('adapter_response_invalid'));
      } catch { done(uncertain('adapter_response_invalid')); }
    });
    socket.on('error',()=>done(uncertain('adapter_unavailable'))); socket.on('end',()=>done(uncertain('adapter_disconnected')));
  });
}

// Protected card transfer: private v4 capture and v5 trusted input. No page-supplied
// expression, clipboard, logging, submission or secret-bearing persistent state.
import crypto from 'node:crypto';
import net from 'node:net';
import { BROWSERS, SOCK } from './env.mjs';
import { containsSecret, daemonTrusted, testPort } from './vault-fill.mjs';

const object = v => v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const css = v => typeof v === 'string' && v.trim() && v.length <= 512 && !/[\x00-\x1f]/.test(v);
const ownerOk = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const originOk = v => { try { const u = new URL(v); return typeof v === 'string' && u.protocol === 'https:' && u.origin === v && !u.username && !u.password; } catch { return false; } };
const originOf = v => { try { return new URL(v).origin; } catch { return null; } };
const no = (code, attempted) => attempted === undefined ? { status: 'failed', verification: 'not_verified', code }
  : { status: attempted ? 'indeterminate' : 'failed', verification: 'not_verified', input_attempted: attempted, action_may_have_run: false, code };
const base = (r, version, keys, now) => {
  if (!exact(r, keys) || r.version !== version || typeof r.request_id !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(r.request_id) || !Number.isFinite(r.deadline) || r.deadline <= now || r.deadline > now + 120) throw Error('invalid_request');
};
export function luhn(number) {
  if (!/^[0-9]{13,19}$/.test(number) || /^([0-9])\1+$/.test(number)) return false;
  let sum = 0, double = false;
  for (let i = number.length - 1; i >= 0; i--) { let d = +number[i]; if (double && (d *= 2) > 9) d -= 9; sum += d; double = !double; }
  return sum % 10 === 0;
}
export function validCardFields(f) {
  return exact(f, ['number', 'expiry', 'cvc']) && typeof f.number === 'string' && luhn(f.number) && typeof f.expiry === 'string' && /^(0[1-9]|1[0-2])\/[0-9]{2}$/.test(f.expiry) && typeof f.cvc === 'string' && /^[0-9]{3,4}$/.test(f.cvc);
}
export function validateCardCapture(r, now = Date.now() / 1000) {
  base(r, 4, ['version', 'request_id', 'deadline', 'source'], now);
  const s = r.source;
  if (!exact(s, ['browser', 'origin', 'tab_owner', 'element', 'last4', 'expires', 'guards']) || !Object.hasOwn(BROWSERS, s.browser) || !originOk(s.origin) || !ownerOk(s.tab_owner) || !css(s.element) || typeof s.last4 !== 'string' || !/^[0-9]{4}$/.test(s.last4) || typeof s.expires !== 'string' || !/^20[0-9]{2}-(0[1-9]|1[0-2])$/.test(s.expires)) throw Error('invalid_source');
  if (s.expires < new Date(now * 1000).toISOString().slice(0,7)) throw Error('invalid_source');
  if (!Array.isArray(s.guards) || s.guards.length < 1 || s.guards.length > 4 || s.guards.some(g => !exact(g, ['selector', 'text']) || !css(g.selector) || typeof g.text !== 'string' || !g.text.trim() || g.text.length > 512 || /[\x00-\x1f]/.test(g.text))) throw Error('invalid_source');
  return r;
}
export function validateCardFill(r, now = Date.now() / 1000) {
  base(r, 5, ['version', 'request_id', 'deadline', 'destination', 'fields'], now);
  const d = r.destination;
  if (!exact(d, ['browser', 'origin', 'tab_owner', 'fields', 'tab_id']) || !Object.hasOwn(BROWSERS, d.browser) || !originOk(d.origin) || !ownerOk(d.tab_owner) || typeof d.tab_id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(d.tab_id) || !exact(d.fields, ['number', 'expiry', 'cvc'])) throw Error('invalid_destination');
  for (const f of Object.values(d.fields)) if (!exact(f, ['selector', 'frames']) || !css(f.selector) || !Array.isArray(f.frames) || f.frames.length > 3 || f.frames.some(p => !exact(p, ['selector', 'origin']) || !css(p.selector) || !originOk(p.origin))) throw Error('invalid_destination');
  if (!validCardFields(r.fields)) throw Error('invalid_fields');
  return r;
}
// Labels delimit expiry and CVC; the remaining numeric run must be exactly one PAN.
export function parseCard(text, source) {
  if (typeof text !== 'string' || !text || text.length > 8192) return null;
  const expires = [...text.matchAll(/\bExpires\s*:?\s*(0[1-9]|1[0-2])\s*\/\s*([0-9]{4}|[0-9]{2})(?![0-9])/gi)];
  const cvc = [...text.matchAll(/\b(?:CVV2?|CVC)\s*:?\s*([0-9]{3,4})(?![0-9])/gi)];
  if (expires.length !== 1 || cvc.length !== 1) return null;
  const e = expires[0], year = e[2].length === 2 ? `20${e[2]}` : e[2];
  if (`${year}-${e[1]}` !== source.expires) return null;
  const rest = text.replace(e[0], ' ').replace(cvc[0][0], ' ');
  const runs = [...rest.matchAll(/(?<![0-9])[0-9](?:[\s-]*[0-9])*/g)].map(m => m[0].replace(/[\s-]/g, ''));
  const candidates = runs.filter(v => v.length >= 13);
  if (candidates.length !== 1 || !luhn(candidates[0]) || !candidates[0].endsWith(source.last4)) return null;
  return { number: candidates[0], expiry: `${e[1]}/${year.slice(-2)}`, cvc: cvc[0][1] };
}

const FIND = selector => `(() => { try { const a = document.querySelectorAll(${JSON.stringify(selector)}); return a.length === 1 ? a[0] : null; } catch { return null; } })()`;
const SOURCE_READ = `function(a) { try {
  const visible = e => { if (!e || !e.isConnected || (e.checkVisibility && !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))) return false; const r = e.getBoundingClientRect(), s = getComputedStyle(e); return e.getClientRects().length > 0 && r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  if (window !== window.top || location.origin !== a.origin) return {code:'origin_mismatch'};
  const nodes = document.querySelectorAll(a.element);
  if (nodes.length !== 1 || nodes[0] !== this || !visible(this)) return {code:'source_changed'};
  for (const g of a.guards) { const n = document.querySelectorAll(g.selector); if (n.length !== 1 || !visible(n[0]) || (n[0].textContent || '').replace(/\\s+/g,' ').trim() !== g.text) return {code:'guard_mismatch'}; }
  const value = this.localName === 'input' ? this.value : this.textContent;
  return typeof value === 'string' && value.length <= 8192 ? {ok:true,value} : {code:'card_shape_mismatch'};
} catch { return {code:'source_changed'}; } }`;
const FRAME_CHECK = `function(a) { try {
  const n = document.querySelectorAll(a.selector), r = this.getBoundingClientRect(), s = getComputedStyle(this);
  return {ok: location.origin === a.origin && n.length === 1 && n[0] === this && this.localName === 'iframe' && this.isConnected && (!this.checkVisibility || this.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) && this.getClientRects().length > 0 && r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'};
} catch { return {ok:false}; } }`;
const INPUT_CHECK = `function(a) { try {
  const el = this, n = document.querySelectorAll(a.selector), r = el.getBoundingClientRect(), s = getComputedStyle(el);
  if (location.origin !== a.origin) return {code:'origin_mismatch'};
  if (n.length !== 1 || n[0] !== el || !el.isConnected) return {code:'element_changed'};
  if (el.localName !== 'input' || el.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !(a.field === 'cvc' ? ['text','tel','password'] : ['text','tel']).includes(el.type)) return {code:'element_kind_mismatch'};
  if (el.disabled || el.matches(':disabled') || el.readOnly || (el.checkVisibility && !el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) || !el.getClientRects().length || !r.width || !r.height || s.visibility === 'hidden' || s.display === 'none') return {code:'element_not_editable'};
  if (a.focus) { el.focus(); if (document.activeElement !== el) return {code:'focus_failed'}; el.select(); }
  if (a.verify && document.activeElement !== el) return {code:'focus_failed'};
  return a.verify || a.read ? {ok:true,value:el.value} : {ok:true};
} catch { return {code:'element_check_failed'}; } }`;
const hash = fields => crypto.createHash('sha256').update(JSON.stringify([fields.number, fields.expiry, fields.cvc])).digest('hex');
const cardForms = f => [f.number, f.number.match(/.{1,4}/g).join(' '), f.number.match(/.{1,4}/g).join('-'), f.expiry, f.cvc];
const normalize = (field, v) => typeof v !== 'string' ? null : field === 'expiry' ? v.replace(/\s+/g, '') : v.replace(/[\s-]/g, '');

export function createCardGate({ fillGate, send, sessionFor, withInput, recording, now = () => Date.now() / 1000 }) {
  const captured = new Map();
  const primitives = fillGate.card;
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
  const taintCard = (id, fields, owner, browser, origin, loaderId, extra = []) => {
    for (const value of [...cardForms(fields), ...extra]) primitives.taint(id, {value, field:'password', destination:{browser,origins:[origin]}}, owner, loaderId);
  };
  // Each hop is tied to the approved parent DOM iframe's frameId. An origin search is
  // never sufficient to attach a frame target, including out-of-process frames.
  const resolve = async (targetId, d, spec, field, expected) => {
    let sid = await sessionFor(targetId);
    const top = await send('Page.getFrameTree', {}, sid, 5000);
    if (originOf(top.frameTree.frame.url) !== d.origin) throw Error('origin_mismatch');
    let frameId = top.frameTree.frame.id, origin = d.origin;
    const chain = [{frameId, loaderId:top.frameTree.frame.loaderId}], targets = [targetId];
    for (const hop of spec.frames) {
      const objectId = await find(sid, frameId, hop.selector);
      let node;
      try {
        if (!(await call(sid, objectId, FRAME_CHECK, {selector:hop.selector,origin})).ok) throw Error('frame_changed');
        ({node} = await send('DOM.describeNode', {objectId}, sid, 5000));
      } finally { await release(sid, objectId); }
      if (!node.frameId || node.localName !== 'iframe') throw Error('frame_changed');
      frameId = node.frameId;
      try { await send('Page.createIsolatedWorld', {frameId,worldName:'browserctrl-vault'}, sid, 5000); }
      catch {
        const {targetInfo} = await send('Target.getTargetInfo', {targetId:frameId}, undefined, 5000);
        if (targetInfo?.type !== 'iframe' || targetInfo.targetId !== frameId || originOf(targetInfo.url) !== hop.origin) throw Error('frame_changed');
        sid = await sessionFor(frameId); targets.push(frameId);
      }
      const tree = await send('Page.getFrameTree', {}, sid, 5000);
      const frames = nodeTree(tree.frameTree), frame = frames.find(f => f.id === frameId);
      if (!frame || originOf(frame.url) !== hop.origin) throw Error('origin_mismatch');
      chain.push({frameId,loaderId:frame.loaderId}); origin = hop.origin;
    }
    if (expected && JSON.stringify(chain) !== JSON.stringify(expected.chain)) throw Error('frame_changed');
    const objectId = await find(sid, frameId, spec.selector);
    const args = {origin,selector:spec.selector,field};
    const check = await call(sid, objectId, INPUT_CHECK, args);
    if (!check.ok) { await release(sid, objectId); throw Error(check.code || 'element_check_failed'); }
    const {node} = await send('DOM.describeNode', {objectId}, sid, 5000);
    if (expected && node.backendNodeId !== expected.backendNodeId) { await release(sid, objectId); throw Error('element_changed'); }
    return {sid,objectId,args,chain,targets,backendNodeId:node.backendNodeId,loaderId:top.frameTree.frame.loaderId};
  };
  const codes = new Set(['origin_mismatch','element_not_found','frame_changed','element_changed','element_kind_mismatch','element_not_editable','focus_failed','element_check_failed']);
  return {
    async capture(request, owner, {claimOf,authorize}) {
      try { validateCardCapture(request, now()); } catch { return no('invalid_request'); }
      const s = request.source;
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
        objectId = await find(sid, frameTree.frame.id, s.element);
        if (recording()) return no('capture_or_action_active');
        if (now() >= request.deadline) return no('deadline_passed');
        if (claimOf(targetId) !== owner) return no('tab_not_owned');
        const read = await call(sid, objectId, SOURCE_READ, s);
        if (!read.ok) return no(['origin_mismatch','source_changed','guard_mismatch','card_shape_mismatch'].includes(read.code) ? read.code : 'source_changed');
        if (containsSecret(read.value, primitives.secrets())) return no('prior_secret_present');
        if (now() >= request.deadline) return no('deadline_passed');
        const fields = parseCard(read.value, s);
        if (!fields) return no('card_shape_mismatch');
        if (Object.values(fields).some(value => containsSecret(value,primitives.secrets()))) return no('prior_secret_present');
        taintCard(targetId, fields, owner, s.browser, s.origin, frameTree.frame.loaderId, [read.value]);
        collect(); captured.set(hash(fields), {targetId, owner, browser:s.browser, origin:s.origin, source:structuredClone(s), loaderId:frameTree.frame.loaderId, deadline:Math.min(request.deadline,now()+120)});
        return {status:'completed',verification:'captured',fields};
      } catch { return no('capture_failed'); }
      finally { if (objectId) await release(sid, objectId); }
    },
    async fill(request, owner, {claimOf,authorize}) {
      try { validateCardFill(request, now()); } catch { return no('invalid_request',false); }
      const d = request.destination, targetId = d.tab_id;
      if (owner !== d.tab_owner) return no('tab_not_owned',false);
      if (recording()) return no('capture_or_action_active',false);
      collect(); const source = captured.get(hash(request.fields));
      if (!source || source.owner !== owner || source.browser !== d.browser) return no('source_unavailable',false);
      if (source.targetId === targetId) return no('destination_is_source',false);
      if (fillGate.hasOrphan(targetId) || (fillGate.tainted(targetId) && primitives.owner(targetId) !== owner)) return no('tab_tainted',false);
      let attempted = false;
      const heldObjects = [];
      try {
        const {targetInfos} = await send('Target.getTargets', {}, undefined, 5000);
        if (!targetInfos.some(t => t.targetId === targetId && t.type === 'page')) return no('tab_not_found',false);
        if (!targetInfos.some(t => t.targetId === source.targetId && t.type === 'page' && originOf(t.url) === source.origin) || claimOf(source.targetId) !== owner || primitives.owner(source.targetId) !== owner) return no('source_changed',false);
        if (!await dedicated(targetId)) return no('tab_not_dedicated',false);
        for (const id of [source.targetId,targetId]) { const denied = authorize(id); if (denied) return no(denied,false); }
        const used = primitives.useRequestId(request.request_id); if (used) return no(used,false);
        const sourceTree = await send('Page.getFrameTree', {}, await sessionFor(source.targetId), 5000);
        if (originOf(sourceTree.frameTree.frame.url) !== source.origin || sourceTree.frameTree.frame.loaderId !== source.loaderId) return no('source_changed',false);
        const verifySource = async () => {
          const ssid = await sessionFor(source.targetId), st = await send('Page.getFrameTree', {}, ssid, 5000);
          if (originOf(st.frameTree.frame.url) !== source.origin || st.frameTree.frame.loaderId !== source.loaderId) throw Error('source_changed');
          const obj = await find(ssid,st.frameTree.frame.id,source.source.element);
          try { const read = await call(ssid,obj,SOURCE_READ,source.source); const f = read.ok && parseCard(read.value,source.source); if (!f || hash(f) !== hash(request.fields)) throw Error('source_changed'); } finally { await release(ssid,obj); }
        };
        await verifySource();
        const resolved = {};
        for (const field of ['number','expiry','cvc']) { resolved[field] = await resolve(targetId,d,d.fields[field],field); heldObjects.push(resolved[field]); }
        if (new Set(Object.values(resolved).map(r => `${r.sid}:${r.backendNodeId}`)).size !== 3) return no('element_ambiguous',false);
        const frameTargets = [...new Set(Object.values(resolved).flatMap(r => r.targets))];
        for (const id of frameTargets) if (id !== targetId) { const denied = authorize(id); if (denied) return no(denied,false); }
        return await withInput(targetId, await sessionFor(targetId), async () => {
          const checkState = async () => {
            if (now() >= request.deadline || now() >= source.deadline) throw Error('deadline_passed');
            if (recording()) throw Error('capture_or_action_active');
            if (claimOf(targetId) !== owner || claimOf(source.targetId) !== owner) throw Error('tab_not_owned');
            await verifySource();
            for (const id of frameTargets) if (claimOf(id) !== owner) throw Error('tab_not_owned');
          };
          await checkState();
          for (const id of frameTargets) {
            const route = Object.values(resolved).find(r => r.targets.includes(id));
            const last = route.chain.at(-1);
            taintCard(id,request.fields,owner,d.browser,id === targetId ? d.origin : route.args.origin,id === targetId ? resolved.number.loaderId : last.loaderId);
          }
          taintCard(source.targetId,request.fields,owner,source.browser,source.origin,source.loaderId);
          for (const field of ['number','expiry','cvc']) {
            await checkState();
            let current = await resolve(targetId,d,d.fields[field],field,resolved[field]); heldObjects.push(current);
            const focused = await call(current.sid,current.objectId,INPUT_CHECK,{...current.args,focus:true});
            if (!focused.ok) throw Error(focused.code || 'focus_failed');
            // Focus handlers can replace frames or fields. Re-resolve the full ancestry.
            await checkState();
            current = await resolve(targetId,d,d.fields[field],field,resolved[field]); heldObjects.push(current);
            if (!(await call(current.sid,current.objectId,INPUT_CHECK,{...current.args,verify:true})).ok) throw Error('focus_failed');
            attempted = true;
            await send('Input.insertText',{text:request.fields[field]},current.sid,10000);
            let after = await call(current.sid,current.objectId,INPUT_CHECK,{...current.args,verify:true});
            if (after.ok && normalize(field,after.value) !== request.fields[field] && after.value?.length > request.fields[field].length) {
              if (!(await call(current.sid,current.objectId,INPUT_CHECK,{...current.args,focus:true})).ok) throw Error('focus_failed');
              for (const character of request.fields[field]) {
                await checkState();
                const checked = await resolve(targetId,d,d.fields[field],field,resolved[field]); heldObjects.push(checked);
                if (!(await call(checked.sid,checked.objectId,INPUT_CHECK,{...checked.args,verify:true})).ok) throw Error('focus_failed');
                await send('Input.dispatchKeyEvent',{type:'char',text:character},checked.sid,10000);
              }
              after = await call(current.sid,current.objectId,INPUT_CHECK,{...current.args,verify:true});
            }
            if (!after.ok || normalize(field,after.value) !== request.fields[field]) throw Error('fill_value_mismatch');
            await checkState();
            const last = await resolve(targetId,d,d.fields[field],field,resolved[field]); heldObjects.push(last);
          }
          for (const field of ['number','expiry','cvc']) {
            await checkState();
            const final = await resolve(targetId,d,d.fields[field],field,resolved[field]); heldObjects.push(final);
            const read = await call(final.sid,final.objectId,INPUT_CHECK,{...final.args,read:true});
            if (!read.ok || normalize(field,read.value) !== request.fields[field]) throw Error('fill_value_mismatch');
          }
          return {status:'completed',verification:'filled',input_attempted:true,action_may_have_run:false};
        });
      } catch (e) { return no(codes.has(e.message) || ['deadline_passed','capture_or_action_active','tab_not_owned','source_changed','fill_value_mismatch'].includes(e.message) ? e.message : attempted ? 'fill_outcome_uncertain' : 'fill_failed',attempted); }
      finally { for (const r of heldObjects) await release(r.sid,r.objectId); }
    },
  };
}
const nodeTree = tree => [tree.frame,...(tree.childFrames || []).flatMap(nodeTree)];

export async function submitVaultCard(request, {trusted = daemonTrusted, port} = {}) {
  const capture = request?.version === 4, failure = code => no(code,capture ? undefined : false);
  try { (capture ? validateCardCapture : validateCardFill)(request); } catch { return failure('invalid_request'); }
  const d = capture ? request.source : request.destination;
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
      sent = true; socket.write(JSON.stringify({reqId:1,op:capture?'vault-card-capture':'vault-card-fill',owner:d.tab_owner,label:'vault-card',request})+'\n');
    });
    socket.on('data',chunk=>{
      buf += chunk; if (buf.length > 65536) return done(uncertain('adapter_response_invalid'));
      const nl = buf.indexOf('\n'); if (nl < 0) return;
      try {
        const row = JSON.parse(buf.slice(0,nl)), v = row.result;
        if (row.error !== undefined && v === undefined) return done(failure('daemon_refused'));
        if (capture && exact(v,['status','verification','fields']) && v.status === 'completed' && v.verification === 'captured' && validCardFields(v.fields) && v.fields.number.endsWith(d.last4) && v.fields.expiry === `${d.expires.slice(5)}/${d.expires.slice(2,4)}`) return done(v);
        if (capture && exact(v,['status','verification','code']) && v.status === 'failed' && v.verification === 'not_verified' && typeof v.code === 'string' && /^[a-z_]{1,64}$/.test(v.code)) return done(v);
        if (!capture && object(v) && Object.keys(v).every(k=>['status','verification','input_attempted','action_may_have_run','code'].includes(k)) && ['completed','failed','indeterminate'].includes(v.status) && ['filled','not_verified'].includes(v.verification) && typeof v.input_attempted === 'boolean' && v.action_may_have_run === false && (v.code === undefined || /^[a-z_]{1,64}$/.test(v.code)) && (v.status === 'completed' ? v.verification === 'filled' && v.input_attempted && v.code === undefined : v.verification === 'not_verified' && typeof v.code === 'string' && (v.status === 'indeterminate' ? v.input_attempted : !v.input_attempted))) return done(v);
        done(uncertain('adapter_response_invalid'));
      } catch { done(uncertain('adapter_response_invalid')); }
    });
    socket.on('error',()=>done(uncertain('adapter_unavailable'))); socket.on('end',()=>done(uncertain('adapter_disconnected')));
  });
}

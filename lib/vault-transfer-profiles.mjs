// Value shapes and readback rules for the shared protected-transfer engine.
import {BROWSERS} from './env.mjs';

export const object = v => v && typeof v === 'object' && !Array.isArray(v);
export const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export const css = v => typeof v === 'string' && v.trim() && v.length <= 512 && !/[\x00-\x1f]/.test(v);
export const ownerOk = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
export const originOk = v => { try { const u = new URL(v); return typeof v === 'string' && u.protocol === 'https:' && u.origin === v && !u.username && !u.password; } catch { return false; } };
export const originOf = v => { try { return new URL(v).origin; } catch { return null; } };
export const no = (code, attempted) => attempted === undefined ? { status: 'failed', verification: 'not_verified', code }
  : { status: attempted ? 'indeterminate' : 'failed', verification: 'not_verified', input_attempted: attempted, action_may_have_run: false, code };
export const base = (r, version, keys, now) => {
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

const namesOk = fields => object(fields) && Object.keys(fields).length >= 1 && Object.keys(fields).length <= 8 && Object.keys(fields).every(k => /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k));
const guardsOk = guards => Array.isArray(guards) && guards.length >= 1 && guards.length <= 4 && guards.every(g => exact(g,['selector','text']) && css(g.selector) && typeof g.text === 'string' && g.text.trim() && g.text.length <= 512 && !/[\x00-\x1f]/.test(g.text));
const destinationBase = d => Object.hasOwn(BROWSERS,d.browser) && originOk(d.origin) && ownerOk(d.tab_owner) && typeof d.tab_id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(d.tab_id);
export const vaultSource = reference => reference?.profile === 'fields' && reference.source?.kind === 'vault';
export const trustedSource = reference => vaultSource(reference) || (['fields','payment-card'].includes(reference?.profile) && reference.source?.kind === 'provider');
const fieldShapeOk = (spec,selector) => exact(spec,selector ? ['selector','format','min_length','max_length','prefix'] : ['format','min_length','max_length','prefix']) && (!selector || css(spec.selector)) && ['text','token','digits'].includes(spec.format) && Number.isInteger(spec.min_length) && Number.isInteger(spec.max_length) && spec.min_length >= 1 && spec.min_length <= spec.max_length && spec.max_length <= 1024 && typeof spec.prefix === 'string' && !/[\x00-\x1f\x7f]/.test(spec.prefix) && [...spec.prefix].length <= 32 && [...spec.prefix].length <= spec.max_length;
const vaultRefOk = value => typeof value === 'string' && /^vault:\/\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\/item\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}#(?:username|password|totp|notes)$/.test(value);
export function validateReference(reference, now = Date.now()/1000) {
  if (!exact(reference,['profile','source'])) throw Error('invalid_reference');
  const s = reference.source;
  if (reference.source?.kind === 'provider') {
    if (typeof s.id !== 'string' || !/^[0-9a-f]{64}$/.test(s.id)) throw Error('invalid_source');
    if (reference.profile === 'payment-card') {
      if (!exact(s,['kind','id','last4','expires']) || typeof s.last4 !== 'string' || !/^[0-9]{4}$/.test(s.last4) || typeof s.expires !== 'string' || !/^20[0-9]{2}-(0[1-9]|1[0-2])$/.test(s.expires) || s.expires < new Date(now*1000).toISOString().slice(0,7)) throw Error('invalid_source');
    } else if (reference.profile !== 'fields' || !exact(s,['kind','id','fields']) || !namesOk(s.fields) || Object.values(s.fields).some(spec => !fieldShapeOk(spec,false))) throw Error('invalid_source');
    return reference;
  }
  if (reference.profile === 'payment-card') {
    validateCardCapture({version:4,request_id:'validate_reference',deadline:now+60,source:s},now);
    return reference;
  }
  if (vaultSource(reference)) {
    if (!exact(s,['kind','refs','fields']) || !namesOk(s.fields) || !exact(s.refs,Object.keys(s.fields)) || Object.values(s.refs).some(ref => !vaultRefOk(ref)) || Object.values(s.fields).some(spec => !fieldShapeOk(spec,false))) throw Error('invalid_source');
    return reference;
  }
  if (reference.profile !== 'fields' || !exact(s,['browser','origin','tab_owner','guards','fields']) || !Object.hasOwn(BROWSERS,s.browser) || !originOk(s.origin) || !ownerOk(s.tab_owner) || !guardsOk(s.guards) || !namesOk(s.fields)) throw Error('invalid_source');
  if (Object.values(s.fields).some(spec => !fieldShapeOk(spec,true))) throw Error('invalid_source');
  return reference;
}
export function validateTransferCapture(r, now = Date.now()/1000) {
  base(r,6,['version','request_id','deadline','reference'],now);validateReference(r.reference,now);if (trustedSource(r.reference)) throw Error('invalid_source');return r;
}
export function validateTransferFill(r, now = Date.now()/1000) {
  base(r,7,['version','request_id','deadline','reference','destination','fields'],now);validateReference(r.reference,now);
  const d = r.destination,s = r.reference.source;
  if (!exact(d,['browser','origin','tab_owner','fields','tab_id']) || !destinationBase(d) || (!trustedSource(r.reference) && (d.browser !== s.browser || d.tab_owner !== s.tab_owner))) throw Error('invalid_destination');
  if (r.reference.profile === 'payment-card') validateCardFill({version:5,request_id:r.request_id,deadline:r.deadline,destination:d,fields:r.fields},now);
  else {
    if (!namesOk(d.fields) || Object.keys(d.fields).sort().join() !== Object.keys(s.fields).sort().join()) throw Error('invalid_destination');
    for (const spec of Object.values(d.fields)) if (!exact(spec,['selector','frames','input_type']) || !css(spec.selector) || !['text','password','tel'].includes(spec.input_type) || !Array.isArray(spec.frames) || spec.frames.length > 3 || spec.frames.some(p => !exact(p,['selector','origin']) || !css(p.selector) || !originOk(p.origin))) throw Error('invalid_destination');
  }
  if (!validTransferFields(r.fields,r.reference)) throw Error('invalid_fields');
  return r;
}
export function validTransferFields(fields, reference) {
  if (reference.profile === 'payment-card') {
    const s = reference.source;
    return validCardFields(fields) && fields.number.endsWith(s.last4) && fields.expiry === `${s.expires.slice(5)}/${s.expires.slice(2,4)}`;
  }
  const specs = reference.source.fields;
  if (!exact(fields,Object.keys(specs)) || Buffer.byteLength(JSON.stringify(fields),'utf8') > 6144) return false;
  return Object.entries(specs).every(([name,spec]) => {
    const value = fields[name];
    if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value) || [...value].length < spec.min_length || [...value].length > spec.max_length || !value.startsWith(spec.prefix)) return false;
    return spec.format === 'text' || (spec.format === 'token' ? /^[\x21-\x7e]+$/.test(value) : /^[0-9]+$/.test(value));
  });
}
export const sourceSelectors = reference => reference.profile === 'payment-card' ? {card:reference.source.element} : Object.fromEntries(Object.entries(reference.source.fields).map(([name,spec])=>[name,spec.selector]));
export function parseTransferRead(values,reference) {
  if (reference.profile === 'payment-card') return parseCard(values.card,reference.source);
  return validTransferFields(values,reference) ? values : null;
}
export const fieldNames = reference => reference.profile === 'payment-card' ? ['number','expiry','cvc'] : Object.keys(reference.source.fields);
export const inputTypes = (reference,destination,field) => reference.profile === 'payment-card' ? field === 'cvc' ? ['text','tel','password'] : ['text','tel'] : [destination.fields[field].input_type];
export const transferForms = (fields,reference) => reference.profile === 'payment-card' ? [fields.number,fields.number.match(/.{1,4}/g).join(' '),fields.number.match(/.{1,4}/g).join('-'),fields.expiry,fields.cvc] : Object.values(fields);
export const normalizeTransfer = (reference,field,value) => typeof value !== 'string' ? null : reference.profile === 'fields' ? value : field === 'expiry' ? value.replace(/\s+/g,'') : value.replace(/[\s-]/g,'');
export const cardReference = source => ({profile:'payment-card',source});
export const TRANSFER_CODES = new Set(['invalid_request','tab_not_owned','capture_or_action_active','tab_not_found','tab_ambiguous','tab_tainted','tab_not_dedicated','action_active','journal_unavailable','request_already_used','journal_full','origin_mismatch','deadline_passed','source_changed','guard_mismatch','value_shape_mismatch','card_shape_mismatch','prior_secret_present','capture_failed','source_unavailable','destination_is_source','element_not_found','frame_changed','element_changed','element_kind_mismatch','element_not_editable','focus_failed','element_check_failed','element_ambiguous','fill_value_mismatch','fill_outcome_uncertain','fill_failed','adapter_timeout','adapter_response_invalid','daemon_untrusted','daemon_refused','adapter_unavailable','adapter_disconnected']);
export function safeTransferReceipt(v) {
  if (!object(v) || !Object.keys(v).every(k=>['status','verification','input_attempted','action_may_have_run','code'].includes(k)) || !['completed','failed','indeterminate'].includes(v.status) || typeof v.input_attempted !== 'boolean' || v.action_may_have_run !== false) return false;
  if (v.status === 'completed') return exact(v,['status','verification','input_attempted','action_may_have_run']) && v.verification === 'filled' && v.input_attempted;
  return exact(v,['status','verification','input_attempted','action_may_have_run','code']) && v.verification === 'not_verified' && TRANSFER_CODES.has(v.code) && (v.status === 'indeterminate' ? v.input_attempted : !v.input_attempted);
}

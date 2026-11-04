import './isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateCardCapture,validateCardFill,parseCard,luhn,validCardFields,submitVaultCard} from '../lib/vault-card.mjs';
import {createRedactor} from '../lib/vault-fill.mjs';
const fields = {number:'4242424242424242',expiry:'12/30',cvc:'123'};
const source = {browser:'dia',origin:'https://cards.example.com',tab_owner:'test-owner',element:'#card',last4:'4242',expires:'2030-12',guards:[{selector:'#owner',text:'Owner test'}]};
const capture = () => ({version:4,request_id:crypto.randomUUID(),deadline:Date.now()/1000+60,source:structuredClone(source)});
const fill = () => ({version:5,request_id:crypto.randomUUID(),deadline:Date.now()/1000+60,destination:{browser:'dia',origin:'https://checkout.example.com',tab_owner:'test-owner',tab_id:'ABCDEF1234567890',fields:Object.fromEntries(['number','expiry','cvc'].map(k=>[k,{selector:'#'+k,frames:[]}]))},fields:{...fields}});
test('card parsing requires one Luhn PAN, exact last4, one labeled expiry and CVC',()=>{
  for (const display of ['4242424242424242 Expires 12/30 CVC 123','Card 4242 4242 4242 4242\nExpires: 12/2030\nCVV2: 123','4242-4242-4242-4242 Expires 12/30 CVV 123']) assert.deepEqual(parseCard(display,source),fields);
  for (const display of ['4242424242424241 Expires 12/30 CVC 123','4242424242424242 Expires 11/30 CVC 123','4242424242424242 Expires 12/30 CVC 123 CVC 456','4242424242424242 4242424242424242 Expires 12/30 CVC 123','42424242424242424242 Expires 12/30 CVC 123','4242424242424242 12/30 123','4242424242424242 Expires 12/30 CVC 12345']) assert.equal(parseCard(display,source),null,display);
  assert.equal(parseCard('4242424242424242 Expires 12/30 CVC 123',{...source,last4:'0000'}),null);
  assert.ok(luhn(fields.number)); assert.ok(!luhn('0000000000000000')); assert.ok(!validCardFields({...fields,extra:'no'}));
});
test('v4/v5 validation is exact, HTTPS-only, bounded and selector-only',()=>{
  assert.equal(validateCardCapture(capture()).version,4); assert.equal(validateCardFill(fill()).version,5);
  const invalidCapture=[r=>r.extra=1,r=>r.deadline=0,r=>r.source.browser='safari',r=>r.source.origin='http://cards.example.com',r=>r.source.element={selector:'#card'},r=>r.source.element='x'.repeat(513),r=>r.source.guards=[],r=>r.source.guards[0].text='',r=>r.source.last4='12345',r=>r.source.expires='2030-13',r=>r.source.expires='2020-01'];
  for(const change of invalidCapture){const r=capture();change(r);assert.throws(()=>validateCardCapture(r));}
  const invalidFill=[r=>r.destination.tab_owner='bad owner',r=>r.destination.origin+='/',r=>r.fields.number='4242424242424241',r=>r.fields.cvc='1',r=>r.destination.fields.number.frames=[{selector:'iframe',origin:'http://x.test'}],r=>r.destination.fields.cvc.frames=Array.from({length:4},()=>({selector:'iframe',origin:'https://x.test'})),r=>r.destination.fields.number.extra='no'];
  for(const change of invalidFill){const r=fill();change(r);assert.throws(()=>validateCardFill(r));}
});
test('ordinary redaction covers arbitrary whitespace and hyphen PAN display',()=>{
  const redact=createRedactor([fields.number,fields.cvc]);
  for(const s of [fields.number,'4242 4242 4242 4242','4242-4242-4242-4242','42\n42 4242-4242\t4242','4 2 4 2 4 2 4 2 4 2 4 2 4 2 4 2']) assert.equal(redact(s),'[redacted]');
  assert.equal(redact({value:'CVC 123'}).value,'CVC [redacted]');
  assert.equal(createRedactor(['1234567890123456','123'])('12345678 90123456'),'[redacted]');
});
test('invalid card request never connects; implementation has no clipboard or process launch',async()=>{
  assert.equal((await submitVaultCard({...capture(),source:{...source,origin:'http://bad.test'}})).code,'invalid_request');
  const text=fs.readFileSync(new URL('../lib/vault-card.mjs',import.meta.url),'utf8');
  assert.ok(!/clipboard|pbcopy|pbpaste|execFile|spawn\(/i.test(text.replace(/^\/\/.*$/gm,'')));
});

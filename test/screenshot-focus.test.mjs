import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {screenshot} from '../lib/ops.mjs';

for (const fails of [false,true]) test(`optional screenshot focus emulation is cleared after ${fails ? 'failure' : 'success'}`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'browserctrl-focus-shot-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const calls=[];
  const conn={async send(target,method,params){
    calls.push({target,method,params});
    if (method==='Page.captureScreenshot') {
      if(fails) throw new Error('capture failed');
      return {data:Buffer.from('owned test image').toString('base64')};
    }
    if(method==='Runtime.evaluate') return {result:{value:1}};
    return {};
  }};
  const pending=screenshot(conn,'owned-tab',{path:path.join(directory,'shot.png'),emulateFocus:true});
  if(fails) await assert.rejects(pending,/capture failed/); else await pending;
  assert.deepEqual(calls.filter(row=>row.method==='Emulation.setFocusEmulationEnabled').map(row=>row.params.enabled),[true,false]);
  assert.ok(calls.every(row=>row.target==='owned-tab'));
  assert.ok(!calls.some(row=>/activate|bringToFront/.test(row.method)),'capture must not activate a tab/window');
});

test('screenshot reports failure to clear focus emulation',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'browserctrl-focus-reset-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const conn={async send(target,method,params){
    if(method==='Emulation.setFocusEmulationEnabled' && !params.enabled) throw new Error('reset refused');
    if(method==='Page.captureScreenshot') return {data:Buffer.from('owned test image').toString('base64')};
    if(method==='Runtime.evaluate') return {result:{value:1}};
    return {};
  }};
  await assert.rejects(screenshot(conn,'owned-tab',{path:path.join(directory,'shot.png'),emulateFocus:true}),/could not be disabled/);
});

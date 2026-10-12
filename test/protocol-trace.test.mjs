import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createProtocolTrace,protocolSummary} from '../lib/protocol-trace.mjs';
test('protocol trace excludes payloads and captures lifecycle identifiers',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cdp-trace-'));
 try {
  const file=path.join(dir,'trace.jsonl'); const trace=createProtocolTrace(file,9223);
  trace('send',{id:1,method:'Runtime.evaluate',params:{targetId:'tab1',expression:'PRIVATE',url:'PRIVATE',headers:{Authorization:'PRIVATE'},cookies:['PRIVATE']}});
  trace('reply',{id:1,result:{result:{value:'PRIVATE'},browserContextId:'ctx1'}});
  const text=fs.readFileSync(file,'utf8');assert.ok(!text.includes('PRIVATE'));
  const rows=text.trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows[0].params,{targetId:'tab1'});assert.deepEqual(rows[1].result,{browserContextId:'ctx1'});
  assert.equal(fs.statSync(file).mode & 0o777,0o600);
  assert.deepEqual(protocolSummary({targetInfo:{targetId:'t',url:'PRIVATE',title:'PRIVATE'}}),{targetInfo:{targetId:'t'}});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('disabled or unwritable diagnostics do not break commands',()=>{
 assert.doesNotThrow(()=>createProtocolTrace(null,1)('send'));
 assert.doesNotThrow(()=>createProtocolTrace('/nonexistent/cdp-trace/log',1)('send'));
});

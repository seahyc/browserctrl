import test from 'node:test';
import assert from 'node:assert/strict';
import {disposeDiaContext} from '../lib/dia-context.mjs';
test('Dia closes the native window before disposing its Chromium context',async()=>{
 const calls=[];let closed=false;
 const conn={browser:async(method,params)=>{calls.push(method);if(method==='Target.getTargets')return{targetInfos:closed?[]:[{type:'page',browserContextId:'own',url:'https://example.test/" & dangerous text'}]};assert.ok(closed);assert.deepEqual(params,{browserContextId:'own'});return{};}};
 await disposeDiaContext(conn,'own',{run:async(bin,args)=>{assert.equal(bin,'osascript');assert.equal(args[2],'https://example.test/" & dangerous text');assert.ok(!args[1].includes('dangerous text'));calls.push('native close');closed=true;return{};}});
 assert.deepEqual(calls,['Target.getTargets','native close','Target.getTargets','Target.disposeBrowserContext']);
});
test('Dia retains the context when native close is refused',async()=>{
 const calls=[];const conn={browser:async m=>{calls.push(m);return{targetInfos:[{type:'page',browserContextId:'own',url:'about:blank'}]};}};
 await assert.rejects(disposeDiaContext(conn,'own',{run:async()=>{throw Error('Ambiguous window');}}),/Ambiguous/);
 assert.deepEqual(calls,['Target.getTargets']);
});
test('Dia refuses context disposal with zero or multiple live tabs',async()=>{
 for(const n of [0,2]){
  const calls=[];const conn={browser:async m=>{calls.push(m);return{targetInfos:Array.from({length:n},()=>({type:'page',browserContextId:'own',url:'about:blank'}))};}};
  await assert.rejects(disposeDiaContext(conn,'own',{run:async()=>assert.fail('must not close a window')}),/no unique live tab/);
  assert.deepEqual(calls,['Target.getTargets']);
 }
});
test('Dia refuses a URL shared with another context',async()=>{
 const conn={browser:async()=>({targetInfos:[{type:'page',browserContextId:'own',url:'about:blank'},{type:'page',browserContextId:'other',url:'about:blank'}]})};
 await assert.rejects(disposeDiaContext(conn,'own',{run:async()=>assert.fail('must not choose another context')}),/another context/);
});

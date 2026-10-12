import test from 'node:test';
import assert from 'node:assert/strict';
import {safariCLI, safariMCP} from '../lib/safari-frontend.mjs';
test('Safari navigation preserves explicit native handle',()=>{
  assert.deepEqual(safariMCP('browser_navigate',{tab:'native-handle',url:'https://example.com'}),{name:'navigate_to_url',args:{url:'https://example.com',tab_uuid:'native-handle'},tab:'native-handle'});
});
test('Safari uses Apple node UIDs and refuses Chromium refs and unsupported commands',()=>{
  assert.throws(()=>safariCLI('click',['click','tab'],{ref:'ref_3'}),/node UIDs/);
  assert.throws(()=>safariCLI('click',['click','tab'],{selector:'#button'}),/node UIDs/);
  assert.throws(()=>safariCLI('group',['group'],{}),/does not support/);
  assert.equal(safariCLI('fill',['fill','tab'],{ref:'42',value:'hello'}).args.interactions[0].replaceAll,true);
});
test('Safari batch API requires native interactions rather than pretending CDP compatibility',()=>{
  assert.throws(()=>safariMCP('browser_act',{tab:'a',steps:[{action:'click'}]}),/Apple interaction objects/);
  assert.throws(()=>safariMCP('browser_wait',{tab:'a'}),/does not support/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {safariCLI} from '../lib/safari-frontend.mjs';
test('Safari navigation preserves explicit native handle',()=>{
  assert.deepEqual(safariCLI('nav',['nav','native-handle','https://example.com'],{}),{name:'navigate_to_url',args:{url:'https://example.com',tab_uuid:'native-handle'},tab:'native-handle'});
});
test('Safari uses Apple node UIDs and refuses Chromium refs and unsupported commands',()=>{
  assert.throws(()=>safariCLI('click',['click','tab'],{ref:'ref_3'}),/node UIDs/);
  assert.throws(()=>safariCLI('click',['click','tab'],{selector:'#button'}),/node UIDs/);
  assert.throws(()=>safariCLI('group',['group'],{}),/does not support/);
  assert.equal(safariCLI('fill',['fill','tab'],{ref:'42',value:'hello'}).args.interactions[0].replaceAll,true);
});
test('Safari refuses unsupported click semantics before executing an action',()=>{
  for (const options of [{button:'right'},{count:2},{modifiers:['ctrl']},{steal:true}]) {
    assert.throws(()=>safariCLI('click',['click','tab'],{ref:'42',...options}),/does not support|do not support/);
  }
  assert.throws(()=>safariCLI('click',['click','tab'],{}),/requires a node UID/);
});

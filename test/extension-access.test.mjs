import test from 'node:test';
import assert from 'node:assert/strict';
import {affectedExtensionTabs,assertExtensionClaims,extensionReads,extensionScoped} from '../lib/extension-access.mjs';
const tabs = [{id:1,url:'https://own.test',groupId:10},{id:2,url:'https://busy.test',groupId:20},{id:3,url:'https://dormant.test',groupId:-1}];
const targets = [{targetId:'own',url:tabs[0].url},{targetId:'busy',url:tabs[1].url}];
const claims = [{targetId:'busy',owner:'other'}];
test('inspection is allowlisted; arbitrary worker evaluation stays global',()=>{
  assert.ok(extensionReads.has('outline'));
  assert.ok(extensionReads.has('tabs.query'));
  assert.ok(!extensionReads.has('eval'));
  assert.ok(!extensionScoped.has('tabs.update'));
});
test('unrelated claims allow exact grouping and dormant tabs',()=>{
  const affected=affectedExtensionTabs('tabs.group',[{tabIds:[3],groupId:10}],tabs);
  assert.deepEqual(affected.map(t=>t.id),[1,3]);
  assert.doesNotThrow(()=>assertExtensionClaims(affected,targets,claims,'me'));
});
test('destination group and selected tab claims both block before mutation',()=>{
  for(const [method,args] of [['tabs.group',[{tabIds:[3],groupId:20}]],['tabs.remove',[[2]]],['tabGroups.update',[20,{collapsed:true}]]]) {
    const affected=affectedExtensionTabs(method,args,tabs);
    assert.throws(()=>assertExtensionClaims(affected,targets,claims,'me'),/claimed by other/);
  }
});
test('duplicate URLs are conservatively protected and unknown claims fail closed',()=>{
  assert.throws(()=>assertExtensionClaims([{id:4,url:tabs[1].url}],targets,claims,'me'),/claimed by/);
  assert.throws(()=>assertExtensionClaims([tabs[0]],targets,[{targetId:'missing',owner:'other'}],'me'),/Cannot resolve claimed/);
  assert.doesNotThrow(()=>assertExtensionClaims(tabs,targets,[{targetId:'busy',owner:'me'}],'me'));
});
test('missing IDs and unsupported mutations fail before action',()=>{
  assert.throws(()=>affectedExtensionTabs('tabs.group',[{tabIds:[99]}],tabs),/missing/);
  assert.throws(()=>affectedExtensionTabs('tabs.remove',[99],tabs),/exact tab/);
  assert.throws(()=>affectedExtensionTabs('tabGroups.update',[20,{windowId:1}],tabs),/Unsupported/);
});

test('only protocol-confirmed destroyed claims can be ignored',()=>{
  const stale=[{targetId:'gone',owner:'other'}];
  assert.throws(()=>assertExtensionClaims(tabs,targets,stale,'me'),/Cannot resolve/);
  assert.doesNotThrow(()=>assertExtensionClaims(tabs,targets,stale,'me',new Set(['gone'])));
  assert.throws(()=>assertExtensionClaims(tabs,targets,claims,'me',new Set(['busy'])),/claimed by/);
});

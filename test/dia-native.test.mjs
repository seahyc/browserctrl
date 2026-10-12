import test from 'node:test';
import assert from 'node:assert/strict';
import {listNativeTabs, focusNativeTab} from '../lib/dia-native.mjs';
import {getNativeTabAdapter} from '../lib/adapters/index.mjs';
import {planNativeGroup, groupNativeTabs} from '../lib/tab-control.mjs';
const id = '12345678-1234-4abc-9abc-123456789012';
const previous = '23456789-1234-4abc-9abc-123456789012';
const windows = [{id:'window',activeTabId:previous,tabs:[
  {id,url:'https://example.test/role',title:'Role'},
  {id:previous,url:'https://example.test/home'},
]}];

function extension({missing = false, fail = false, replace = false} = {}) {
  const calls = [];
  let available = !missing, grouped = false;
  return {
    calls,
    focus: async uuid => {calls.push(['focus',uuid]);available = true;},
    evaluate: async expr => {
      if (expr.includes('chrome.tabs.query')) return available ? [{id:grouped && replace ? 99 : 42,groupId:grouped ? 2 : -1}] : [];
      if (expr.includes('chrome.tabs.group')) {
        calls.push(['group']);
        if (!fail || replace) grouped = true;
        if (fail) throw Error('Tab not found for session ID');
      }
      if (expr.includes('chrome.tabGroups.update')) calls.push(['collapse']);
      return {};
    },
  };
}

test('native inventory parses dormant tabs without focusing', async () => {
  const result = await listNativeTabs({platform:'darwin',run:async (bin,args) => {
    assert.equal(bin,'osascript');assert.ok(!args[3].includes('d.focus'));
    assert.match(args[3],/t\.properties\(\)/);
    assert.doesNotMatch(args[3],/t\.(?:id|title|url)\(\)/);
    return {stdout:JSON.stringify({windows,needsRetry:false})};
  }});
  assert.deepEqual(result,windows);
});
test('native inventory keeps empty windows and windows without an active tab', async () => {
  const inventory=[{id:'empty',activeTabId:null,tabs:[]},{id:'no-active',activeTabId:null,tabs:[{id,url:'https://example.test/'}]}];
  const result=await listNativeTabs({platform:'darwin',run:async()=>({stdout:JSON.stringify({windows:inventory,needsRetry:false})})});
  assert.deepEqual(result,inventory);
});
test('native inventory retries once after a transient -1728 and surfaces later failures', async () => {
  let calls=0;
  const result=await listNativeTabs({platform:'darwin',run:async(bin,args)=>{
    calls++;
    if(calls===1) {const error=Error("Can't get object. (-1728)");throw error;}
    assert.equal(args.at(-1),'retry');
    return {stdout:JSON.stringify({windows,needsRetry:false})};
  }});
  assert.deepEqual(result,windows);assert.equal(calls,2);
  calls=0;
  await assert.rejects(listNativeTabs({platform:'darwin',run:async()=>{calls++;throw Error('permission denied');}}),/permission denied/);
  assert.equal(calls,1);
  calls=0;
  await assert.rejects(listNativeTabs({platform:'darwin',run:async()=>{calls++;throw Error('(-1728) still changing');}}),/-1728/);
  assert.equal(calls,2);
});
test('native inventory retries an active-tab -1728 and keeps the window when none is active', async () => {
  let calls=0;
  const result=await listNativeTabs({platform:'darwin',run:async(bin,args)=>{
    calls++;
    if(calls===1) return {stdout:JSON.stringify({windows,needsRetry:true})};
    assert.equal(args.at(-1),'retry');
    return {stdout:JSON.stringify({windows:[{id:'window',activeTabId:null,tabs:windows[0].tabs}],needsRetry:false})};
  }});
  assert.equal(calls,2);assert.equal(result[0].activeTabId,null);assert.equal(result[0].tabs.length,2);
});
test('unsupported OS adapters fail without executing a native process', async () => {
  let calls = 0;
  for (const platform of ['linux','win32']) {
    assert.throws(() => getNativeTabAdapter('dia',{platform,run:async()=>calls++}), /No native tab adapter/);
  }
  assert.equal(calls,0);
});
test('Dia adapter passes exact UUID as data and rejects unsafe IDs', async () => {
  let calls = 0;
  const options = {platform:'darwin',run:async (bin,args) => {
    calls++;assert.equal(args.at(-1),id);assert.ok(!args[3].includes(id));return {stdout:id};
  }};
  await assert.rejects(focusNativeTab('";do shell script',options), /UUID/);
  await focusNativeTab(id,options);
  assert.equal(calls,1);
});
test('planning refuses missing, repeated, cross-window, and duplicate-URL tabs', () => {
  assert.throws(()=>planNativeGroup(windows,['missing'],2),/missing/);
  assert.throws(()=>planNativeGroup(windows,[id,id],2),/distinct/);
  assert.throws(()=>planNativeGroup([...windows,{id:'other',tabs:[{id:'other',url:'https://other.test/'}]}],[id,'other'],2),/one window/);
  assert.throws(()=>planNativeGroup([{...windows[0],tabs:[...windows[0].tabs,{id:'duplicate',url:windows[0].tabs[0].url}]}],[id],2),/ambiguous/);
});
test('portable grouping uses injected inventory without native focus', async () => {
  const ext = extension();
  const result = await groupNativeTabs([id],2,{list:async()=>windows,...ext});
  assert.equal(result.usedFocus,false);assert.equal(result.restored,null);
  assert.deepEqual(ext.calls,[['group'],['collapse']]);
});
test('missing extension tab refuses before focus or mutation by default', async () => {
  const ext = extension({missing:true});
  await assert.rejects(groupNativeTabs([id],2,{list:async()=>windows,...ext}), /--allow-focus/);
  assert.deepEqual(ext.calls,[]);
});
test('explicit foreground fallback restores prior selection', async () => {
  const ext = extension({missing:true});
  const result = await groupNativeTabs([id],2,{list:async()=>windows,...ext,allowFocus:true});
  assert.equal(result.usedFocus,true);assert.equal(result.restored,previous);
  assert.deepEqual(ext.calls,[['focus',id],['group'],['focus',previous],['collapse']]);
});
test('failed foreground fallback restores selection without replaying mutation', async () => {
  const ext = extension({missing:true,fail:true});
  await assert.rejects(groupNativeTabs([id],2,{list:async()=>windows,...ext,allowFocus:true}), /Tab not found/);
  assert.deepEqual(ext.calls,[['focus',id],['group'],['focus',previous],['collapse']]);
});
test('session replacement verifies observed membership without replay or focus', async () => {
  const ext = extension({fail:true,replace:true});
  const result = await groupNativeTabs([id],2,{list:async()=>windows,...ext});
  assert.equal(result.moved[0].extensionId,99);
  assert.deepEqual(ext.calls,[['group'],['collapse']]);
});
test('already grouped tabs are idempotent without focus or move', async () => {
  const calls=[];
  const result=await groupNativeTabs([id],2,{list:async()=>windows,evaluate:async expr=>{
    if(expr.includes('chrome.tabs.query'))return[{id:42,groupId:2}];
    if(expr.includes('chrome.tabs.group'))assert.fail('must not move an already grouped tab');
    calls.push(expr);return{};
  }});
  assert.equal(result.usedFocus,false);assert.equal(result.moved.length,1);
});

test('background preflight refuses a missing later tab before moving an earlier one', async () => {
  const calls=[];
  await assert.rejects(groupNativeTabs([id,previous],2,{list:async()=>windows,evaluate:async expr=>{
    if(expr.includes('chrome.tabs.query'))return expr.includes('/home')?[]:[{id:42,groupId:-1}];
    if(expr.includes('chrome.tabs.group'))calls.push('move');
    return{};
  },focus:async()=>calls.push('focus')}),/--allow-focus/);
  assert.deepEqual(calls,[]);
});

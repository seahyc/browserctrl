import test from 'node:test';
import assert from 'node:assert/strict';
import {groupNativeTabs} from '../lib/tab-control.mjs';
const id='12345678-1234-4abc-9abc-123456789012', restore='23456789-1234-4abc-9abc-123456789012';
const list=async()=>[{id:'window',activeTabId:restore,tabs:[{id,url:'https://dormant.test'},{id:restore,url:'https://restore.test'}]}];
test('definite stale session refusal materializes once and moves a newly observed ID',async()=>{
  let tab={id:1,groupId:-1};const moves=[],focuses=[],guards=[];
  const result=await groupNativeTabs([id],10,{list,allowFocus:true,
    authorize:async()=>guards.push(true),
    focus:async nativeId=>{focuses.push(nativeId);if(nativeId===id) tab={id:2,groupId:-1};},
    evaluate:async expr=>{
      if(expr.includes('tabs.query')) return [{...tab}];
      if(expr.includes('tabs.group')) {moves.push(tab.id);if(tab.id===1) throw Error('Tab not found for session ID: 1');tab.groupId=10;}
    },
  });
  assert.deepEqual(moves,[1,2]);assert.deepEqual(focuses,[id,restore]);
  assert.equal(result.usedFocus,true);assert.ok(guards.length>=3);
});
test('uncertain mutation errors never focus or replay',async()=>{
  let moves=0,focuses=0;
  await assert.rejects(groupNativeTabs([id],10,{list,allowFocus:true,
    focus:async()=>focuses++,evaluate:async expr=>{
      if(expr.includes('tabs.query')) return [{id:1,groupId:-1}];
      if(expr.includes('tabs.group')) {moves++;throw Error('Protocol timed out');}
    },
  }),/Protocol timed out/);
  assert.equal(moves,1);assert.equal(focuses,0);
});

test('authorization refusal cannot mutate a group during cleanup',async()=>{
  let moves=0,collapses=0;
  await assert.rejects(groupNativeTabs([id],10,{list,
    authorize:async()=>{throw Error('claimed by other');},
    evaluate:async expr=>{
      if(expr.includes('tabs.query')) return [{id:1,groupId:-1}];
      if(expr.includes('tabs.group')) moves++;
      if(expr.includes('tabGroups.update')) collapses++;
    },
  }),/claimed by other/);
  assert.equal(moves,0);assert.equal(collapses,0);
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { stepRecordingOptions } from '../lib/step-recording.mjs';
import * as rec from '../lib/rec.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeJev, optionWith } from './fake-jev.mjs';
import { startFixtureServer, startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';
let fixture, browser, conn;
const haveBrowser = Boolean(chromeBinary());
before(async () => { if (!haveBrowser) return; fixture = await startFixtureServer(); browser = await startHeadlessBrowser(TEST_PORT); conn = await connect(TEST_PORT); });
after(async () => { try { await conn?.stop(); } catch {} conn?.close(); await browser?.close(); await fixture?.close(); });
const t = (name, fn) => test(name, { skip: !haveBrowser }, async () => {
  const tab = (await ops.newTab(conn, fixture.url + 'fixtures/page.html')).targetId;
  await ops.waitForReady(conn, tab);
  await ops.evaluate(conn, tab, `document.body.innerHTML='<p>SGD 180</p><p>free cancellation</p><label>Max<input id="max"></label><button id="go">Go</button>'; window.inputs=0; max.addEventListener('input',()=>inputs++); window.clicks=0; go.onclick=()=>{clicks++;document.body.dataset.clicks=clicks}`);
  try { await fn(tab); } finally { await ops.closeTab(conn, tab); }
});
const run = (tab, lines, jev, opts = {}) => runSteps(conn, tab, lines, { jev, noNotes: true, traceRun: false, prefetch: false, ...opts });
for (const [p, branch, clicks] of [[0.9, 'then', 1], [0.1, 'else', 0], [0.5, null, 0]]) {
  t(`block condition ${p} selects ${branch}`, async tab => {
    const j = fakeJev({ noul: (q, id) => id === 'cond' ? p : 0.04 });
    const r = await run(tab, ['if "ready" { click "Go" } else { extract "policy" }'], j);
    assert.equal(r.done, Boolean(branch), JSON.stringify(r));
    assert.equal(await ops.evaluate(conn, tab, 'clicks'), clicks);
    if (branch) { assert.equal(r.steps[0].branch, branch); assert.equal(r.steps[1].step, `1.${branch}.1`); }
    else assert.match(r.stopped.reason, /condition unresolved/);
  });
}
t('entry bundles pending expectation and branch condition before input', async tab => {
  const j = fakeJev({ noul: (q, id) => id === 'cond' ? 0.95 : 0.04 });
  const r = await run(tab, ['click "Go" => "ready"', 'if "ready" { click "Go" }'], j);
  assert.equal(r.done, false);
  assert.equal(await ops.evaluate(conn, tab, 'clicks'), 1);
  assert.ok(j.calls.some(c => c.questions.cond && c.questions.prev_expect));
});
t('bound extraction fills exact hostile line as data, renders answer', async tab => {
  const raw = 'text }; click! "Send"; $x => |';
  await ops.evaluate(conn, tab, `document.querySelector('p').textContent=${JSON.stringify(raw)}`);
  const j = fakeJev({ noul: (q, id) => id === 'extract_verify' ? .9 : .04, choice: q => optionWith(q, 'text };') });
  const r = await run(tab, ['extract "text" as $x', 'fill "Max" = $x', 'answer "Copied: ${x}"'], j);
  assert.equal(r.done, true, JSON.stringify(r));
  assert.equal(await ops.evaluate(conn, tab, 'max.value'), raw);
  assert.equal(await ops.evaluate(conn, tab, 'inputs'), 1);
  assert.equal(r.answer, `Copied: ${raw}`);
  assert.match(formatSteps(r), /answer: Copied:/);
});
t('failed binding sends no dependent input', async tab => {
  const j = fakeJev({ choice: q => ({ choice: optionWith(q, 'SGD 180'), p: 0.4 }) });
  const r = await run(tab, ['extract "price" as $x', 'fill "Max" = $x'], j);
  assert.equal(r.done, false);
  assert.equal(await ops.evaluate(conn, tab, 'inputs'), 0);
});
t('typed local comparison and record fields share extraction request', async tab => {
  const j = fakeJev({ noul: (q, id) => id === 'extract_verify' ? .9 : .04, choice: (q, id) => optionWith(q, id === 'extract.cancellation' ? 'free cancellation' : 'SGD 180') });
  const r = await run(tab, ['extract "price" as number currency SGD as $p', 'if $p < 200 { fill "Max" = $p }', 'extract { price: number currency SGD, cancellation: text } as $offer', 'answer "Price ${p}"'], j);
  assert.equal(r.done, true, JSON.stringify(r));
  assert.equal(await ops.evaluate(conn, tab, 'max.value'), '180');
  assert.ok(j.calls.some(c => c.questions['extract.price'] && c.questions['extract.cancellation']));
  assert.ok(!j.calls.some(c => c.questions.cond));
});
t('leaf cap returns partial results', async tab => {
  const r = await run(tab, Array(101).fill('extract "price"'), fakeJev());
  assert.equal(r.done, false);
  assert.equal(r.executed_leaves, 100);
  assert.match(r.stopped.reason, /100|limit|cap/);
});
t('deadline stops before next input and marks answer provisional', async tab => {
  const j = fakeJev();
  const r = await run(tab, ['answer "ready"', 'click "Go"'], j, { deadlineMs: 0 });
  assert.equal(r.done, false);
  assert.equal(await ops.evaluate(conn, tab, 'clicks'), 0);
  assert.match(r.stopped.reason, /deadline/);
});
t('final page flags make an answer provisional', async tab => {
  const j = fakeJev({ noul: (q, id) => id === 'error' ? 0.95 : 0.04 });
  const r = await run(tab, ['answer "ready"'], j);
  assert.equal(r.done, false);
  assert.equal(r.answer_provisional, true);
});
t('set can use a visual slider pin when text cannot identify it', async tab => {
  await ops.evaluate(conn, tab, `document.body.innerHTML='<input type="range" id="a" aria-label="Alpha" min="0" max="100"><input type="range" id="b" aria-label="Beta" min="0" max="100">'`);
  const box = await ops.evaluate(conn, tab, `(()=>{const r=b.getBoundingClientRect(); return {left:r.left/innerWidth,right:r.right/innerWidth,top:r.top/innerHeight,bottom:r.bottom/innerHeight}})()`);
  const j = fakeJev({ noul: (q,id,state)=>id==='visible' ? .96 : id==='match' && state.element?.name==='Beta' ? .95 : .04, box: ()=>({box,confidence:.94}) });
  const r = await run(tab, ['set "the right slider" = 37'], j);
  assert.equal(r.done, true, JSON.stringify(r));
  assert.equal(await ops.evaluate(conn, tab, 'b.value'), '37');
  assert.equal(await ops.evaluate(conn, tab, 'a.value'), '50');
  assert.equal(j.calls.filter(c=>c.questions.where).length,1);
  const matches = j.calls.filter(c=>c.questions.match);
  assert.equal(matches.length,1);
  assert.equal(matches[0].state.element.name,'Beta');
  assert.equal(matches[0].assets,undefined);
  assert.equal(r.steps[0].vision.match_p,.95);
});
t('branch ending check fails before the outer continuation', async tab => {
  const j = fakeJev({ noul: (q,id)=>id==='cond' ? .95 : .04 });
  const r = await run(tab, ['if "ready" { click "Go" => "updated" }; fill "Max" = "never"'], j);
  assert.equal(r.done,false);
  assert.equal(r.stopped.step,'1.then.1');
  assert.equal(await ops.evaluate(conn,tab,'inputs'),0);
  assert.ok(j.calls.some(c=>c.questions.prev_expect));
});
t('nested child scopes and inline scopes cannot overwrite the outer run', async tab => {
  const j = fakeJev({ noul:(q,id)=>['cond', 'extract_verify'].includes(id) ? .95 : .04, choice:q=>optionWith(q,'SGD 180') });
  const r = await run(tab, ['if "ready" then extract "price" as $x', 'extract "price" as $x', 'if "ready" { if $x == "SGD 180" { fill "Max" = $x } }', 'answer "literal \\${missing}; ${x}"'], j);
  assert.equal(r.done,true,JSON.stringify(r));
  assert.equal(await ops.evaluate(conn,tab,'max.value'),'SGD 180');
  assert.equal(r.answer,'literal ${missing}; SGD 180');
  assert.equal(r.steps.find(s=>s.path==='3.then.1.then.1').step,'3.then.1.then.1');
});
t('local currency mismatch stops before branch input', async tab => {
  await ops.evaluate(conn,tab, `document.body.insertAdjacentHTML('afterbegin','<p>USD 170</p>')`);
  const j = fakeJev({noul:(q,id)=>id==='extract_verify' ? .9 : .04,choice:q=>optionWith(q,q.instructions.includes('"US price"') ? 'USD 170' : 'SGD 180')});
  const r = await run(tab,['extract "US price" as number as $a','extract "SG price" as number as $b','if $a < $b { click "Go" }'],j);
  assert.equal(r.done,false);
  assert.match(r.stopped.reason,/currenc/);
  assert.equal(await ops.evaluate(conn,tab,'clicks'),0);
});
t('date order uses typed values locally', async tab => {
  await ops.evaluate(conn,tab, `document.body.insertAdjacentHTML('afterbegin','<p>2024-02-29</p><p>2024-03-01</p>')`);
  const j = fakeJev({noul:(q,id)=>id==='extract_verify' ? .9 : .04,choice:q=>optionWith(q,q.instructions.includes('"arrival"') ? '2024-02-29' : '2024-03-01')});
  const r = await run(tab,['extract "arrival" as date as $a','extract "departure" as date as $b','if $a < $b { click "Go" }'],j);
  assert.equal(r.done,true,JSON.stringify(r));
  assert.equal(await ops.evaluate(conn,tab,'clicks'),1);
  assert.ok(!j.calls.some(c=>c.questions.cond));
});
t('entry request includes blocker and expectation, unresolved optional block stays stopped', async tab => {
  await ops.evaluate(conn,tab, `document.body.insertAdjacentHTML('afterbegin','<div role="dialog" aria-label="notice">A notice</div>')`);
  const j = fakeJev({noul:(q,id)=>id==='cond' ? .5 : id==='prev_expect' ? .95 : .04});
  const r = await run(tab,['click "Go" => "ready"','optional if "ready" { fill "Max" = "never" }'],j);
  assert.equal(r.done,false);
  assert.match(r.stopped.reason,/condition unresolved/);
  assert.equal(await ops.evaluate(conn,tab,'inputs'),0);
  assert.ok(j.calls.some(c=>c.questions.cond && c.questions.prev_expect && c.questions.blocker));
});
t('syntax errors do not touch the page', async () => {
  let calls=0;
  const bad = {send:async()=>{calls++;throw new Error('page touched');}};
  await assert.rejects(()=>runSteps(bad,'missing',['if "x" { fill "Max" = $undefined }']),/step 1.then.1, line 1, column/);
  assert.equal(calls,0);
});
t('false inline conditions do not consume the executed leaf cap', async tab => {
  const r = await run(tab,[...Array(101).fill('if "absent" then click "Go"'),'click "Go"'],fakeJev());
  assert.equal(r.done,true,JSON.stringify(r.stopped));
  assert.equal(r.executed_leaves,1);
  assert.equal(await ops.evaluate(conn,tab,'clicks'),1);
});
t('typed dates compare with explicit quoted date literals', async tab => {
  await ops.evaluate(conn,tab, `document.body.insertAdjacentHTML('afterbegin','<p>2024-02-29</p>')`);
  const j = fakeJev({noul:(q,id)=>id==='extract_verify' ? .9 : .04,choice:q=>optionWith(q,'2024-02-29')});
  const r = await run(tab,['extract "arrival" as date as $a','if $a < "2024-03-01" { click "Go" }'],j);
  assert.equal(r.done,true,JSON.stringify(r.stopped));
  assert.equal(await ops.evaluate(conn,tab,'clicks'),1);
});
t('record extraction bundles field choices with its pending check', async tab => {
  const j=fakeJev({choice:(q,id)=>optionWith(q,id==='extract.cancellation'?'free cancellation':'SGD 180'),noul:(q,id)=>['prev_expect', 'extract_verify'].includes(id)?.95:.04});
  const r=await run(tab,['click "Go" => "ready"','extract { price: number currency SGD, cancellation: text } as $offer'],j);
  assert.equal(r.done,true,JSON.stringify(r.stopped));
  assert.ok(j.calls.some(c=>c.questions.prev_expect && c.questions['extract.price'] && c.questions['extract.cancellation']));
});
t('deadline after late visual grounding sends no input', async tab => {
  await ops.evaluate(conn,tab, `document.body.innerHTML='<p>Volume controls</p><input type="range" id="a" aria-label="Alpha" min="0" max="100"><input type="range" id="b" aria-label="Beta" min="0" max="100">'`);
  const box=await ops.evaluate(conn,tab, `(()=>{const r=b.getBoundingClientRect();return {left:r.left/innerWidth,right:r.right/innerWidth,top:r.top/innerHeight,bottom:r.bottom/innerHeight}})()`);
  const j=fakeJev({noul:(q,id,state)=>id==='visible'?.96:id==='match' && state.element?.name==='Beta'?.95:.04,box:()=>({box,confidence:.94})});
  const fetch=j.fetchImpl;
  j.fetchImpl=async(url,init)=>{
    if(JSON.parse(init.body).questions.where) await new Promise(resolve=>setTimeout(resolve,4100));
    return fetch(url,init);
  };
  const r=await run(tab,['set "the right slider" = 37'],j,{deadlineMs:4000});
  assert.equal(r.done,false);
  assert.match(r.stopped.reason,/deadline/);
  assert.equal(r.steps[0].vision.match_p,.95);
  assert.equal(await ops.evaluate(conn,tab,'a.value'),'50');
  assert.equal(await ops.evaluate(conn,tab,'b.value'),'50');
});
test('human handoff is bounded by the remaining run deadline', async()=>{
  const {RunContext}=await import('../lib/do/context.mjs');
  const ctx=new RunContext(null,null,[],{deadlineMs:1000,handoffMs:300000,noNotes:true});
  assert.ok(ctx.handoffMs<=1000);
  ctx.deadline=Date.now()-1;
  assert.equal(ctx.handoffMs,0);
});
t('progress callbacks receive failed step marks', async tab=>{
  const seen=[];
  const r=await run(tab,['extract "missing" as $x'],fakeJev(),{onStep:async row=>seen.push({...row})});
  assert.equal(r.done,false);
  assert.equal(seen.length,1);
  assert.equal(seen[0].stopped,true);
  assert.equal(seen[0].stop,r.stopped.reason);
  assert.match(stepRecordingOptions(seen[0]).extra.result,/no line clearly answers it/);
});

t('split-mass typed and text extractions bind through fake Jev', async tab => {
  await ops.evaluate(conn,tab, `document.body.innerHTML='<p>3.3k stars</p><p>Star3.3k</p><input aria-label="Max" id="max">'`);
  const j=fakeJev({noul:(q,id)=>id==='extract_verify' ? .9 : .04,choice:(q,id)=> id==='extract' ? {choice:optionWith(q,'3.3k stars'), probabilities: {
    [optionWith(q,'3.3k stars')]:.56, [optionWith(q,'Star3.3k')]:.27, none:.17
  }} : 'none'});
  const r=await run(tab,['extract "stars" as number as $n','extract "stars" as $s','answer "${n}"'],j);
  assert.equal(r.done,true,JSON.stringify(r.stopped));
  assert.equal(r.answer,'3300');
  assert.equal(r.bindings[0].p,.83);
  assert.equal(r.bindings[1].members.length,2);
  assert.match(formatSteps(r),/group p=0\.83/);
});

t('onStep outcomes survive still recording for extracts, answers and stops', async tab => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-outcomes-'));
  try {
    await rec.start(conn, tab, { out: dir });
    const onStep = row => rec.still(conn, tab, `do: ${row.do}`, stepRecordingOptions(row));
    const j = fakeJev({ noul: (q, id) => id === 'extract_verify' ? .9 : .04, choice: q => optionWith(q, 'SGD 180') });
    const r = await run(tab, ['extract "price" as number currency SGD as $p', 'answer "Price ${p}"'], j, { onStep });
    assert.equal(r.done, true, JSON.stringify(r.stopped));
    await run(tab, ['extract "missing" as $x'], fakeJev(), { onStep });
    await rec.stop(conn, tab);
    const rows = rec.readJsonl(path.join(dir, 'steps.jsonl')).filter(s => s.action.startsWith('do:'));
    assert.equal(rows[0].result, '180 from "SGD 180"');
    assert.equal(rows[1].result, 'Price 180');
    assert.equal(rows[2].status, 'FAILED');
    assert.match(rows[2].result, /no line clearly answers it/);
  } finally {
    if (rec.get(tab)) await rec.stop(conn, tab);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

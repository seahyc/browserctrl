import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { connect } from '../lib/daemon.mjs';
import * as ops from '../lib/ops.mjs';
import { runSteps, formatSteps } from '../lib/steps.mjs';
import { fakeJev, optionWith } from './fake-jev.mjs';
import { startHeadlessBrowser, chromeBinary, TEST_PORT } from './helpers.mjs';
let server, browser, conn, base;
const hits = [];
const haveBrowser = Boolean(chromeBinary());
before(async () => {
  if (!haveBrowser) return;
  server = http.createServer((req,res) => {
    hits.push(req.url);
    res.setHeader('Content-Type','text/html');
    res.end(`<title>Detail ${req.url}</title><main><h1>${req.url.includes('2') ? 'Correct hotel' : 'Wrong hotel'}</h1><p>${'Hotel policy and nightly price evidence. '.repeat(12)}</p></main>`);
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => { try { await conn?.stop(); } catch {} conn?.close(); await browser?.close(); if(server) await new Promise(resolve => server.close(resolve)); });
const cards = () => `<main><h1>Hotels</h1><ul>${[1,2,3].map(i=>`<li style="height:80px"><a href="${base}/detail${i}">Hotel ${i}</a><p>Hotel ${i} price and cancellation</p></li>`).join('')}</ul></main>`;
const t = (name, fn) => test(name,{skip:!haveBrowser},async()=>{
  const tab=(await ops.newTab(conn,base+'/source')).targetId;
  await ops.waitForReady(conn,tab);
  await ops.evaluate(conn,tab,`document.body.innerHTML=${JSON.stringify(cards())}`);
  hits.length=0;
  try { await fn(tab); } finally { await ops.closeTab(conn,tab); }
});
const judge = (check = (q,id,state)=> JSON.stringify(state).includes('Correct hotel') ? .75 : .25, options={}) => fakeJev({
  choice: (q,id) => {
    if(id!=='pick' && id!=='target') return 'none';
    const a=optionWith(q,'Hotel 1'),b=optionWith(q,'Hotel 2');
    return {choice:a,probabilities:{[a]:.55,[b]:.4,none:.05}};
  },
  noul:(q,id,state)=>id==='prev_expect'?check(q,id,state):.04,
  ...options,
});
const run=(tab,j)=>runSteps(conn,tab,['try pick "a suitable hotel" up to 3 => "the hotel is suitable"'],{jev:j,noNotes:true,traceRun:false,prefetch:false,minP:.3});

t('frozen distribution tries wrong detail then correct and closes owned tabs',async tab=>{
  const j=judge(), tabs=(await ops.tabs(conn)).map(t=>t.targetId).sort();
  const r=await run(tab,j);
  assert.equal(r.done,true,JSON.stringify(r.stopped));
  assert.equal(r.attempts.length,2);
  assert.deepEqual(r.attempts.map(a=>a.check_p),[.25,.75]);
  assert.ok(r.attempts.every(a=>a.restoration.verified));
  assert.equal(j.calls.filter(c=>c.questions.pick).length,1);
  assert.equal(j.calls.filter(c=>c.questions.prev_expect && c.questions.error && c.questions.challenge).length,2);
  assert.equal(r.owned_tabs.length,1);
  assert.deepEqual((await ops.tabs(conn)).map(t=>t.targetId).filter(id=>!r.owned_tabs.includes(id)).sort(),tabs);
  for(const id of r.owned_tabs) await ops.closeTab(conn,id);
  fs.writeFileSync('/tmp/codex-bc/dsl-b-try-samples.txt',formatSteps(r));
});

t('exhaustion and none keep source unchanged',async tab=>{
  const before=await ops.evaluate(conn,tab,'document.body.innerHTML');
  const r=await run(tab,judge(()=>.25));
  assert.equal(r.done,false);
  assert.match(r.stopped.reason,/none|exhausted/);
  assert.equal(hits.filter(h=>h.startsWith('/detail')).length,2);
  assert.equal(await ops.evaluate(conn,tab,'document.body.innerHTML'),before);
});

t('uncertain result stops before another candidate',async tab=>{
  const r=await run(tab,judge(()=>.5));
  assert.match(r.stopped.reason,/unresolved/);
  assert.equal(hits.filter(h=>h.startsWith('/detail')).length,1);
});

t('below-minimum runner up stops without renormalizing',async tab=>{
  const j=judge(()=>.25,{choice:q=>{const a=optionWith(q,'Hotel 1'),b=optionWith(q,'Hotel 2');return {choice:a,probabilities:{[a]:.7,[b]:.2,none:.1}};}});
  const r=await run(tab,j);
  assert.match(r.stopped.reason,/below minimum/);
  assert.equal(hits.filter(h=>h.startsWith('/detail')).length,1);
});

t('commit-looking lower ranked link never opens',async tab=>{
  await ops.evaluate(conn,tab,`document.querySelectorAll('li')[1].innerHTML='<a href="${base}/detail2">Buy hotel now</a><p>Buy hotel now</p>'`);
  const j=judge(()=>.25,{choice:q=>{const a=optionWith(q,'Hotel 1'),b=optionWith(q,'Buy hotel');return {choice:a,probabilities:{[a]:.55,[b]:.4,none:.05}};}});
  const r=await run(tab,j);
  assert.match(r.stopped.reason,/commit/,JSON.stringify(j.calls));
  assert.equal(hits.filter(h=>h.startsWith('/detail')).length,1);
});

t('lost check response never resends navigation',async tab=>{
  const j=judge(), fetch=j.fetchImpl;
  j.fetchImpl=async(url,init)=>{if(JSON.parse(init.body).questions.prev_expect)throw new Error('Lost result response');return fetch(url,init);};
  const r=await run(tab,j);
  assert.match(r.stopped.reason,/Lost result response/);
  assert.equal(hits.filter(h=>h.startsWith('/detail')).length,1);
  assert.deepEqual(r.owned_tabs,[]);
});

t('enclosing pending check drains before selecting candidates',async tab=>{
  const j=judge(()=>.1);
  const r=await runSteps(conn,tab,['wait 1 => "prior condition"','try pick "a suitable hotel" up to 2 => "suitable"'],{jev:j,noNotes:true,traceRun:false,prefetch:false});
  assert.equal(r.done,false);
  assert.equal(j.calls.filter(c=>c.questions.pick && c.questions.prev_expect).length,1);
  assert.equal(hits.filter(h=>h.startsWith('/detail')).length,0);
});

t('source candidate redraw stops after failed detail',async tab=>{
  const j=judge(()=>.25), fetch=j.fetchImpl;
  j.fetchImpl=async(url,init)=>{if(JSON.parse(init.body).questions.prev_expect)await ops.evaluate(conn,tab,"document.querySelector('a').textContent='Changed hotel'");return fetch(url,init);};
  const r=await run(tab,j);
  assert.match(r.stopped.reason,/identities changed/);
  assert.equal(hits.filter(h=>h.startsWith('/detail')).length,1);
});

t('exact ARIA tab restoration verifies before second candidate',async tab=>{
  await ops.evaluate(conn,tab,`document.body.innerHTML='<main><div role="tablist"><button role="tab" id="a" aria-selected="true" aria-controls="pa">Overview</button><button role="tab" id="b" aria-selected="false" aria-controls="pb">Reviews one</button><button role="tab" id="c" aria-selected="false" aria-controls="pc">Reviews two</button></div><section id="pa">Overview</section><section id="pb" hidden>Wrong reviews</section><section id="pc" hidden>Correct reviews</section></main>';window.inputs=0;document.querySelectorAll('[role=tab]').forEach(t=>t.onclick=()=>{inputs++;document.querySelectorAll('[role=tab]').forEach(x=>{x.setAttribute('aria-selected',String(x===t));document.getElementById(x.getAttribute('aria-controls')).hidden=x!==t})})`);
  const j=fakeJev({choice:q=>{const a=optionWith(q,'Reviews one'),b=optionWith(q,'Reviews two');return {choice:a,probabilities:{[a]:.55,[b]:.4,none:.05}};},noul:(q,id,state)=>id==='restore'?.95:id==='prev_expect'?(JSON.stringify(state).includes('Correct reviews')?.75:.25):.04});
  const r=await runSteps(conn,tab,['try click "Reviews" up to 2 => "correct reviews"'],{jev:j,noNotes:true,traceRun:false,prefetch:false,minP:.3});
  assert.equal(r.done,true,JSON.stringify({stopped:r.stopped,calls:j.calls}));
  assert.equal(await ops.evaluate(conn,tab,'inputs'),3);
  assert.ok(j.calls.some(c=>c.questions.restore));
});

for (const [label, attrs, expected] of [
  ['Send message', '', /commit/],
  ['Add to cart', '', /commit|Unknown buttons/],
  ['Mystery action', '', /Unknown buttons/],
  ['Reviews', 'type="submit"', /commit/],
]) t(`forbidden candidate ${label} sends zero inputs`, async tab => {
  await ops.evaluate(conn,tab,`document.body.innerHTML=${JSON.stringify(`<main><form><button ${attrs || 'type="button"'}>${label}</button></form></main>`)};window.inputs=0;document.querySelector('button').onclick=e=>{e.preventDefault();inputs++}`);
  const j=fakeJev({choice:q=>({choice:optionWith(q,label),p:.95}),noul:()=>.04});
  const r=await runSteps(conn,tab,['try click "the appropriate control" up to 2 => "expected result"'],{jev:j,noNotes:true,traceRun:false,prefetch:false});
  assert.equal(r.done,false);
  assert.match(r.stopped.reason,expected);
  assert.equal(await ops.evaluate(conn,tab,'inputs'),0);
  assert.equal(r.candidate_attempts||0,0);
  if(label==='Send message') fs.appendFileSync('/tmp/codex-bc/dsl-b-try-samples.txt','\n\n'+formatSteps(r));
});

t('accepted owned detail remains current for following extraction',async tab=>{
  // The extraction request sees the accepted detail, rather than the unchanged list.
  const baseJudge=fakeJev({choice:(q,id)=>id==='pick'?{choice:optionWith(q,'Hotel 1'),probabilities:{[optionWith(q,'Hotel 1')]:.55,[optionWith(q,'Hotel 2')]:.4,none:.05}}:optionWith(q,'Correct hotel'),noul:(q,id,state)=>id==='prev_expect'?(JSON.stringify(state).includes('Correct hotel')?.75:.25):.04});
  const r=await runSteps(conn,tab,['try pick "a suitable hotel" up to 2 => "suitable hotel"','extract "hotel name"'],{jev:baseJudge,noNotes:true,traceRun:false,prefetch:false,minP:.3});
  try {
    assert.equal(r.done,true,JSON.stringify(r.stopped));
    assert.equal(r.extracted[0].value,'Correct hotel');
    assert.ok(baseJudge.calls.some(c=>c.questions.extract && JSON.stringify(c.state).includes('Correct hotel')));
    assert.equal(await ops.evaluate(conn,tab,'location.pathname'),'/source');
  } finally { for(const id of r.owned_tabs||[]) await ops.closeTab(conn,id); }
});

t('lost navigation acknowledgement never sends the candidate twice',async tab=>{
  const original=conn.send;
  let deliveries=0;
  conn.send=async function(...args) {
    if(args.some(a=>a==='Page.navigate') && args.some(a=>a && typeof a==='object' && String(a.url||'').includes('/detail'))) {
      deliveries++;
      await original.apply(this,args);
      throw new Error('Lost Page.navigate acknowledgement');
    }
    return original.apply(this,args);
  };
  let r;
  try { r=await run(tab,judge()); } finally { conn.send=original; }
  assert.equal(r.done,false);
  assert.match(r.stopped.reason,/Lost Page.navigate acknowledgement/);
  assert.equal(deliveries,1);
  assert.equal(hits.filter(h=>h.startsWith('/detail')).length,1);
  assert.deepEqual(r.owned_tabs,[]);
});

const tabsMarkup = `<main><div role="tablist"><button role="tab" id="a" aria-selected="true" aria-controls="pa">Overview</button><button role="tab" id="b" aria-selected="false" aria-controls="pb">Reviews one</button><button role="tab" id="c" aria-selected="false" aria-controls="pc">Reviews two</button></div><section id="pa">Count 12</section><section id="pb" hidden>Wrong reviews</section><section id="pc" hidden>Correct reviews</section></main>`;
for(const mode of ['failed restore question','changed filter count']) t(`tab ${mode} stops before next candidate`,async tab=>{
  await ops.evaluate(conn,tab,`document.body.innerHTML=${JSON.stringify(tabsMarkup)};window.inputs=0;document.querySelectorAll('[role=tab]').forEach(t=>t.onclick=()=>{inputs++;document.querySelectorAll('[role=tab]').forEach(x=>{x.setAttribute('aria-selected',String(x===t));document.getElementById(x.getAttribute('aria-controls')).hidden=x!==t});${mode==='changed filter count'?"if(inputs===2)document.getElementById('pa').textContent='Count 13'":''}})`);
  const j=fakeJev({choice:q=>({choice:optionWith(q,'Reviews one'),probabilities:{[optionWith(q,'Reviews one')]:.55,[optionWith(q,'Reviews two')]:.4,none:.05}}),noul:(q,id)=>id==='restore'?(mode==='failed restore question'?.1:.95):id==='prev_expect'?.25:.04});
  const r=await runSteps(conn,tab,['try click "Reviews" up to 2 => "correct reviews"'],{jev:j,noNotes:true,traceRun:false,prefetch:false,minP:.3});
  assert.equal(r.done,false);
  assert.match(r.stopped.reason,/Restoration failed/);
  assert.equal(await ops.evaluate(conn,tab,'inputs'),2);
});

t('deadline after candidate check prevents next navigation',async tab=>{
  const j=judge(()=>.25),fetch=j.fetchImpl,now=Date.now;
  j.fetchImpl=async(url,init)=>{const result=await fetch(url,init);if(JSON.parse(init.body).questions.prev_expect)Date.now=()=>now()+180000;return result;};
  let r;
  try { r=await run(tab,j); } finally { Date.now=now; }
  assert.equal(r.done,false);
  assert.match(r.stopped.reason,/deadline/i);
  assert.equal(hits.filter(h=>h.startsWith('/detail')).length,1);
});

t('literal attempt bound exhausts with partial rows', async tab => {
  const r = await runSteps(conn, tab, ['try pick "a suitable hotel" up to 2 => "suitable"'], { jev: judge(() => .25), noNotes: true, traceRun: false, prefetch: false, minP: .3 });
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /exhausted/);
  assert.equal(r.candidate_attempts, 2);
  assert.deepEqual(r.attempts.map(a => a.check_p), [.25, .25]);
  assert.ok(r.attempts.every(a => a.rejection_reason));
});

t('none first and source error stop before any action', async tab => {
  const none = judge(() => .25, { choice: () => ({ choice: 'none', probabilities: { none: .9 } }) });
  const r = await run(tab, none);
  assert.match(r.stopped.reason, /none/);
  assert.equal(r.candidate_attempts, 0);
  assert.equal(hits.filter(h => h.startsWith('/detail')).length, 0);
  const error = judge(() => .25, { noul: (q, id) => id === 'error' ? .95 : .04 });
  const failed = await run(tab, error);
  assert.match(failed.stopped.reason, /error/);
  assert.equal(hits.filter(h => h.startsWith('/detail')).length, 0);
});

t('nested pending expectation fails before retry action and later leaves', async tab => {
  const j = judge(() => .1, { noul: (q, id) => id === 'cond' ? .95 : id === 'prev_expect' ? .1 : .04 });
  const r = await runSteps(conn, tab, ['if "ready" { wait 1 => "outer action completed"; try pick "a suitable hotel" up to 2 => "candidate completed"; wait 1 }'], { jev: j, noNotes: true, traceRun: false, prefetch: false });
  assert.equal(r.done, false);
  assert.equal(r.stop_path, '1.then.1');
  assert.equal(hits.filter(h => h.startsWith('/detail')).length, 0);
  const bundled = j.calls.find(c => c.questions.pick && c.questions.prev_expect);
  assert.match(bundled.questions.prev_expect.instructions, /outer action completed/);
});

for (const flag of ['challenge', 'login', 'error', 'dialog']) t(`settled ${flag} stops without another candidate`, async tab => {
  const j = judge(() => .25), fetch = j.fetchImpl;
  j.fetchImpl = async (url, init) => {
    const response = await fetch(url, init);
    if (!JSON.parse(init.body).questions.prev_expect) return response;
    const body = await response.json();
    body.answers[flag] = { type: 'noul', noul: .95 };
    return { ...response, json: async () => body };
  };
  const r = await run(tab, j);
  assert.match(r.stopped.reason, new RegExp(flag));
  assert.equal(hits.filter(h => h.startsWith('/detail')).length, 1);
  assert.deepEqual(r.owned_tabs, []);
});

t('native dialog on source prevents candidate navigation', async tab => {
  await ops.evaluate(conn, tab, 'const d=document.createElement("dialog");d.textContent="Confirm";document.body.append(d);d.showModal()');
  const r = await run(tab, judge());
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /dialog/);
  assert.equal(hits.filter(h => h.startsWith('/detail')).length, 0);
});

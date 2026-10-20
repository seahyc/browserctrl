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
const haveBrowser = Boolean(chromeBinary());
before(async () => {
  if (!haveBrowser) return;
  server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Profile form</title><main><h1>Profile</h1><form><label>First name<input id="first"></label><label>Last name<input id="last"></label></form></main>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await startHeadlessBrowser(TEST_PORT);
  conn = await connect(TEST_PORT);
});
after(async () => { try { await conn?.stop(); } catch {} conn?.close(); await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
const t = (name, fn) => test(name, { skip: !haveBrowser }, async () => {
  const tab = (await ops.newTab(conn, base)).targetId;
  await ops.waitForReady(conn, tab);
  await ops.evaluate(conn, tab, 'window.inputs=[];document.addEventListener("input",e=>inputs.push(e.target.id))');
  try { await fn(tab); } finally { await ops.closeTab(conn, tab); }
});
const good = () => fakeJev({ choice: (q, id) => optionWith(q, id === 'target.1' ? 'First name' : 'Last name'), noul: (q, id) => id === 'prev_expect' ? .95 : .01 });
const run = (tab, j = good(), prefix = []) => runSteps(conn, tab, [...prefix, 'same page { fill "First name" = "Ada"; fill "Last name" = "Lovelace" }'], { jev: j, noNotes: true, traceRun: false, prefetch: false });
const inputs = tab => ops.evaluate(conn, tab, 'inputs');
t('stable exact form fills once each without target model questions', async tab => {
  const j = good(), r = await run(tab, j);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  fs.writeFileSync('/tmp/codex-bc/dsl-b-samepage-sample.txt', formatSteps(r) + '\n');
  assert.deepEqual(await inputs(tab), ['first', 'last']);
  assert.equal(j.calls.some(c => Object.keys(c.questions).some(k => k.startsWith('target.'))), false);
});
t('redraw after first fill regrounds remaining fields and never replays first', async tab => {
  await ops.evaluate(conn, tab, 'first.addEventListener("input",()=>{last.outerHTML="<input id=last>"},{once:true})');
  const r = await run(tab);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(await inputs(tab), ['first', 'last']);
  assert.equal(r.steps.find(s => s.same_page?.regrounds)?.same_page.regrounds, 1);
});
t('dependent disabled field stops before any inputs', async tab => {
  await ops.evaluate(conn, tab, 'last.disabled=true;first.oninput=()=>last.disabled=false');
  const r = await run(tab);
  assert.equal(r.done, false);
  assert.deepEqual(await inputs(tab), []);
});
t('new dialog after first fill prevents remaining input', async tab => {
  await ops.evaluate(conn, tab, 'first.oninput=()=>{const d=document.createElement("dialog");d.textContent="Please confirm your account";document.body.append(d);d.showModal()}');
  const r = await run(tab);
  assert.equal(r.done, false);
  assert.deepEqual(await inputs(tab), ['first']);
});
t('new validation regrounds remaining fields without replay', async tab => {
  await ops.evaluate(conn, tab, 'first.oninput=()=>{const p=document.createElement("p");p.setAttribute("role","status");p.textContent="Name accepted";first.after(p)}');
  const r = await run(tab);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(await inputs(tab), ['first', 'last']);
});
t('semantic targets share target.1 and target.2 with pending expectation', async tab => {
  const j = good();
  const r = await runSteps(conn, tab, ['fill "First name" = "Grace" => "name was entered"', 'same page { fill "given name field" = "Ada"; fill "family name field" = "Lovelace" }'], { jev: j, noNotes: true, traceRun: false, prefetch: false });
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(j.calls.filter(c => c.questions['target.1'] && c.questions['target.2'] && c.questions.prev_expect).length, 1);
  assert.deepEqual(await inputs(tab), ['first', 'first', 'last']);
});
t('failed enclosing pending check prevents all batch inputs', async tab => {
  const j = fakeJev({ choice: (q, id) => optionWith(q, id === 'target.1' ? 'First name' : 'Last name'), noul: () => .01 });
  const r = await runSteps(conn, tab, ['fill "First name" = "Grace" => "name was entered"', 'same page { fill "given name field" = "Ada"; fill "family name field" = "Lovelace" }'], { jev: j, noNotes: true, traceRun: false, prefetch: false });
  assert.equal(r.done, false);
  assert.deepEqual(await inputs(tab), ['first']);
  assert.ok(j.calls.some(c => c.questions['target.1'] && c.questions['target.2'] && c.questions.prev_expect));
});
t('dynamic chips and different form contexts reject before input', async tab => {
  await ops.evaluate(conn, tab, 'first.setAttribute("aria-controls","suggestions")');
  const chips = await run(tab);
  assert.equal(chips.done, false);
  assert.deepEqual(await inputs(tab), []);
  await ops.evaluate(conn, tab, 'first.removeAttribute("aria-controls");const form=document.createElement("form");document.body.append(form);form.append(last.closest("label"))');
  const forms = await run(tab);
  assert.equal(forms.done, false);
  assert.deepEqual(await inputs(tab), []);
});
t('earlier input changing a later value stops as a dependency', async tab => {
  await ops.evaluate(conn, tab, 'first.oninput=()=>last.value="derived"');
  const r = await run(tab);
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /depends on an earlier input/);
  assert.deepEqual(await inputs(tab), ['first']);
});
t('lost fill acknowledgement stops without resending input or running later fill', async tab => {
  const original = conn.send;
  let deliveries = 0;
  conn.send = async function (...args) {
    if (args[1] === 'Input.insertText') {
      deliveries++;
      await original.apply(this, args);
      throw new Error('Lost Input.insertText acknowledgement');
    }
    return original.apply(this, args);
  };
  let r;
  try { r = await run(tab); } finally { conn.send = original; }
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /Lost Input.insertText acknowledgement/);
  assert.equal(deliveries, 1);
  assert.deepEqual(await inputs(tab), ['first']);
});

t('exact stable fields need no model', async tab => {
  const options = { key: { key: null }, noNotes: true, traceRun: false, prefetch: false };
  const plan = 'same page { fill "First name" = "Ada"; fill "Last name" = "Lovelace" }';
  const r = await runSteps(conn, tab, [plan], options);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.equal(r.jev_calls, 0);
  assert.deepEqual(await inputs(tab), ['first', 'last']);
});

t('a pending expectation cannot be skipped after the model key becomes unavailable', async tab => {
  const j = good();
  const r = await runSteps(conn, tab, ['fill "First name" = "Grace" => "first input accepted"', 'same page { fill "Last name" = "Lovelace" }'], {
    jev: j, noNotes: true, traceRun: false, prefetch: false,
    onStep: async row => { if (row.step === 1) j.cfg.key = null; },
  });
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /pending expectation/);
  assert.deepEqual(await inputs(tab), ['first']);
});

t('lost acknowledgement while clearing a field stops after one Backspace', async tab => {
  await ops.evaluate(conn, tab, 'first.value="Old name"');
  const original = conn.send;
  let deliveries = 0;
  conn.send = async function (...args) {
    if (args[1] === 'Input.dispatchKeyEvent' && args[2]?.type === 'rawKeyDown') {
      deliveries++;
      await original.apply(this, args);
      throw new Error('Backspace timed out');
    }
    return original.apply(this, args);
  };
  let r;
  try {
    r = await runSteps(conn, tab, ['same page { fill "First name" = ""; fill "Last name" = "Lovelace" }'], { jev: good(), noNotes: true, traceRun: false, prefetch: false });
  } finally { conn.send = original; }
  assert.equal(r.done, false);
  assert.match(r.stopped.reason, /Backspace timed out/);
  assert.equal(deliveries, 1);
  assert.deepEqual(await inputs(tab), ['first']);
});

t('native validation without DOM mutation regrounds only unfinished fills', async tab => {
  await ops.evaluate(conn, tab, 'first.oninput=()=>{first.setCustomValidity("Invalid first name");first.reportValidity()}');
  const r = await run(tab);
  assert.equal(r.done, true, JSON.stringify(r.stopped));
  assert.deepEqual(await inputs(tab), ['first', 'last']);
  assert.equal(r.steps.find(s => s.same_page?.requested)?.same_page.regrounds, 1);
});

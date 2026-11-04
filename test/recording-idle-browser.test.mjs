import './isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {connect} from '../lib/daemon.mjs';
import {all} from '../lib/rec.mjs';
import {SOCK} from '../lib/env.mjs';
import * as ops from '../lib/ops.mjs';
import {submitVaultFill, daemonTrusted} from '../lib/vault-fill.mjs';
import {chromeBinary, startHeadlessBrowser} from './helpers.mjs';

const SAFE = 'SAFE_RECORDING_POSITIVE_CONTROL_92745';
const CANARY = 'synthetic_canary_59173@example.test';
const page = `<!doctype html><title>Fixture</title><p>${SAFE}</p><input id="user" type="email"><div id="echo"></div><button id="next">Next</button><script>
const input=document.querySelector('#user'); input.addEventListener('input',()=>document.querySelector('#echo').textContent=input.value);
document.querySelector('#next').onclick=()=>{sessionStorage.setItem('v',input.value);location.href='/next'};
</script>`;
const next = `<!doctype html><title>Next</title><p id="echo"></p><script>document.querySelector('#echo').textContent=sessionStorage.getItem('v')</script>`;

async function freePort() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port; await new Promise(r => s.close(r)); return port;
}

function files(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir, {recursive:true})) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isFile()) out[name] = fs.readFileSync(file);
  }
  return out;
}

test('idle finalization allows protected fill without recording later canary or navigation', {skip:!chromeBinary(), timeout:60000}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-idle-browser-'));
  const clock = path.join(dir, 'clock'); let now = Date.now(); fs.writeFileSync(clock, String(now));
  process.env.BROWSERCTRL_TEST_CLOCK = clock;
  process.env.BROWSERCTRL_REC_IDLE_MIN = '1';
  process.env.BROWSERCTRL_REC_STILLS = 'on'; process.env.BROWSERCTRL_CAPTURE = '0';
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --import ${path.resolve('test/fixtures/daemon-clock.mjs')}`.trim();
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(dir,'key.pem'),'-out',path.join(dir,'cert.pem'),'-subj','/CN=localhost','-days','1'], {stdio:'ignore'});
  const server = https.createServer({key:fs.readFileSync(path.join(dir,'key.pem')),cert:fs.readFileSync(path.join(dir,'cert.pem'))}, (req,res) => {
    res.setHeader('content-type','text/html'); res.setHeader('cache-control','no-store'); res.end(req.url === '/next' ? next : page);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port = await freePort(), browser = await startHeadlessBrowser(port);
  let conn, pid, target;
  t.after(async () => {
    if (target && conn) try { await conn.browser('Target.closeTarget',{targetId:target}); } catch {}
    conn?.close(); if (pid) try { process.kill(pid,'SIGTERM'); } catch {}
    await browser.close(); await new Promise(r=>server.close(r)); fs.rmSync(dir,{recursive:true,force:true});
  });
  conn = await connect(port,{mediated:true});
  pid = (await conn.status()).pid;
  await conn.browser('Security.setIgnoreCertificateErrors',{ignore:true});
  const origin = `https://127.0.0.1:${server.address().port}`;
  target = (await conn.browser('Target.createTarget',{url:origin+'/'})).targetId;
  const until = async fn => { for(let i=0;i<150;i++){if(await fn())return;await new Promise(r=>setTimeout(r,30));} throw Error('fixture wait timed out'); };
  await until(async()=>await ops.evaluate(conn,target,"document.readyState==='complete' && !!document.querySelector('#user')").catch(()=>false));
  const out = path.join(dir,'recording');
  await conn.recording('start',target,{out});
  const fill = () => submitVaultFill({version:2,request_id:crypto.randomUUID(),deadline:now/1000+50,destination:{browser:'dia',origins:[origin],tab_id:target,element:'#user'},field:'username',value:CANARY},{port});
  assert.equal(await daemonTrusted(SOCK(port),port),true);
  const refused = await fill();
  assert.equal(refused.code,'capture_or_action_active'); assert.equal(refused.input_attempted,false);
  now += 61000; fs.writeFileSync(clock,String(now)); process.kill(pid,'SIGUSR2');
  await until(()=>!all()[target]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out,'meta.json'))).stopReason,'owner_idle');
  const before = files(out);
  const rr = zlib.brotliDecompressSync(before['rrweb.ndjson.br']).toString();
  assert.match(rr,new RegExp(SAFE));
  assert.ok(Object.keys(before).some(k=>k.startsWith('trajectory/') && k.endsWith('.jpg')), 'real screenshot positive control is required');
  const filled = await fill();
  assert.deepEqual(filled,{status:'completed',verification:'filled',input_attempted:true,action_may_have_run:false});
  assert.equal(await ops.evaluate(conn,target,"document.querySelector('#echo').textContent.length"),CANARY.length);
  await ops.click(conn,target,{selector:'#next'});
  await until(async()=>await ops.evaluate(conn,target,"location.pathname==='/next' && document.querySelector('#echo').textContent.length").catch(()=>0)===CANARY.length);
  assert.equal(await ops.evaluateInWorld(conn,target,'typeof window.__bcRec'), 'undefined', 'recorder hook must not reattach on navigation');
  await new Promise(r=>setTimeout(r,300));
  const after = files(out);
  assert.deepEqual(Object.keys(after).sort(),Object.keys(before).sort());
  for(const [name,data] of Object.entries(after)) {
    assert.deepEqual(data,before[name],`${name} changed after recording finalized`);
    const content=name.endsWith('.br') ? zlib.brotliDecompressSync(data) : data;
    assert.equal(content.includes(Buffer.from(CANARY)),false,`${name} contains the canary`);
  }
});

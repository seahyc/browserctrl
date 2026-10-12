import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {connect} from '../lib/daemon.mjs';
import {waitForBackgroundReady} from '../lib/readiness.mjs';
import * as claims from '../lib/claims.mjs';
import {startHeadlessBrowser,startFixtureServer,chromeBinary} from './helpers.mjs';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../',import.meta.url));

test('shared daemon exposes activity and pause across SDK, CLI and MCP without taking focus', {skip: !chromeBinary(),timeout:90000}, async t => {
  const reserve = net.createServer();
  await new Promise(resolve => reserve.listen(0,'127.0.0.1',resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'browserctrl-activity-integration-'));
  const previous = process.env.CDP_ACTIVITY_FILE;
  const previousTrace = process.env.CDP_DIAGNOSTIC_LOG;
  process.env.CDP_ACTIVITY_FILE = path.join(directory,'activity.json');
  process.env.CDP_DIAGNOSTIC_LOG = path.join(directory,'protocol.jsonl');
  let browser,fixture,a,b,controller,client;
  const tabs = [];
  t.after(async () => {
    if(controller) {
      await controller.activity('resume',{owner:'activity-integration-a'}).catch(()=>{});
      await controller.stop().catch(()=>{});
      controller.close();
    }
    a?.close();b?.close();
    await client?.close();
    await browser?.close();
    await fixture?.close();
    for(const [targetId,owner] of tabs) if(claims.get(port,targetId)?.owner === owner) claims.release(port,targetId,{owner});
    if(previous === undefined) delete process.env.CDP_ACTIVITY_FILE; else process.env.CDP_ACTIVITY_FILE=previous;
    if(previousTrace === undefined) delete process.env.CDP_DIAGNOSTIC_LOG; else process.env.CDP_DIAGNOSTIC_LOG=previousTrace;
    fs.rmSync(directory,{recursive:true,force:true});
  });
  fixture = await startFixtureServer();
  browser = await startHeadlessBrowser(port);
  a=await connect(port,{owner:'activity-integration-a',label:'reviewer'});
  b=await connect(port,{owner:'activity-integration-b',label:'other'});
  controller=await connect(port,{owner:'activity-integration-controller'});
  const first=await a.browser('Target.createTarget',{url:fixture.url,background:true});
  const second=await b.browser('Target.createTarget',{url:fixture.url,background:true});
  tabs.push([first.targetId,'activity-integration-a'],[second.targetId,'activity-integration-b']);
  const ready=await waitForBackgroundReady(a,first.targetId,{selector:'#name',text:'Fixture page'});
  assert.equal(ready.ready,true);
  assert.equal(ready.focused,false);
  await waitForBackgroundReady(b,second.targetId);
  const trace=fs.readFileSync(path.join(directory,'protocol.jsonl'),'utf8');
  assert.doesNotMatch(trace,/Target.activateTarget|Page.bringToFront|Page.navigate|Page.reload/);
  t.diagnostic('Checking CLI reload and refresh');
  for (const command of ['reload','refresh']) {
    await a.send(first.targetId,'Runtime.evaluate',{expression:'globalThis.__reloadProof = 1'});
    const commandResult = await exec(process.execPath,[path.join(root,'bin/browserctrl.mjs'),command,first.targetId,'--port',String(port)],{env:{...process.env,CDP_AGENT_ID:'activity-integration-a'}});
    assert.equal(JSON.parse(commandResult.stdout).focused,false);
    const marker = await a.send(first.targetId,'Runtime.evaluate',{expression:'typeof globalThis.__reloadProof',returnByValue:true});
    assert.equal(marker.result.value,'undefined');
  }
  await a.activity('describe',{intent:'Reviewing guide links',completed:0,total:91});
  for(let i=0;i<5;i++) {
    await a.send(first.targetId,'Page.navigate',{url:fixture.url});
    await waitForBackgroundReady(a,first.targetId);
  }
  assert.match(a.takeWarnings().join('\n'),/activity-integration-a.*navigation/);
  const listed=await controller.activity();
  assert.equal(listed.agents.find(x=>x.owner==='activity-integration-a').intent,'Reviewing guide links');
  assert.ok(listed.agents.find(x=>x.owner==='activity-integration-a').tabIds.includes(first.targetId));
  const env={...process.env,CDP_AGENT_ID:'activity-integration-controller'};
  const py = await exec(process.platform === 'win32' ? 'python' : 'python3', ['-c', `import json; from chrome_cdp import ChromeCDP
with ChromeCDP(port=${port}) as c:
 print(json.dumps(c.activity()))`], {env: {...env, PYTHONPATH: path.join(root,'python')}});
  assert.ok(JSON.parse(py.stdout).agents.some(x=>x.owner==='activity-integration-a'));
  const cli=await exec(process.execPath,[path.join(root,'bin/browserctrl.mjs'),'activity','--port',String(port),'--json'],{env});
  assert.ok(JSON.parse(cli.stdout).agents.some(x=>x.owner==='activity-integration-a'));
  client=new Client({name:'activity-integration',version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'mcp/server.mjs')],env,stderr:'pipe'}));
  await a.send(first.targetId, 'Emulation.setFocusEmulationEnabled', {enabled:true});
  const result=await client.callTool({name:'browser_activity',arguments:{port,agentId:'activity-integration-controller',action:'pause',owner:'activity-integration-a'}});
  assert.ok(!result.isError,JSON.stringify(result));
  await a.send(first.targetId, 'Emulation.setFocusEmulationEnabled', {enabled:false});
  await assert.rejects(a.send(first.targetId, 'Emulation.setFocusEmulationEnabled', {enabled:true}), /paused/);
  await assert.rejects(a.send(first.targetId,'Runtime.evaluate',{expression:'document.title',returnByValue:true}),/paused/);
  await assert.rejects(a.browser('Target.activateTarget',{targetId:first.targetId}),/paused/);
  assert.ok((await b.send(second.targetId,'Runtime.evaluate',{expression:'document.title',returnByValue:true})).result.value);
  assert.equal(claims.get(port,first.targetId).owner,'activity-integration-a');
  await controller.activity('resume',{owner:'activity-integration-a'});
  const waited=await client.callTool({name:'browser_wait',arguments:{port,agentId:'activity-integration-a',tab:first.targetId,readyState:'load'}});
  assert.ok(!waited.isError,JSON.stringify(waited));
  const observation=JSON.parse(waited.content[0].text);
  assert.equal(observation.ready,true);
  assert.equal(observation.focused,false);
  t.diagnostic('Checking MCP reload and refresh');
  for (const name of ['browser_reload','browser_refresh']) {
    const reloaded=await client.callTool({name,arguments:{port,agentId:'activity-integration-a',tab:first.targetId}});
    assert.ok(!reloaded.isError,JSON.stringify(reloaded));
    assert.equal(JSON.parse(reloaded.content[0].text).focused,false);
  }
  t.diagnostic('Checking Python focus/reload aliases');
  await exec(process.platform === 'win32' ? 'python' : 'python3', ['-c', `from chrome_cdp import ChromeCDP
with ChromeCDP(port=${port}) as c:
 t=c.attach('${first.targetId}')
 assert c.reload(t)['reloaded']
 assert c.refresh(t)['reloaded']
 assert c.focus(t)['activated']
 assert c.wake(t)['activated']`], {env: {...process.env,CDP_AGENT_ID:'activity-integration-a',PYTHONPATH:path.join(root,'python')}});
  for (const name of ['browser_focus','browser_wake']) {
    const focused=await client.callTool({name,arguments:{port,agentId:'activity-integration-a',tab:first.targetId}});
    assert.ok(!focused.isError,JSON.stringify(focused));
    assert.equal(JSON.parse(focused.content[0].text).activated,first.targetId.slice(0,8));
  }
  for (const command of ['focus','wake']) {
    const selected=await exec(process.execPath,[path.join(root,'bin/browserctrl.mjs'),command,first.targetId,'--port',String(port)],{env:{...process.env,CDP_AGENT_ID:'activity-integration-a'}});
    assert.equal(JSON.parse(selected.stdout).activated,first.targetId.slice(0,8));
  }
  console.log(JSON.stringify({backgroundReady:true,rapidNavigationWarning:true,cliActivity:true,pythonActivity:true,mcpPause:true,otherOwnerContinues:true,claimsPreserved:true,resumeWithoutReplay:true,focusCleanupWhilePaused:true}));
});

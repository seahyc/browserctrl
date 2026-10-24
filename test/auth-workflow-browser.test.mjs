import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import {execFileSync,spawn} from 'node:child_process';
import {connect} from '../lib/daemon.mjs';
import {release,get as getClaim} from '../lib/claims.mjs';
import {chromeBinary,startHeadlessBrowser} from './helpers.mjs';

const vaultSource=process.env.AGENT_VAULT_SOURCE||path.resolve(import.meta.dirname,'../../agent-vault/src');
const python=process.env.AGENT_VAULT_PYTHON||path.resolve(vaultSource,'../.venv/bin/python');
const available=chromeBinary()&&fs.existsSync(python)&&fs.existsSync(vaultSource+'/agent_vault/adapters/auth_workflow.py');
const run=(argv,input)=>new Promise((resolve,reject)=>{const child=spawn(argv[0],argv.slice(1),{stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',code=>code?reject(Error(`fixture runner failed (${code}): ${err}`)):resolve(JSON.parse(out)));child.stdin.end(JSON.stringify(input));});

test('complete protected workflow: password, authenticated mail, OTP, resend and retained tab', {skip:!available,timeout:120000},async t=>{
  process.env.BROWSERCTRL_AGENT_ID='auth-fixture-'+crypto.randomUUID();process.env.BROWSERCTRL_CAPTURE='0';process.env.BROWSERCTRL_TRACE='0';
  const temp=fs.mkdtempSync('/tmp/bc-auth-workflow-');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(temp,'key.pem'),'-out',path.join(temp,'cert.pem'),'-subj','/CN=localhost','-days','1'],{stdio:'ignore'});
  const mail=path.join(temp,'mail.json');let mode='six',passwordCalls=0,codeCalls=0,resendCalls=0,currentTarget;
  const publish=()=>fs.writeFileSync(mail,JSON.stringify({internalDate:String(Math.floor(Date.now()/1000)*1000),payload:{mimeType:'text/plain',headers:[{name:'From',value:'verify@example.net'},{name:'To',value:'alice@example.com'},{name:'Authentication-Results',value:'mx.google.com; dkim=pass header.d=example.net'}],body:{data:Buffer.from('Your verification code is 654321').toString('base64url')}}}),{mode:0o600});
  const server=https.createServer({key:fs.readFileSync(path.join(temp,'key.pem')),cert:fs.readFileSync(path.join(temp,'cert.pem'))},(q,r)=>{
    r.setHeader('cache-control','no-store');
    if(q.url==='/session'){r.setHeader('content-type','application/json');r.statusCode=q.headers.cookie?.includes(`session=${mode}`)?200:401;r.end(JSON.stringify(r.statusCode===200?{id:'synthetic-user'}:{error:'unauthorized'}));return;}
    r.setHeader('content-type','text/html');
    if(q.url==='/checkpoint'){r.end('<h1>Clean document</h1>');return;}
    if(q.url==='/frame'){r.end('<p>Application frame</p>');return;}
    if(q.method==='POST'){
      let body='';q.on('data',b=>body+=b);q.on('end',()=>{
        const data=new URLSearchParams(body);
        if(q.url==='/login'){assert.equal(data.get('password'),'synthetic-private-password');passwordCalls++;release(port,currentTarget,{owner:process.env.BROWSERCTRL_AGENT_ID});if(mode==='six')publish();r.end('ok');}
        else if(q.url==='/resend'){resendCalls++;publish();r.end('ok');}
        else if(q.url==='/verify'){assert.equal(data.get('code'),'654321');codeCalls++;r.setHeader('set-cookie',`session=${mode}; Secure; HttpOnly; SameSite=Strict`);r.end('ok');}
        else{r.statusCode=404;r.end('unknown');}
      });return;
    }
    const challenge=mode==='six'?'<div id="challenge">'+Array(6).fill('<input inputmode="numeric">').join('')+'</div>':'<input id="challenge"><button id="verify" disabled>Verify</button>';
    r.end(`<form id="login"><input id="username"><input id="password" type="password"><button id="submit" disabled>Sign in</button></form><script>
      const password=document.querySelector('#password'),button=document.querySelector('#submit');password.addEventListener('input',()=>setTimeout(()=>button.disabled=false,30));
      document.querySelector('#login').onsubmit=async e=>{e.preventDefault();window.retainedPassword=password.value;await fetch('/login',{method:'POST',body:new URLSearchParams({password:password.value})});document.body.innerHTML=${JSON.stringify(challenge+'<button id="resend">Resend code</button>')};
        const verify=async code=>{await fetch('/verify',{method:'POST',body:new URLSearchParams({code})});document.body.innerHTML='<h1>Authenticated</h1><iframe src="/frame"></iframe>';};
        const challenge=document.querySelector('#challenge');${mode==='six'?"challenge.onpaste=e=>{e.preventDefault();verify(e.clipboardData.getData('text'));};":"challenge.oninput=()=>document.querySelector('#verify').disabled=!/^\\d{6}$/.test(challenge.value);document.querySelector('#verify').onclick=()=>verify(challenge.value);"}
        document.querySelector('#resend').onclick=()=>fetch('/resend',{method:'POST'});
      };
    </script>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`https://127.0.0.1:${server.address().port}`;
  const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const browser=await startHeadlessBrowser(port);let client;
  t.after(async()=>{try{await client?.stop();}catch{}client?.close();await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true});});
  client=await connect(port);await client.browser('Security.setIgnoreCertificateErrors',{ignore:true});
  const driver=path.join(temp,'driver.mjs'),busyLog=path.join(temp,'busy.log');
  fs.writeFileSync(driver,`process.env.BROWSERCTRL_HOME=${JSON.stringify(process.env.BROWSERCTRL_HOME)};const {BROWSERS}=await import(${JSON.stringify(new URL('../lib/env.mjs',import.meta.url).href)});BROWSERS.dia.port=${port};const {submitAuthWorkflow}=await import(${JSON.stringify(new URL('../lib/auth-workflow.mjs',import.meta.url).href)});let input='';for await(const chunk of process.stdin)input+=chunk;const result=await submitAuthWorkflow(JSON.parse(input));if(['action_active','capture_or_action_active'].includes(result.code))(await import('node:fs')).appendFileSync(${JSON.stringify(busyLog)},result.code+'\\n');process.stdout.write(JSON.stringify(result)+'\\n');`);
  const gw=path.join(temp,'gw');
  fs.writeFileSync(gw,`#!${python}\nimport sys,json,pathlib\na=sys.argv;p=json.loads(a[a.index('--params')+1]);resource,method=a[a.index('gmail')+1:a.index('gmail')+3]\nif method=='getProfile':r={'emailAddress':'alice@example.com'}\nelif method=='list':r={'messages':[{'id':'synthetic-mail'}]} if pathlib.Path(${JSON.stringify(mail)}).exists() else {}\nelse:r=json.loads(pathlib.Path(${JSON.stringify(mail)}).read_text())\nprint(json.dumps(r))\n`,{mode:0o700});
  const runner=path.join(temp,'runner.py');
  fs.writeFileSync(runner,`import sys,json\nsys.path.insert(0,${JSON.stringify(vaultSource)})\nfrom agent_vault.adapters.auth_workflow import WorkflowExecutor\ne=WorkflowExecutor([${JSON.stringify(process.execPath)},${JSON.stringify(driver)}],${JSON.stringify(gw)},'alice@example.com')\nprint(json.dumps(e('execute',json.load(sys.stdin))))\n`);
  for(const kind of ['six','single']){
    mode=kind;passwordCalls=codeCalls=resendCalls=0;fs.rmSync(mail,{force:true});
    const {targetId}=await client.browser('Target.createTarget',{url:origin+'/'});currentTarget=targetId;
    for(let i=0;i<100;i++){const v=await client.send(targetId,'Runtime.evaluate',{expression:'!!document.querySelector("#password")',returnByValue:true});if(v.result?.value)break;await new Promise(r=>setTimeout(r,20));}
    const params={operation_id:crypto.randomUUID(),action:'browser.login.workflow',deadline:Date.now()/1000+115,credential:{fields:{username:'synthetic-user',password:'synthetic-private-password'}},destination:{browser:'dia',tab_id:targetId,origin,login:{fields:{username:'#username',password:'#password'},submit:'#submit'},challenge:{selector:'#challenge',submit:kind==='six'?'@auto':'#verify',resend:{selector:'#resend',text:'Resend',max_attempts:1,cooldown_seconds:30}},success:{path:'/session',required_keys:['id']},cleanup_path:'/checkpoint',return_path:'/',email_code:{account:'alice@example.com',recipient:'alice@example.com',sender:'verify@example.net',dkim_domain:'example.net',max_age_seconds:300,code_digits:6}}};
    const busy=kind==='six'?client.send(targetId,'Runtime.evaluate',{expression:'new Promise(resolve=>setTimeout(()=>resolve(true),2500))',awaitPromise:true,returnByValue:true}):Promise.resolve();
    const pending=run([python,runner],params);
    for(let i=0;i<400;i++){if((await client.status()).sensitivePhaseBlocked)break;await new Promise(r=>setTimeout(r,20));}
    assert.equal((await client.status()).sensitivePhaseBlocked,true);
    await assert.rejects(client.send(targetId,'Runtime.evaluate',{expression:'document.body.innerText',returnByValue:true}),/sensitive_phase_blocked/);
    await busy;const result=await pending;
    if(kind==='six')assert.match(fs.readFileSync(busyLog,'utf8'),/action_active/);
    assert.equal(result.output?.state,'authenticated',JSON.stringify(result));
    assert.equal(getClaim(port,targetId)?.owner,process.env.BROWSERCTRL_AGENT_ID);
    assert.equal(passwordCalls,1);assert.equal(codeCalls,1);assert.equal(resendCalls,kind==='single'?1:0);
    assert.ok(!JSON.stringify(result).includes('654321'));assert.ok(!JSON.stringify(result).includes('synthetic-private-password'));
    assert.equal((await client.status()).sensitivePhaseBlocked,false);
    assert.ok((await client.browser('Target.getTargets')).targetInfos.some(v=>v.targetId===targetId));
    const state=await client.send(targetId,'Runtime.evaluate',{expression:'({path:location.pathname,retained:window.retainedPassword!==undefined})',returnByValue:true});assert.deepEqual(state.result.value,{path:'/checkpoint',retained:false});
    assert.equal((await client.send(targetId,'Page.getNavigationHistory',{})).entries.length,1);
  }
});

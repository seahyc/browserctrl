#!/usr/bin/env node
import {submitAuthWorkflow} from '../lib/auth-workflow.mjs';
const fail={status:'failed',verification:'not_verified',input_attempted:false,action_may_have_run:false,code:'invalid_workflow_request'};
try{let size=0;const chunks=[];const timer=setTimeout(()=>process.exit(1),10000);timer.unref();for await(const chunk of process.stdin){size+=chunk.length;if(size>32768)throw Error();chunks.push(chunk);}clearTimeout(timer);if(process.argv.length!==2)throw Error();process.stdout.write(JSON.stringify(await submitAuthWorkflow(JSON.parse(Buffer.concat(chunks).toString('utf8'))))+'\n');}catch{process.stdout.write(JSON.stringify(fail)+'\n');}

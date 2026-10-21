#!/usr/bin/env node
// Intentionally no normal CLI argument parser or diagnostic output.
import { submitVaultEntry } from '../lib/vault-entry.mjs';
const failed={status:'failed',verification:'not_verified',input_attempted:false,action_may_have_run:false,code:'invalid_request'};
let size=0, chunks=[];
try {
  const timer=setTimeout(()=>process.exit(1),10000);timer.unref();
  for await(const chunk of process.stdin){size+=chunk.length;if(size>32768)throw Error();chunks.push(chunk);}
  clearTimeout(timer);
  const recover=process.argv.length===3 && process.argv[2]==='--recover';
  if(process.argv.length!==2 && !recover)throw Error();
  const result=await submitVaultEntry(JSON.parse(Buffer.concat(chunks).toString('utf8')),{recover});
  process.stdout.write(JSON.stringify(result)+'\n');
}catch{process.stdout.write(JSON.stringify(failed)+'\n');}

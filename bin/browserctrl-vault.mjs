#!/usr/bin/env node
// Intentionally no normal CLI argument parser or diagnostic output.
import { submitVaultEntry } from '../lib/vault-entry.mjs';
import { submitVaultFill } from '../lib/vault-fill.mjs';
import { submitVaultCard } from '../lib/vault-card.mjs';
import { submitVaultCapture } from '../lib/vault-capture.mjs';
const failed={status:'failed',verification:'not_verified',input_attempted:false,action_may_have_run:false,code:'invalid_request'};
let size=0, chunks=[];
try {
  const timer=setTimeout(()=>process.exit(1),10000);timer.unref();
  for await(const chunk of process.stdin){size+=chunk.length;if(size>32768)throw Error();chunks.push(chunk);}
  clearTimeout(timer);
  const recover=process.argv.length===3 && process.argv[2]==='--recover';
  const continuation=process.argv.length===3 && process.argv[2]==='--continue';
  if(process.argv.length!==2 && !recover && !continuation)throw Error();
  const request=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  // Version 2 fills one field; version 3 captures one displayed value for the trusted caller
  // (its stdout is that caller's private pipe); versions 4/5 privately transfer card fields.
  // Version 1, recovery and workflow continuation
  // keep the original contract.
  const plain=!recover && !continuation;
  const result=plain && [4,5].includes(request?.version) ? await submitVaultCard(request) : plain && request?.version===2 ? await submitVaultFill(request) : plain && request?.version===3 ? await submitVaultCapture(request) : await submitVaultEntry(request,{recover,continuation});
  process.stdout.write(JSON.stringify(result)+'\n');
}catch{process.stdout.write(JSON.stringify(failed)+'\n');}

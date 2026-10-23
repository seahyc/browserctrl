#!/usr/bin/env node
// Persistent continuous workflows. Plans contain data, never executable code.
import readline from 'node:readline';
import {connect} from '../lib/daemon.mjs';
import {requireBrowser} from '../lib/discovery.mjs';
import {resolveTab, navigate} from '../lib/ops.mjs';
import {BatchSession} from '../lib/batch.mjs';
import {WorkflowSession} from '../lib/workflow.mjs';
import {createJevSelector} from '../lib/workflow-selector.mjs';
import {jevKey} from '../lib/jev.mjs';
import {screenshot} from '../lib/ops.mjs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {chmod} from 'node:fs/promises';
import * as claims from '../lib/claims.mjs';
import {agentId} from '../lib/env.mjs';

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let conn, port, target, owned = false;
try {
  if (Boolean(option('--browser')) === Boolean(option('--port'))) throw new Error('Select exactly one --browser or --port');
  if (Boolean(option('--tab')) === Boolean(option('--url'))) throw new Error('Select exactly one --tab or --url');
  const origin = new URL(option('--origin')).origin;
  if (!/^https?:\/\//.test(origin)) throw new Error('Supply an explicit HTTP(S) --origin');
  if (option('--url') && new URL(option('--url')).origin !== origin) throw new Error('Initial URL must match --origin');
  // The same key lookup as do: TYPESAFE_API_KEY, else jev.env in the config folder.
  const jevApiKey = args.includes('--jev') ? jevKey().key : null;
  port = await requireBrowser({browser: option('--browser'), port: option('--port')});
  conn = await connect(port, { mediated: true });
  if (option('--url')) {
    ({targetId: target} = await conn.browser('Target.createTarget', {url: 'about:blank', background: true}));
    owned = true;
  } else {
    ({targetId: target} = await resolveTab(conn, option('--tab')));
  }
  claims.claim(port, target);
  if (owned) {
    await conn.send(target, 'Emulation.setFocusEmulationEnabled', {enabled: true});
    const landed = await navigate(conn, target, option('--url'), {waitUntil: 'load', timeoutMs: 10000});
    if (new URL(landed.url).origin !== origin) throw new Error('Initial navigation left the allowed origin');
  }
  const batch = new BatchSession(conn, target, {
    origin, maxSteps: Number(option('--max-steps') || 12), maxMs: Number(option('--max-ms') || 15000),
  });
  emit({event: 'ready', tab: target, jev_enabled: args.includes('--jev'), snapshot: await batch.observe()});
  for await (const line of readline.createInterface({input: process.stdin})) {
    try {
      const request = JSON.parse(line);
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Expected a JSON object');
      if (request.command === 'close') break;
      claims.claim(port, target);
      if (request.command === 'observe') emit({tab: target, snapshot: await batch.observe()});
      else if (request.command === 'run') {
        const maxModelRequests = Number(option('--max-model-requests') || 4);
        const select = args.includes('--jev') ? createJevSelector({apiKey: jevApiKey, maxRequests: maxModelRequests}) : null;
        const captureFailure = option('--failure-shots') ? async () => {
          const output = path.join(path.resolve(option('--failure-shots')), `workflow-${randomUUID()}.png`);
          await screenshot(conn, target, {path: output});
          await chmod(output, 0o600);
          return output;
        } : null;
        const workflow = new WorkflowSession({batch, select, maxModelRequests, captureFailure,
          maxMs: Number(option('--workflow-ms') || 30000)});
        emit({tab: target, ...await workflow.run(request.plan)});
      }
      else throw new Error('Use observe, run or close');
    } catch (error) {
      emit({status: 'error', error: error.message, replayed: false, inspect_before_retry: true});
    }
  }
} catch (error) {
  emit({status: 'error', error: error.message, replayed: false});
  process.exitCode = 1;
} finally {
  process.stdin.pause();
  process.stdin.unref?.();
  if (target && claims.get(port, target)?.owner === agentId()) {
    if (owned && !args.includes('--keep-open')) await conn.browser('Target.closeTarget', {targetId: target}).catch(() => {});
    claims.release(port, target);
  }
  conn?.close();
}

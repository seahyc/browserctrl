#!/usr/bin/env node
// Persistent guarded browser batches. Plans contain data, never executable code.
import readline from 'node:readline';
import {connect} from '../lib/daemon.mjs';
import {requireBrowser} from '../lib/discovery.mjs';
import {resolveTab, waitForReady} from '../lib/ops.mjs';
import {BatchSession} from '../lib/batch.mjs';
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
  port = await requireBrowser({browser: option('--browser'), port: option('--port')});
  conn = await connect(port, { mediated: true });
  if (option('--url')) {
    ({targetId: target} = await conn.browser('Target.createTarget', {url: option('--url'), background: true}));
    owned = true;
  } else {
    ({targetId: target} = await resolveTab(conn, option('--tab')));
  }
  claims.claim(port, target);
  if (owned) {
    await conn.send(target, 'Emulation.setFocusEmulationEnabled', {enabled: true});
    await waitForReady(conn, target, {timeoutMs: 10000});
  }
  const session = new BatchSession(conn, target, {
    origin, maxSteps: Number(option('--max-steps') || 12), maxMs: Number(option('--max-ms') || 15000),
  });
  emit({event: 'ready', tab: target, snapshot: await session.observe()});
  for await (const line of readline.createInterface({input: process.stdin})) {
    try {
      const request = JSON.parse(line);
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Expected a JSON object');
      if (request.command === 'close') break;
      claims.claim(port, target);
      if (request.command === 'observe') emit({tab: target, snapshot: await session.observe()});
      else if (request.command === 'run') emit({tab: target, ...await session.run(request)});
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

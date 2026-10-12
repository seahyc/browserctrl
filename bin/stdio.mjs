#!/usr/bin/env node
// Persistent, sequential JSON-lines programmatic frontend. One daemon connection per client.
import readline from 'node:readline';
import {connect} from '../lib/daemon.mjs';
import {requireBrowser} from '../lib/discovery.mjs';
import {resolveTab} from '../lib/ops.mjs';
import * as claims from '../lib/claims.mjs';
import {agentId} from '../lib/env.mjs';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (Boolean(option('--browser')) === Boolean(option('--port'))) {
  throw new Error('Specify exactly one --browser or --port');
}
const port = await requireBrowser({browser: option('--browser'), port: option('--port')});
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid explicit port');
let conn = await connect(port);
const held = new Set();
function claim(target) { claims.claim(port, target); held.add(target); }
function release(target) {
  if (claims.get(port, target)?.owner === agentId()) claims.release(port, target);
  held.delete(target);
}
function owned(target) {
  if (!held.has(target)) throw new Error('Attach to or create this tab first');
  claim(target);
}
try {
  for await (const line of readline.createInterface({input: process.stdin})) {
    let request;
    try {
      request = JSON.parse(line);
      const {op, target, method, params = {}, timeout_ms} = request;
      let result;
      if (op === 'health') {
        result = {...await conn.health(), port};
      } else if (op === 'reconnect') {
        // Reconnect only on an explicit caller request. No preceding operation is repeated.
        conn.close();
        conn = await connect(port);
        result = {...await conn.health(), port, requires_observation: true};
      } else if (op === 'new_tab') {
        result = await conn.browser('Target.createTarget', {url: params.url || 'about:blank', background: true});
        claim(result.targetId);
      } else if (op === 'attach') {
        const tab = await resolveTab(conn, params.tab);
        claim(tab.targetId);
        result = {targetId: tab.targetId};
      } else if (op === 'release') {
        release(target);
        result = {};
      } else if (op === 'close_tab') {
        owned(target);
        result = await conn.browser('Target.closeTarget', {targetId: target});
        release(target);
      } else if (op === 'send') {
        owned(target);
        result = await conn.send(target, method, params, timeout_ms);
      } else {
        throw new Error('Unknown operation');
      }
      process.stdout.write(JSON.stringify({id: request.id, result}) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({id: request?.id, error: String(error.message), replayed: false}) + '\n');
    }
  }
} finally {
  for (const target of held) release(target);
  conn.close();
}

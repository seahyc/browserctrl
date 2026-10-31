// `browserctrl <command> --browser firefox|camoufox`: the shared command set over WebDriver
// BiDi, run by the port's BiDi daemon (lib/bidi/daemon.mjs), which this starts on demand.
// Returns { data, text, exitCode? } for the CLI to print.

import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentId } from '../env.mjs';
import { openSession } from './client.mjs';
import { BIDI_COMMANDS, usageError } from './commands.mjs';
import * as ops from './ops.mjs';
import { bidiSocket } from './daemon.mjs';
import { BIDI_BROWSERS, bidiPort, planBidiLaunch, startBidiBrowser, recordBidiLaunch, stopBidiLaunch } from './launch.mjs';

export { BIDI_COMMANDS };

const DAEMON = fileURLToPath(new URL('./daemon.mjs', import.meta.url));
const IPC_TIMEOUT_MS = 180_000;

/** launch firefox|camoufox [--headless] [--port N] [--user-data-dir D] [--stop] [--foreground] */
export async function bidiLaunch(name, flags) {
  const key = String(name).toLowerCase();
  const port = bidiPort(key, { port: flags.port });
  const dir = flags['user-data-dir'] ? path.resolve(String(flags['user-data-dir'])) : null;
  const plan = planBidiLaunch({ key, port, userDataDir: dir, headless: Boolean(flags.headless) });
  if (flags.stop) {
    await daemonRequest(port, { op: 'stop' }, { start: false }).catch(() => null);
    return { data: await stopBidiLaunch(plan.userDataDir) };
  }
  const foreground = Boolean(flags.foreground);
  const r = await startBidiBrowser({ plan, foreground });
  const report = {
    launched: plan.label, protocol: 'webdriver-bidi', port, ready: r.ready, waited_ms: r.waitedMs, profile: plan.userDataDir,
    ...(flags.headless ? { headless: true } : {}),
    note: r.alreadyRunning ? `something already answers WebDriver BiDi on port ${port}; nothing was started` : `started a separate ${plan.label} on its own profile; use --browser ${key}${flags.port ? ` --port ${port}` : ''} with later commands`,
  };
  if (!r.alreadyRunning && !foreground) {
    recordBidiLaunch(plan.userDataDir, { pid: r.child?.pid, port, exe: plan.exe, started: new Date().toISOString() });
    report.stop = `browserctrl launch ${key} --stop${dir ? ` --user-data-dir ${dir}` : ''}${flags.port ? ` --port ${port}` : ''}`;
  }
  if (!foreground || r.alreadyRunning) return { data: report };
  console.log(JSON.stringify(report, null, 2));
  const stop = () => { try { r.child.kill('SIGTERM'); } catch {} };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const code = await new Promise(res => r.child.once('exit', (c, sig) => res(c ?? (sig ? 0 : 1))));
  process.exit(code);
}

function connect(socketPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => socket.destroy(Object.assign(new Error('BiDi daemon connection timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

/** One request to the port's daemon, starting it when start is true. */
export async function daemonRequest(port, payload, { start = true, key, timeoutMs = IPC_TIMEOUT_MS, socketPath = bidiSocket(port), env = process.env } = {}) {
  let socket;
  try { socket = await connect(socketPath, 1000); }
  catch (error) {
    if (!start || !['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
    const child = spawn(process.execPath, [DAEMON, String(port), String(key)], { detached: true, stdio: 'ignore', env });
    child.unref();
    const until = Date.now() + 10_000;
    let last = error;
    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, 50));
      try { socket = await connect(socketPath, 500); break; }
      catch (next) { last = next; if (!['ENOENT', 'ECONNREFUSED'].includes(next.code)) throw next; }
    }
    if (!socket) throw new Error(`BiDi daemon did not become available: ${last.message}`);
  }
  return new Promise((resolve, reject) => {
    let data = '';
    let settled = false;
    const done = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => done(Object.assign(new Error('BiDi request timed out; its outcome is unknown and it was not retried'), { code: 'ETIMEDOUT' })), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      data += chunk;
      const nl = data.indexOf('\n');
      if (nl < 0) return;
      let reply;
      try { reply = JSON.parse(data.slice(0, nl)); } catch (error) { return done(new Error(`Invalid BiDi daemon reply: ${error.message}`)); }
      if (reply.error) return done(Object.assign(new Error(reply.error.message), { code: reply.error.code, exitCode: reply.error.exitCode }));
      done(null, reply.result);
    });
    socket.once('error', error => done(error));
    socket.once('end', () => { if (!settled) done(new Error('BiDi daemon closed before replying')); });
    socket.write(JSON.stringify(payload) + '\n');
  });
}

export async function bidiCommand(cmd, positional, flags, { browser, request = daemonRequest }) {
  const key = String(browser).toLowerCase();
  if (cmd === 'launch') return bidiLaunch(positional[1] || key, flags);
  if (!BIDI_COMMANDS.has(cmd)) {
    throw usageError(`${BIDI_BROWSERS[key].label} (WebDriver BiDi) does not support "${cmd}". Supported: ${[...BIDI_COMMANDS].sort().join(', ')}. Recipes, do plans, recordings, claims, tab groups and raw CDP are Chromium-only.`);
  }
  const port = bidiPort(key, { port: flags.port });
  if (cmd === 'stop') {
    const r = await request(port, { op: 'stop' }, { start: false }).catch(() => null);
    return { data: r ?? { stopped: false, note: `no BiDi daemon serves port ${port}` } };
  }
  if (cmd === 'status' || cmd === 'doctor') {
    // Never starts a daemon: ask the running one, else look with a short session of our own.
    const viaDaemon = await request(port, { op: 'call', cmd: 'status', positional: [], flags: {}, owner: agentId(), key }, { start: false }).catch(() => null);
    if (viaDaemon) return { data: { ...viaDaemon.data, daemon: true } };
    const s = await openSession(port);
    try { return { data: { ...(await ops.status(s, port)), daemon: false } }; } finally { await s.close(); }
  }
  // Plain JSON for the daemon: flags may hold booleans and strings only.
  return request(port, { op: 'call', cmd, positional, flags, owner: agentId(), key }, { key });
}

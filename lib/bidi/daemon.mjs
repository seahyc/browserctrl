#!/usr/bin/env node
// One daemon per WebDriver BiDi port owns the browser's single BiDi session and runs every
// command on it, one at a time. Camoufox numbers browsing contexts per session, so tab ids
// stay valid only while this session lives. It exits after BROWSERCTRL_BIDI_IDLE_MS idle.
//
// Protocol: newline-delimited JSON over a local socket.
//   { op: 'call', cmd, positional, flags, owner, key }  → { result: { data?, text?, exitCode? } }
//   { op: 'stop' }                                       → { result: { stopped: true } }
// Errors come back as { error: { message, code, exitCode } }.

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { setting } from '../config.mjs';
import { runtimePath } from '../platform.mjs';
import { openSession } from './client.mjs';
import { runCommand } from './commands.mjs';

const MAX_REQUEST_BYTES = 1024 * 1024;

export function bidiSocket(port, { platform = process.platform, user = os.userInfo().username } = {}) {
  return platform === 'win32' ? `\\\\.\\pipe\\browserctrl-bidi-${port}-${user}` : runtimePath(`bidi-${port}.sock`);
}

export function startDaemon({ port, key, open = openSession, idleMs = Number(setting('BIDI_IDLE_MS') || 600000), socketPath = bidiSocket(port), exit = code => process.exit(code) }) {
  let session = null;
  let queue = Promise.resolve();
  let idleTimer = null;
  let stopping = false;

  const endSession = async () => {
    const s = session;
    session = null;
    if (s) await s.close().catch(() => {});
  };
  const shutdown = async code => {
    if (stopping) return;
    stopping = true;
    clearTimeout(idleTimer);
    await endSession();
    server.close();
    if (process.platform !== 'win32') { try { fs.unlinkSync(socketPath); } catch {} }
    exit(code);
  };
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => shutdown(0), idleMs);
    idleTimer.unref?.();
  };

  const sessionFor = async () => {
    if (session && !session.closed) return session;
    session = await open(port);
    return session;
  };

  const handle = async req => {
    if (req.op === 'stop') { setImmediate(() => shutdown(0)); return { stopped: true, port }; }
    if (req.op !== 'call') throw Object.assign(new Error(`Unknown request ${req.op}`), { exitCode: 2 });
    let s = await sessionFor();
    try {
      return await runCommand(s, { cmd: req.cmd, positional: req.positional || [], flags: req.flags || {}, port, key: req.key || key, owner: req.owner });
    } catch (error) {
      // The browser dropped the connection: start a new session for the next request.
      if (/closed the WebDriver BiDi connection/.test(error.message)) await endSession();
      throw error;
    }
  };

  const server = net.createServer(socket => {
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buf += chunk;
      if (buf.length > MAX_REQUEST_BYTES) { socket.destroy(); return; }
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let req;
      try { req = JSON.parse(buf.slice(0, nl)); } catch { socket.end(JSON.stringify({ error: { message: 'invalid request', exitCode: 2 } }) + '\n'); return; }
      buf = '';
      touch();
      queue = queue.then(async () => {
        let reply;
        try { reply = { result: await handle(req) }; }
        catch (error) { reply = { error: { message: error.message, code: error.code, exitCode: error.exitCode } }; }
        touch();
        if (!socket.destroyed) socket.end(JSON.stringify(reply) + '\n');
      });
    });
  });

  return new Promise((resolve, reject) => {
    const listen = () => server.listen(socketPath, () => {
      if (process.platform !== 'win32') { try { fs.chmodSync(socketPath, 0o600); } catch {} }
      touch();
      resolve({ server, shutdown, socketPath });
    });
    server.once('error', error => {
      if (error.code !== 'EADDRINUSE') return reject(error);
      // A socket file is there: another daemon (leave it), or a stale file (replace it).
      const probe = net.createConnection(socketPath);
      probe.once('connect', () => { probe.destroy(); reject(Object.assign(new Error('a BiDi daemon already serves this port'), { code: 'DAEMON_RUNNING' })); });
      probe.once('error', () => {
        try { fs.unlinkSync(socketPath); } catch {}
        server.once('error', reject);
        listen();
      });
    });
    listen();
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [port, key] = process.argv.slice(2);
  startDaemon({ port: Number(port), key }).catch(error => process.exit(error.code === 'DAEMON_RUNNING' ? 0 : 1));
}

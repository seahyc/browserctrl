// Protected capture (contract v3): the driver half. It hands one validated request to the
// trusted daemon and writes the daemon's answer, including the captured value, only to its
// own stdout, which the trusted vault writer reads over a private pipe. No value is logged,
// put in an argument, a file or an error.
import net from 'node:net';
import { BROWSERS, SOCK } from './env.mjs';
import { validateVaultCapture, captureShapeOk, daemonTrusted, testPort } from './vault-fill.mjs';

const fail = code => ({ status: 'failed', verification: 'not_verified', code });
const object = v => v && typeof v === 'object' && !Array.isArray(v);

// `port` and `trusted` are for tests; the installed driver derives the port from the browser.
export async function submitVaultCapture(request, { trusted = daemonTrusted, port } = {}) {
  try { validateVaultCapture(request); } catch { return fail('invalid_request'); }
  port ??= testPort() ?? BROWSERS[request.destination.browser].port;
  const sock = SOCK(port);
  // No ensureDaemon(): a missing or old daemon is never started or replaced from here.
  return new Promise(resolve => {
    const socket = net.connect(sock);
    let buf = '', finished = false;
    const done = result => { if (finished) return; finished = true; buf = ''; socket.destroy(); resolve(result); };
    socket.setTimeout(Math.max(5000, Math.min(45000, (request.deadline - Date.now() / 1000) * 1000 + 5000)), () => done(fail('adapter_timeout')));
    socket.on('connect', async () => {
      let ok = false;
      try { ok = await trusted(sock, port); } catch {}
      if (finished) return;
      if (!ok) return done(fail('daemon_untrusted'));
      // The daemon checks the claim against this owner, which the approved plan fixes.
      socket.write(JSON.stringify({ reqId: 1, op: 'vault-capture', owner: request.destination.tab_owner, label: 'vault-capture', request }) + '\n');
    });
    socket.on('data', chunk => {
      buf += chunk;
      if (buf.length > 65536) return done(fail('adapter_response_invalid'));
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        const row = JSON.parse(buf.slice(0, nl)), v = row.result;
        // An error reply comes only before a capture starts (an old, busy or blocked daemon).
        if (row.error !== undefined && v === undefined) return done(fail('daemon_refused'));
        if (!object(v)) return done(fail('adapter_unavailable'));
        const keys = Object.keys(v).sort().join();
        if (v.status === 'completed') {
          if (keys !== 'status,value,verification' || v.verification !== 'captured' || !captureShapeOk(v.value, request.shape)) return done(fail('adapter_unavailable'));
          return done({ status: 'completed', verification: 'captured', value: v.value });
        }
        if (keys !== 'code,status,verification' || v.status !== 'failed' || v.verification !== 'not_verified' || typeof v.code !== 'string' || !/^[a-z_]{1,64}$/.test(v.code)) return done(fail('adapter_unavailable'));
        done(fail(v.code));
      } catch { done(fail('adapter_response_invalid')); }
    });
    socket.on('error', () => done(fail('adapter_unavailable')));
    socket.on('end', () => done(fail('adapter_disconnected')));
  });
}

// Read-only diagnostics for an explicitly selected browser endpoint.
//
// A missing or stale daemon is a warning rather than a fatal condition: the
// next ordinary SDK/CLI operation starts or replaces it automatically. This
// module deliberately does not call connect(), which would start a daemon.
import net from 'node:net';
import { observeConnections } from './connection-observer.mjs';
import { telemetryDirectory } from './telemetry.mjs';
import { flag } from './config.mjs';

import { codeVersion } from './daemon.mjs';
import { browserWsUrl, resolveBrowserArg } from './discovery.mjs';
import { PORT_TO_KEY, SOCK } from './env.mjs';

const DAEMON_TIMEOUT_MS = 32000;

function probeDaemon(port, timeoutMs = DAEMON_TIMEOUT_MS) {
  return new Promise(resolve => {
    const socket = net.connect(SOCK(port));
    const reqId = `diagnose-${process.pid}-${Date.now()}`;
    let buffer = '';
    let settled = false;

    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({ present: true, health: null, reason: 'health probe timed out' }),
      timeoutMs,
    );

    socket.on('connect', () => {
      socket.write(JSON.stringify({ reqId, op: 'health', timeoutMs: 31000 }) + '\n');
    });
    socket.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      try {
        const reply = JSON.parse(buffer.slice(0, newline));
        if (reply.reqId !== reqId) {
          finish({ present: true, health: null, reason: 'daemon returned an unexpected response' });
          return;
        }
        finish({ present: true, health: reply.result ?? null, reason: null });
      } catch {
        finish({ present: true, health: null, reason: 'daemon returned malformed health data' });
      }
    });
    socket.on('error', error => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
        finish({ present: false, health: null, reason: 'daemon is not running' });
      } else {
        finish({ present: false, health: null, reason: 'daemon socket is unavailable' });
      }
    });
  });
}

/**
 * Return a versioned, read-only health report for one explicit browser.
 *
 * `ok` means the selector is valid and the browser debugging endpoint is
 * reachable. Daemon absence or version drift is reported as a warning because
 * a normal SDK/CLI call repairs that state automatically.
 */
export async function diagnose({ browser, port } = {}) {
  const report = {
    schemaVersion: 1,
    ok: false,
    browser: null,
    port: null,
    checks: [],
    warnings: [],
  };

  if (browser == null && port == null) {
    report.checks.push({
      name: 'selector',
      ok: false,
      detail: 'Specify exactly which endpoint to inspect with browser or port.',
    });
    return report;
  }

  let selectedPort;
  try {
    const parsedPort = port == null ? undefined : Number(port);
    if (port != null && (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535)) {
      throw new TypeError('Port must be an integer between 1 and 65535.');
    }
    selectedPort = resolveBrowserArg({ browser, port: parsedPort });
  } catch (error) {
    report.checks.push({ name: 'selector', ok: false, detail: error.message });
    return report;
  }

  if (!Number.isInteger(selectedPort) || selectedPort < 1 || selectedPort > 65535) {
    report.checks.push({
      name: 'selector',
      ok: false,
      detail: 'Port must be an integer between 1 and 65535.',
    });
    return report;
  }

  report.port = selectedPort;
  report.browser = PORT_TO_KEY[selectedPort] ?? (browser ? String(browser).toLowerCase() : null);
  report.checks.push({
    name: 'selector',
    ok: true,
    detail: `Inspecting the explicitly selected loopback endpoint on port ${selectedPort}.`,
  });

  const finish = async (daemonPid = null) => {
    report.connections = await observeConnections(selectedPort, { daemonPid, ignorePids: [process.pid] });
    report.telemetry = { directory: telemetryDirectory(), enabled: flag('TELEMETRY', true) };
    report.daemonPid = daemonPid;
    if (daemonPid === null && report.connections.connections.length) report.warnings.push('TCP clients were observed, but daemon identity is unavailable; client classification is unknown.');
    if (report.connections.connections.some(client => client.sharedDaemon === false)) report.warnings.push('Other TCP clients reach the debugging port outside the daemon. They may be HTTP discovery or direct debugging clients; new debugging connections can trigger approval.');
    return report;
  };

  try {
    await browserWsUrl(selectedPort);
    report.checks.push({
      name: 'browserEndpoint',
      ok: true,
      detail: 'The browser debugging endpoint is reachable.',
    });
    report.ok = true;
  } catch (error) {
    report.checks.push({ name: 'browserEndpoint', ok: false, detail: error.message });
    return finish();
  }

  const daemon = await probeDaemon(selectedPort);
  if (!daemon.present) {
    report.checks.push({
      name: 'daemon',
      ok: false,
      detail: 'No existing daemon answered; the browser remains reachable.',
    });
    report.warnings.push('The next SDK or CLI operation will start the daemon automatically.');
    return finish();
  }

  if (!daemon.health?.ok) {
    report.checks.push({
      name: 'daemon',
      ok: false,
      detail: daemon.reason ?? 'The existing daemon is not healthy or attached to the browser.',
    });
    report.warnings.push(daemon.health?.busy
      ? 'The browser is responding to other requests; its connection is retained despite a slow health probe.'
      : 'The next SDK or CLI operation will recover or replace the unavailable daemon.');
    return finish(daemon.health?.pid ?? null);
  }

  report.checks.push({
    name: 'daemon',
    ok: true,
    detail: 'The existing daemon is attached to a live browser.',
  });
  const currentCode = codeVersion();
  const versionMatches = daemon.health.code === currentCode;
  report.checks.push({
    name: 'daemonVersion',
    ok: versionMatches,
    detail: versionMatches
      ? `Daemon code version ${currentCode} matches this client.`
      : `Daemon code version ${daemon.health.code ?? 'unknown'} is stale; this client expects ${currentCode}.`,
  });
  if (!versionMatches) {
    report.warnings.push('The next SDK or CLI operation will replace the stale daemon automatically.');
  }

  return finish(daemon.health.pid ?? null);
}

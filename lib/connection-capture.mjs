import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { observeConnections } from './connection-observer.mjs';

// Explicit, bounded incident capture. No browser connections or background job.
export async function captureConnections(port, { seconds = 20, daemonPid = null, directory = process.env.CDP_TELEMETRY_DIR || path.join(os.homedir(), '.local/share/chrome-cdp/telemetry'), observe = observeConnections } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('A valid port is required.');
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new Error('watch-seconds must be greater than 0 and at most 60.');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `capture-${port}-${Date.now()}-${randomUUID()}.jsonl`);
  const fd = fs.openSync(file, 'wx', 0o600);
  const started = Date.now(), clients = new Set(), unknown = new Set();
  let snapshots = 0, bytes = 0, truncated = false;
  try {
    do {
      const observation = await observe(port, { daemonPid, ignorePids: [process.pid] });
      const line = JSON.stringify({ time: new Date().toISOString(), port, ...observation }) + '\n';
      const size = Buffer.byteLength(line);
      if (bytes + size > 1024 * 1024) { truncated = true; break; }
      fs.writeSync(fd, line); bytes += size; snapshots++;
      for (const client of observation.connections) {
        if (client.sharedDaemon === false) clients.add(client.pid);
        else if (client.sharedDaemon == null) unknown.add(client.pid);
      }
      const remaining = seconds * 1000 - (Date.now() - started);
      if (remaining <= 0) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(500, remaining)));
    } while (Date.now() - started < seconds * 1000);
  } finally { fs.closeSync(fd); }
  const captures = fs.readdirSync(directory).filter(name => /^capture-\d+-\d+-[a-f0-9-]+\.jsonl$/.test(name)).sort((a,b) => fs.statSync(path.join(directory,b)).mtimeMs - fs.statSync(path.join(directory,a)).mtimeMs);
  for (const name of captures.slice(20)) { try { fs.unlinkSync(path.join(directory,name)); } catch {} }
  return { file, snapshots, durationMs: Date.now() - started, unpooledClientPids: [...clients], unclassifiedClientPids: [...unknown], truncated };
}

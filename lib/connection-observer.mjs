// Inspect existing sockets without opening a browser connection or reading args.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const limits = { timeout: 2000, maxBuffer: 1024 * 1024, encoding: 'utf8' };

function clientPids(output, port) {
  const pids = new Set();
  let pid;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (!line.startsWith('n') || !Number.isSafeInteger(pid) || pid <= 0) continue;
    const remote = line.slice(1).split('->');
    if (remote.length === 2 && remote[1].endsWith(`:${port}`)) pids.add(pid);
  }
  return [...pids];
}

/** Passive, bounded snapshot. `run` supports deterministic OS-failure tests. */
export async function observeConnections(port, { daemonPid = null, ignorePids = [], run = exec, platform = process.platform } = {}) {
  if (!['darwin', 'linux'].includes(platform)) {
    return { available: false, connections: [], warnings: ['Connection observation is unsupported on this platform.'] };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { available: false, connections: [], warnings: ['Connection observation requires a valid TCP port.'] };
  }
  try {
    let output;
    try {
      ({ stdout: output } = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-Fpcn'], limits));
    } catch (error) {
      if (error.code === 1 && !error.stdout?.trim() && !error.stderr?.trim()) output = '';
      else throw error;
    }
    const pids = clientPids(output, port).filter(pid => !ignorePids.includes(pid));
    const warnings = pids.length > 32 ? ['Connection observation is limited to 32 client processes.'] : [];
    const cache = new Map();
    const processInfo = pid => {
      if (!cache.has(pid)) cache.set(pid, (async () => {
        let stdout;
        try {
          ({ stdout } = await run('ps', ['-p', String(pid), '-o', 'pid=,ppid=,comm='], limits));
        } catch (error) {
          if (error.code === 1 && !error.stdout?.trim() && !error.stderr?.trim()) return null;
          throw error;
        }
        if (!stdout.trim()) return null;
        const match = stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (!match || Number(match[1]) !== pid) throw new Error('Invalid process snapshot');
        return { pid, ppid: Number(match[2]), executable: match[3].trim() };
      })());
      return cache.get(pid);
    };
    const connections = await Promise.all(pids.slice(0, 32).map(async pid => {
      const own = await processInfo(pid);
      if (!own) return { pid, ppid: null, executable: null, ancestors: [], sharedDaemon: daemonPid === null ? null : pid === daemonPid, processExited: true };
      const ancestors = [], seen = new Set([pid]);
      let parent = own.ppid;
      for (let depth = 0; depth < 4 && parent > 0 && !seen.has(parent); depth++) {
        seen.add(parent);
        const ancestor = await processInfo(parent);
        if (!ancestor) break;
        ancestors.push(ancestor);
        parent = ancestor.ppid;
      }
      return { ...own, ancestors, sharedDaemon: daemonPid === null ? null : pid === daemonPid };
    }));
    return { available: true, connections, warnings };
  } catch {
    return { available: false, connections: [], warnings: ['Connection observation is unavailable because an OS process inspection failed.'] };
  }
}

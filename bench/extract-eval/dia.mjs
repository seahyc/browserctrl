import { execFile } from 'node:child_process';

// Only IDs returned by this adapter's open command may be used or closed.
export function createDiaAdapter({ execute = execFile, env = process.env } = {}) {
  const owned = new Set();
  const opening = new Set();
  const closing = new Map();
  let stopped = false;
  function command(args, { stoppedReport = false, raw = false } = {}) {
    return new Promise((resolve, reject) => {
      execute('browserctrl', args, {
        env: { ...env, BROWSERCTRL_BROWSER: 'dia', BROWSERCTRL_AGENT_ID: 'extract-eval' },
        encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000,
      }, (error, stdout, stderr) => {
        if (error && !(stoppedReport && error.code === 3)) return reject(new Error(stderr?.trim() || error.message));
        try { resolve(JSON.parse(stdout)); }
        catch { if (raw && !error) resolve(stdout.trimEnd()); else reject(new Error('browserctrl returned invalid JSON')); }
      });
    });
  }
  function assertOwned(tab) {
    if (!owned.has(tab) || stopped) throw new Error('Dia tab is not owned by this evaluation');
  }
  async function closeTab(_conn, tab) {
    if (closing.has(tab)) return closing.get(tab);
    if (!owned.has(tab)) return;
    const pending = command(['close', tab]).then(() => { owned.delete(tab); }).finally(() => closing.delete(tab));
    closing.set(tab, pending);
    return pending;
  }
  async function newTab(_conn, url) {
    if (stopped) throw new Error('Evaluation interrupted');
    const pending = command(['open', url, '--until', 'none']).then(result => {
      if (!result?.targetId || typeof result.targetId !== 'string') throw new Error('browserctrl open returned no targetId');
      owned.add(result.targetId);
      return result;
    });
    opening.add(pending);
    try {
      const result = await pending;
      if (stopped) { await closeTab(null, result.targetId); throw new Error('Evaluation interrupted'); }
      return result;
    } finally { opening.delete(pending); }
  }
  return {
    newTab, closeTab,
    async waitForReady(_conn, tab) { assertOwned(tab); return command(['ready', tab, '--until', 'load', '--timeout', '25000']); },
    async evaluate(_conn, tab, js) { assertOwned(tab); return command(['eval', tab, js], { raw: true }); },
    async runSteps(_conn, tab, lines) {
      assertOwned(tab);
      return command(['do', tab, ...lines, '--json', '--no-handoff', '--no-notes', '--no-diff', '--no-prefetch'], { stoppedReport: true });
    },
    async cleanup() {
      stopped = true;
      await Promise.allSettled([...opening]);
      const results = await Promise.allSettled([...owned].map(tab => closeTab(null, tab)));
      const failure = results.find(r => r.status === 'rejected');
      if (failure) throw failure.reason;
    },
  };
}

export function installCleanupSignals(cleanup, { source = process, exit = code => process.exit(code), onSignal = () => {}, onError = error => console.error(error.message) } = {}) {
  for (const signal of ['SIGINT', 'SIGTERM']) source.once(signal, async () => {
    onSignal();
    try { await cleanup(); }
    catch (error) { onError(error); }
    finally { exit(signal === 'SIGINT' ? 130 : 143); }
  });
}

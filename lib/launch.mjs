// Relaunch a browser with its debug port, and only report success once the
// port answers. macOS `open -a` on an app that is still quitting just focuses
// the dying instance and drops --args, so the old launcher could print
// "launched" while the browser never came back.

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function relaunchWithDebugPort({
  quit,             // () => Promise: ask the app to quit
  isRunning,        // () => Promise<boolean>
  open,             // () => Promise: open the app with the debug-port args
  probe,            // () => Promise<object|null>: /json/version, null if not up
  quitTimeoutMs = 30000,
  readyTimeoutMs = 45000,
  reopenAfterMs = 10000,
  pollMs = 500,
  now = Date.now,
  wait = sleep,
}) {
  await quit().catch(() => {});
  const quitDeadline = now() + quitTimeoutMs;
  while (await isRunning()) {
    if (now() >= quitDeadline) {
      throw new Error(`browser did not quit within ${quitTimeoutMs / 1000}s; not relaunching (close it manually, then retry)`);
    }
    await wait(pollMs);
  }

  const started = now();
  await open();
  let reopened = false;
  while (now() - started < readyTimeoutMs) {
    const version = await probe().catch(() => null);
    if (version) return { ready: true, version, waitedMs: now() - started, reopened };
    if (!reopened && now() - started >= reopenAfterMs && !(await isRunning())) {
      // The first open raced the old instance's shutdown and was swallowed.
      reopened = true;
      await open();
    }
    await wait(pollMs);
  }
  const running = await isRunning();
  throw new Error(running
    ? `browser is running but its debug port did not answer within ${readyTimeoutMs / 1000}s`
    : `browser did not start within ${readyTimeoutMs / 1000}s${reopened ? ' (reopened once)' : ''}`);
}

// Decide how to launch: relaunch the user's real profile with a debug port, or
// start a separate instance on its own profile (--user-data-dir), which leaves
// the user's normal browser untouched. Throws before anything is quit when the
// real profile cannot be debugged this way (Chrome 136+).
export function planLaunch({ name, meta, userDataDir, extension }) {
  const args = [`--remote-debugging-port=${meta.port}`];
  if (extension) args.push(`--load-extension=${extension}`);
  if (userDataDir) {
    args.push(`--user-data-dir=${userDataDir}`);
    return { separateInstance: true, args, processMatch: `--user-data-dir=${userDataDir}` };
  }
  if (meta.realProfileDebugBlocked) {
    throw new Error(`${meta.label} refuses --remote-debugging-port on your real profile, so nothing was quit. ` +
      `Either ${meta.enable.replace(/, or relaunch with .*$/, '')}, or run: browserctrl launch ${name} --user-data-dir <dir> ` +
      `(a separate ${meta.label} instance on its own profile; your normal ${meta.label} stays open).`);
  }
  return { separateInstance: false, args, processMatch: null };
}

// Machine load, for tests: imported by test/helpers.mjs, and by every node process a test
// starts (the CLI, daemons) through NODE_OPTIONS, so browserctrl's own waits stretch the same
// way in all of them. It has no other side effects, so it is safe in any child.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Machine load. On a loaded machine every process gets about cpus/load of a core, so the
// page, Chrome and this process all run that much slower in wall-clock time. loadFactor() is
// that slowdown: the 1-minute load average per CPU, at least 1 and at most LOAD_FACTOR_MAX,
// read again at most once a second. BROWSERCTRL_TEST_LOAD_FACTOR fixes it (1 turns scaling off).
// A bound a test asserts on a duration uses scaled(ms), so at low load it is exactly the bound
// written, and a regression that makes something 10x slower still fails.
const LOAD_FACTOR_MAX = 8;
let loadSample = { at: 0, factor: 1 };
export function loadFactor() {
  const fixed = Number(process.env.BROWSERCTRL_TEST_LOAD_FACTOR);
  if (fixed > 0) return fixed;
  if (Date.now() - loadSample.at > 1000) {
    const perCpu = os.loadavg()[0] / Math.max(1, os.cpus().length);
    loadSample = { at: Date.now(), factor: Math.round(Math.min(LOAD_FACTOR_MAX, Math.max(1, perCpu)) * 10) / 10 };
  }
  return loadSample.factor;
}
export const scaled = (ms) => Math.round(ms * loadFactor());
// For assertion messages and the note each test file prints.
export const describeLoad = () => `load factor ${loadFactor()} (1-min load ${os.loadavg()[0].toFixed(1)} on ${os.cpus().length} CPUs)`;

// The waits browserctrl itself makes (lib/timing.mjs) are wall-clock budgets for a page to
// answer, settle or draw. Wherever this file is loaded they stretch with the load, so a loaded
// machine sees the page behaviour an idle one does. Caps (how long to wait at most for an
// answer, a load, a screenshot) stretch by loadFactor(): they cost time only when something is
// slow. Windows and pauses (how long the DOM must stay quiet, a pause before reading again) are
// paid on every step, so they stretch by its square root. Poll intervals, counts, ratios, ages,
// the plan's own `wait` lengths and the handoff default stay as written. A file that compares
// a product message or a page timer with these values sets BROWSERCTRL_TEST_LOAD_FACTOR to
// loadFactor() once, so they hold still for the whole file (test/do-late-input.test.mjs);
// BROWSERCTRL_TEST_LOAD_FACTOR=1 turns all of it off.
const T = await import('../lib/timing.mjs');
// Once per process, however many ways this file is imported.
if (!Object.getOwnPropertyDescriptor(T.VISION, 'CAPTURE_MS').get) {
  const MOST = 120000;
  const stretch = (factor, obj, keys) => {
    for (const k of keys) {
      const base = obj[k];
      if (typeof base !== 'number') throw new Error(`test/load.mjs: timing ${k} is not a number`);
      // Never past 120 s, the most browserctrl accepts for a reload or a readiness wait.
      Object.defineProperty(obj, k, { get: () => Math.round(Math.min(Math.max(base, MOST), base * factor())), enumerable: true, configurable: true });
    }
  };
  const cap = (obj, keys) => stretch(loadFactor, obj, keys);
  const pause = (obj, keys) => stretch(() => Math.sqrt(loadFactor()), obj, keys);
  for (const preset of Object.values(T.SETTLE)) {
    cap(preset, ['timeoutMs', 'maxMs'].filter(k => k in preset));
    pause(preset, ['stableMs', 'busyStableMs', 'quietMs'].filter(k => k in preset));
  }
  cap(T.QUIET, ['NAV_MAX', 'PROBE', 'BUSY_MAX']);
  pause(T.QUIET, ['NEVER_COMPLETE_QUIET', 'AGE_MIN', 'BEFORE_STEP', 'LONG_POLL']);
  cap(T.LOADING, ['PROBE']);
  pause(T.LOADING, ['REQUEST_OPEN', 'REQUEST_DONE']);
  cap(T.CONTENT, ['WAIT', 'PLAN_WAIT']);
  cap(T.INPUT, ['ACK', 'SLOW_ACK', 'LATE_WAIT', 'CHOOSER_WAIT']);
  pause(T.INPUT, ['COVER_RECHECK', 'AFTER_SCROLL']);
  cap(T.NAV, ['TIMEOUT', 'ANSWER', 'ANSWER_PROBE', 'RECOVER']);
  pause(T.NAV, ['IDLE']);
  cap(T.RECOVERY, ['TIMEOUT', 'CALL', 'DIAGNOSE_PROBE', 'TARGET_CALL', 'NAVIGATE_MAX']);
  pause(T.RECOVERY, ['CRASH_SETTLE', 'STILL_ANSWERS']);
  cap(T.WAIT_FOR, ['TIMEOUT']);
  cap(T.STEP, ['PROBE']);
  pause(T.STEP, ['RETRY', 'RETRY_REPEAT', 'LIST_OPEN']);
  cap(T.VISION, ['CAPTURE_MS', 'REQUEST_MS']);
  cap(T.OUTCOME, ['TOGGLE', 'OPTION']);
  pause(T.OUTCOME, ['DISCLOSURE', 'DATE']);
  cap(T.DATE, ['DRAW']);
  pause(T.DATE, ['OPENED']);
  cap(T.SLIDER, ['KEYS_MAX']);
  pause(T.SLIDER, ['KEY_LATE', 'NUDGE']);
  cap(T.VISIT, ['TIMEOUT']);
  cap(T.PLAN, ['DEADLINE']);
  cap(T.EXTRACTION, ['WAIT_MS']);
}

// For node processes the tests start.
export const LOAD_IMPORT = `--import=${path.join(path.dirname(fileURLToPath(import.meta.url)), 'load.mjs')}`;

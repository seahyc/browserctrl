// Waiting on the page between steps: for it to show a step's result, for a single-page app
// to fill in, and for a person to clear a challenge.
import * as ops from '../ops.mjs';
import * as captcha from '../captcha.mjs';
import { page } from '../page/index.mjs';
import { SETTLE, CONTENT, STEP, sleep } from '../timing.mjs';

// Wait for the page to show the result of a step: ops.settle's quiet mode, with a preset
// from lib/timing.mjs (SETTLE.step unless given). Returns the ms waited; settle.why says what
// ended the wait (quiet, or "cap: <what was still going>").
export async function settle(conn, tab, opts = {}) {
  const r = await ops.settle(conn, tab, typeof opts === 'string' ? SETTLE[opts] : { ...SETTLE.step, ...opts });
  settle.why = r.why;
  return r.waitedMs;
}

// A single-page app can sit quiet on its empty shell, then fill in section by section:
// wait until the page has text and its length holds for two reads (bounded).
// stable: false accepts the first read with enough text (a page that is already open).
export async function waitForContent(conn, tab, { timeoutMs = CONTENT.WAIT, minChars = CONTENT.MIN_CHARS, stable = true } = {}) {
  let prev = -1;
  for (const t1 = Date.now(); Date.now() - t1 < timeoutMs;) {
    const s = await ops.evaluate(conn, tab, page('content-length')).catch(() => ({ n: 0, done: false }));
    const n = s?.n ?? 0;
    if (n >= minChars && (n === prev || !stable)) return n;
    // A page that is short by design (a small form, a sign-in step) and has finished loading:
    // the same short text twice is the page, not a loading shell.
    if (s?.done && n > 0 && n === prev) return n;
    prev = n;
    await sleep(CONTENT.POLL);
    await settle(conn, tab, 'content');
  }
  return prev;
}

// A challenge that appears mid-plan goes to the human (bounded wait) instead of
// failing the plan; with handoff: false the plan stops there. Returns null to
// carry on, or the reason to stop.
export async function meetChallenge(conn, tab, row, { handoff, handoffMs }) {
  const found = await captcha.detect(conn, tab).catch(() => null);
  if (!found) return null;
  const href = await ops.evaluate(conn, tab, 'location.href', { timeoutMs: STEP.PROBE }).catch(() => null);
  if (href) ops.noteSiteTrouble(href, 'challenge');
  try {
    row.challenge = await captcha.solve(conn, tab, { timeoutMs: handoffMs, handoff });
    return null;
  } catch (e) {
    row.challenge = { captcha: found.kind, cleared: false };
    const trouble = href ? ops.siteTrouble(href) : null;
    return trouble ? `${e.message}. ${trouble}` : e.message;
  }
}

// Every browser operation, one function each. Frontends (CLI, MCP) are thin
// wrappers over this file and must not contain protocol logic.
import fs from 'fs';
import {waitForBackgroundReady} from './readiness.mjs';
import os from 'node:os';
import path from 'node:path';
import { disposeDiaContext } from './dia-context.mjs';
import { PORT_TO_KEY } from './env.mjs';
import { snapshotExpression, resolveRefExpression, refLookupExpression, REF_ERRORS, LOADING_EXPR } from './refs.mjs';
import * as claims from './claims.mjs';
import * as state from './state.mjs';
import * as anonymousContexts from './anonymous.mjs';

const KEYS = {
  Enter: { code: 13, key: 'Enter', text: '\r' },
  Tab: { code: 9, key: 'Tab' },
  Escape: { code: 27, key: 'Escape' },
  Backspace: { code: 8, key: 'Backspace' },
  Delete: { code: 46, key: 'Delete' },
  ArrowUp: { code: 38, key: 'ArrowUp' },
  ArrowDown: { code: 40, key: 'ArrowDown' },
  ArrowLeft: { code: 37, key: 'ArrowLeft' },
  ArrowRight: { code: 39, key: 'ArrowRight' },
  Home: { code: 36, key: 'Home' },
  End: { code: 35, key: 'End' },
  PageUp: { code: 33, key: 'PageUp' },
  PageDown: { code: 34, key: 'PageDown' },
  Space: { code: 32, key: ' ', text: ' ' },
};
const MODIFIERS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

// ------------------------------------------------------------------ tabs ----

export async function tabs(conn, { focus = false } = {}) {
  const { targetInfos } = await conn.browser('Target.getTargets');
  const held = claims.list(conn.port);
  const marked = state.marks(conn.port);
  const anonymous = anonymousContexts.list(conn.port);
  // Observation must not dispose contexts. Dia can replace a closed private
  // tab asynchronously; disposal here races that native lifecycle, including
  // when resolveTab() is merely locating an unrelated ordinary tab.
  const rows = targetInfos
    .filter(t => t.type === 'page' && !t.url.startsWith('devtools://'))
    .map(t => {
      const claim = held.find(c => c.targetId === t.targetId);
      const m = marked.find(x => x.targetId === t.targetId);
      return {
        id: t.targetId.slice(0, 8),
        targetId: t.targetId,
        browserContextId: t.browserContextId,
        title: t.title,
        url: t.url,
        attached: t.attached,
        alias: state.getAlias(conn.port, t.targetId),
        marked: m ? { note: m.note, ageMs: m.ageMs } : null,
        claimedBy: claim ? `${claim.label} (${Math.round(claim.ageMs / 60000)}m ago)` : null,
        anonymous: anonymous.some(row => row.targetId === t.targetId),
      };
    });
  if (!focus) return rows;
  // A tab kept rendering by wake reports itself visible and focused whether or
  // not the human is looking at it, so it never counts as the focused tab.
  const rendering = new Set((await conn.status?.().catch(() => null))?.rendering || []);

  // Exactly one tab reports hasFocus with a visible document: that is the one
  // the human is actually looking at. A tab that will not answer at all has
  // been discarded by the memory saver, which is worth saying out loud rather
  // than silently omitting.
  await Promise.all(
    rows.map(async row => {
      try {
        const r = await evaluate(
          conn,
          row.targetId,
          'JSON.stringify({f:document.hasFocus(),v:document.visibilityState})',
          // Probe only: do not pay for enabling four domains on every tab.
          { timeoutMs: 1500, light: true },
        );
        const parsed = JSON.parse(r);
        row.focused = parsed.f && parsed.v === 'visible' && !rendering.has(row.targetId);
        if (rendering.has(row.targetId)) row.rendering = true;
      } catch {
        row.suspended = true;
        row.focused = false;
      }
    }),
  );
  return rows;
}

export async function focusedTab(conn) {
  const all = await tabs(conn, { focus: true });
  return all.find(t => t.focused) ?? null;
}

export async function resolveTab(conn, idOrPrefix) {
  // Two names both sides understand, resolved before anything else:
  //   active  -> the tab the human is looking at right now
  //   marked  -> the tab (or tabs) the human handed over
  if (['active', 'focused', '@focus', '@me'].includes(String(idOrPrefix))) {
    const focused = await focusedTab(conn);
    if (!focused) {
      throw new Error(
        'No focused tab: this browser window is not frontmost, so no tab reports focus. ' +
          'Bring it forward, or name a tab from: cdp tabs',
      );
    }
    return focused;
  }
  if (idOrPrefix === 'marked') {
    const marked = state.marks(conn.port);
    if (!marked.length) throw new Error('No tabs are marked. Mark one with: cdp mark <url-substring>');
    if (marked.length > 1) {
      const all = await tabs(conn);
      const lines = marked.map(m => {
        const t = all.find(x => x.targetId === m.targetId);
        return `  ${m.targetId.slice(0, 8)}  ${t?.title || m.title || '(closed)'}${m.note ? `  note: ${m.note}` : ''}`;
      });
      throw new Error(`${marked.length} tabs are marked. Pick one:\n${lines.join('\n')}`);
    }
    return resolveTab(conn, marked[0].targetId);
  }

  const all = await tabs(conn);
  if (!idOrPrefix) {
    throw new Error(`No tab given. Pick one:\n${all.map(t => `  ${t.id}  ${t.title || t.url}`).join('\n')}`);
  }
  const byAlias = all.find(t => t.alias && t.alias.toLowerCase() === String(idOrPrefix).toLowerCase());
  if (byAlias) return byAlias;
  const matches = all.filter(t => t.targetId === idOrPrefix || t.targetId.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Ambiguous tab prefix "${idOrPrefix}" (${matches.length} tabs match).`);
  // Fall back to matching on url or title, which is what an agent usually has.
  const needle = String(idOrPrefix).toLowerCase();
  const soft = all.filter(t => (t.url || '').toLowerCase().includes(needle) || (t.title || '').toLowerCase().includes(needle));
  if (soft.length === 1) return soft[0];
  if (soft.length > 1) throw new Error(`"${idOrPrefix}" matches ${soft.length} tabs. Use a tab id from: cdp tabs`);
  throw new Error(`No tab matches "${idOrPrefix}".\n${all.map(t => `  ${t.id}  ${t.title || t.url}`).join('\n')}`);
}

export async function newTab(conn, url, { anonymous = false, browserContextId: profileContext } = {}) {
  const targetUrl = url || 'about:blank';
  if (!anonymous) {
    const { targetId } = await conn.browser('Target.createTarget', { url: targetUrl, background: true, ...(profileContext ? { browserContextId: profileContext } : {}) });
    claims.claim(conn.port, targetId, { steal: true });
    return { targetId, id: targetId.slice(0, 8), url: targetUrl };
  }

  // This registry owns cleanup for temporary contexts, so keep disposal explicit.
  // This avoids overlapping cleanup ownership, but is not a confirmed fix for
  // Dia 1.49.1 crashes: the same native trap also occurred in a normal tab.
  const { browserContextId } = await conn.browser('Target.createBrowserContext', { disposeOnDetach: false });
  try {
    const { targetId } = await conn.browser('Target.createTarget', { url: targetUrl, browserContextId, background: true });
    anonymousContexts.record(conn.port, targetId, browserContextId);
    claims.claim(conn.port, targetId, { steal: true });
    return { targetId, id: targetId.slice(0, 8), url: targetUrl, anonymous: true, browserContextId };
  } catch (error) {
    await conn.browser('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    throw error;
  }
}

export async function closeTab(conn, targetId) {
  const anonymous = anonymousContexts.get(conn.port, targetId);
  if (anonymous) {
    if (PORT_TO_KEY[conn.port] === 'dia' && process.platform === 'darwin') {
      await disposeDiaContext(conn, anonymous.browserContextId);
    } else {
      await conn.browser('Target.closeTarget', { targetId }).catch(() => {});
      await conn.browser('Target.disposeBrowserContext', { browserContextId: anonymous.browserContextId });
    }
    // Retain ownership metadata after failed cleanup so it can be retried.
    anonymousContexts.release(conn.port, targetId);
    claims.release(conn.port, targetId);
    return { closed: targetId.slice(0, 8), anonymous: true };
  }
  await conn.browser('Target.closeTarget', { targetId });
  claims.release(conn.port, targetId);
  return { closed: targetId.slice(0, 8) };
}

export async function focus(conn, targetId) {
  await conn.browser('Target.activateTarget', { targetId });
  return { activated: targetId.slice(0, 8) };
}

// Keep a background tab rendering without selecting it or taking OS focus.
// The page sees itself visible and focused (focus emulation), so
// requestAnimationFrame, IntersectionObserver and lazy lists run. It lasts
// while the daemon's session does (a daemon restart ends it). `enabled: false`
// lets the tab go hidden again.
export async function wake(conn, targetId, { enabled = true } = {}) {
  return conn.render(targetId, { enabled });
}

// ------------------------------------------------------------- evaluation ---

// Why a tab stopped answering, and what to run next. Called after a command timed out.
//   { kind: 'dialog', dialog }  a JavaScript alert/confirm/prompt is waiting for an answer
//   { kind: 'crashed' }         the renderer crashed (a sad-tab page)
//   { kind: 'recovered', ms }   it answers again (it was busy or frozen; thawed here)
//   { kind: 'hung' }            it still does not answer: a stuck main thread
export async function diagnoseTab(conn, targetId) {
  const ev = await conn.events?.(targetId, { limit: 1 }).catch(() => null);
  if (ev?.dialog) return { kind: 'dialog', dialog: ev.dialog };
  if (ev?.crashed) return { kind: 'crashed' };
  await conn.send(targetId, 'Page.setWebLifecycleState', { state: 'active' }, 3000).catch(() => {});
  const t0 = Date.now();
  try {
    await conn.send(targetId, 'Runtime.evaluate', { expression: '1', returnByValue: true }, 4000);
    return { kind: 'recovered', ms: Date.now() - t0 };
  } catch (e) {
    if (/crash|Target closed|No target|detached/i.test(String(e.message))) return { kind: 'crashed' };
    return { kind: 'hung' };
  }
}

export function describeDiagnosis(d, targetId, ms) {
  const tab = targetId.slice(0, 8), secs = ms ? `${Math.round(ms / 1000)} s` : 'a while';
  switch (d.kind) {
    case 'dialog': {
      const how = d.dialog.type === 'prompt' ? `browserctrl dialog ${tab} --accept --text "…"` : `browserctrl dialog ${tab} --accept   (or --dismiss)`;
      return `The page is showing a JavaScript ${d.dialog.type} dialog${d.dialog.message ? `: "${d.dialog.message.slice(0, 120)}"` : ''}. Its scripts wait until it is answered. Answer it: ${how}`;
    }
    case 'crashed':
      return `The tab's renderer crashed, so the page cannot run anything. Reload it: browserctrl reload ${tab}`;
    case 'recovered':
      return `The page did not answer for ${secs} (busy, or frozen in the background) but answers again now. Run the command again.`;
    default:
      return `The page is not responding: its main thread has been stuck for over ${secs} (a heavy or looping script, or a hung renderer). ` +
        `Run: browserctrl reload ${tab}   (stops the script and reloads; if the page still does not answer it restarts the renderer, and as a last resort reopens the page in a new tab whose id it prints; typed input is lost). Or add --recover to read, text or items.`;
  }
}

const TIMED_OUT = /Runtime\.evaluate timed out after (\d+)ms/;
export async function evaluate(conn, targetId, expression, { awaitPromise = true, timeoutMs, light = false, commandLineAPI = false, retry = false } = {}) {
  let r;
  try {
    r = await conn.send(targetId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise, ...(commandLineAPI ? { includeCommandLineAPI: true } : {}) }, timeoutMs, { light });
  } catch (e) {
    const m = TIMED_OUT.exec(String(e.message));
    if (!m) throw e;
    const d = await diagnoseTab(conn, targetId);
    // Read-only callers (read, text, items) run again once when the page answers again.
    if (retry && d.kind === 'recovered') return evaluate(conn, targetId, expression, { awaitPromise, timeoutMs, light, commandLineAPI });
    const err = new Error(`Runtime.evaluate timed out after ${m[1]}ms (its outcome is uncertain; it was not replayed). ${describeDiagnosis(d, targetId, Number(m[1]))}`);
    err.code = 'timeout';
    err.diagnosis = d;
    throw err;
  }
  if (r?.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'JS exception');
  }
  return r?.result?.value;
}

export async function html(conn, targetId, selector) {
  const expr = selector
    ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML ?? null`
    : 'document.documentElement.outerHTML';
  const out = await evaluate(conn, targetId, expr);
  if (out === null && selector) throw new Error(`No element matches ${selector}`);
  return out;
}

// ------------------------------------------------------------------ read ----

// all: false lists only elements within about one screen of the viewport (plus an open
// modal) and counts the rest; the `read` command and browser_read do that by default.
// Programmatic callers get the whole page unless they ask, and the ones that look a
// target up by name (do, --intent, batch) pass all: true explicitly so offscreen
// controls such as a Next link stay findable.
export async function readPage(conn, targetId, { maxText = 20000, max = 400, includeHidden = false, all = true } = {}) {
  // The command-line API gives the snapshot getEventListeners(), so a div with its own
  // click listener counts as clickable (checked on small pages only).
  return evaluate(conn, targetId, snapshotExpression({ maxText, max, includeHidden, all }), { commandLineAPI: true, retry: true });
}

// Wait, up to timeoutMs, for a page to finish loading before it is read: the document
// complete and no skeleton, spinner or progress placeholders on screen. A page whose
// markers never change (a decorative "loading" class, a permanent spinner) is taken as
// loaded once they have held still for stableMs. Never throws: a page that cannot be
// probed is read as it is.
//   settle(conn, tab, { timeoutMs = 8000 }) -> { waitedMs, cleared, stable?, why? }
// cleared: no loading signal remains; stable: signals remain but stopped changing;
// why: the remaining signals when not cleared.
export async function settle(conn, targetId, { timeoutMs = 8000, intervalMs = 250, stableMs = 2000, busyStableMs = 4000, quietMs = 1000 } = {}) {
  const t0 = Date.now();
  const probe = () => evaluate(conn, targetId, LOADING_EXPR, { awaitPromise: false, timeoutMs: 5000 }).catch(() => null);
  let s = await probe();
  if (!s || !s.loading) return { waitedMs: Date.now() - t0, cleared: true };
  // Only readyState says loading, on a page seen before never to finish: read it now.
  if (!s.visual && neverCompletes(s.href)) return { waitedMs: Date.now() - t0, cleared: true, neverCompletes: true };
  let sig = s.sig, since = Date.now(), quietSince = s.visual ? null : Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise(r => setTimeout(r, intervalMs));
    const next = await probe();
    if (!next) break;
    s = next;
    if (!s.loading) return { waitedMs: Date.now() - t0, cleared: true };
    // Nothing on screen has looked like loading for quietMs, only readyState: some
    // subresource (a tracking pixel, a stalled ad) never answers. Read the page, and
    // remember its kind so the next read does not wait at all.
    if (s.visual) quietSince = null;
    else if (quietSince == null) quietSince = Date.now();
    else if (Date.now() - quietSince >= quietMs) {
      rememberNeverCompletes(s.href);
      return { waitedMs: Date.now() - t0, cleared: false, stable: true, neverCompletes: true, why: s.why };
    }
    if (s.sig !== sig) { sig = s.sig; since = Date.now(); }
    // Held still for stableMs with the page quiet, or for busyStableMs while it keeps talking
    // to its server (chatty pages poll forever).
    else if (s.ready === 'complete' && Date.now() - since >= stableMs && (Date.now() - since >= busyStableMs || !(await inFlight(conn, targetId)))) {
      // A request that just answered is still being rendered: look once more.
      await new Promise(r => setTimeout(r, intervalMs));
      const last = await probe();
      if (last && !last.loading) return { waitedMs: Date.now() - t0, cleared: true };
      return { waitedMs: Date.now() - t0, cleared: false, stable: true, why: (last || s).why };
    }
  }
  return { waitedMs: Date.now() - t0, cleared: false, why: s.why };
}

// Pages that never reach readyState complete, by origin and path with ids folded
// (/site/123.p -> /site/*), so every product page of a site that does this is known
// after the first. Kept a week in a small file, since each CLI command is its own process.
const NEVER_COMPLETE_DAYS = 7;
const neverCompleteFile = () => process.env.BROWSERCTRL_SETTLE_MEMORY || path.join(state.CDP_HOME, 'never-complete.json');
export function pageKind(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const p = u.pathname.replace(/\/+$/, '').split('/').map(seg => (/\d/.test(seg) || seg.length > 24 ? '*' : seg)).join('/');
  return `${u.host}${p || '/'}`;
}
function readNeverComplete() {
  try { return JSON.parse(fs.readFileSync(neverCompleteFile(), 'utf8')) || {}; } catch { return {}; }
}
function neverCompletes(href) {
  const k = pageKind(href);
  const at = k && readNeverComplete()[k];
  return Boolean(at && Date.now() - at < NEVER_COMPLETE_DAYS * 864e5);
}
function rememberNeverCompletes(href) {
  const k = pageKind(href);
  if (!k) return;
  try {
    const all = readNeverComplete();
    all[k] = Date.now();
    const kept = Object.entries(all).sort((a, b) => b[1] - a[1]).slice(0, 300);
    fs.mkdirSync(path.dirname(neverCompleteFile()), { recursive: true });
    fs.writeFileSync(neverCompleteFile(), JSON.stringify(Object.fromEntries(kept)));
  } catch {}
}

// Requests the page started in the last 10 s that have not answered, or answered in the
// last second (the next call of a chain, or rendering, follows): placeholders that hold
// still while the page talks to its server are waiting on it, not decoration.
async function inFlight(conn, targetId) {
  const ev = await conn.events?.(targetId, { limit: 80 }).catch(() => null);
  const now = Date.now();
  return (ev?.network || []).filter(r => !BEACON.test(r.url || '') &&
    ((r.status == null && !r.failed && now - r.ts < 10000) || (r.doneTs && now - r.doneTs < 1000))).length;
}
// Analytics, ads and telemetry ping all the time and fill in nothing on the page.
const BEACON = /analytics|doubleclick|googletag|google-analytics|googlesyndication|facebook\.com\/tr|\/collect\b|beacon|pixel|telemetry|sentry|datadog|newrelic|hotjar|segment\.(io|com)|optimizely|clarity\.ms|\/log(s|ging)?\b|\/track(ing)?\b|\/events?\b|\.(png|gif|jpe?g|webp|svg|woff2?|css)(\?|$)/i;

// One line for an agent: how long a read waited and what, if anything, is still loading.
export function describeSettle(st) {
  // A short wait that cleared is not worth a line; the agent only needs to know about real waits.
  if (!st || st.waitedMs < 200 || (st.cleared && st.waitedMs < 1000)) return st && !st.cleared ? `still loading: ${st.why}` : '';
  const secs = (st.waitedMs / 1000).toFixed(1);
  if (st.cleared) return `waited ${secs} s for the page to finish loading`;
  if (st.neverCompletes) return `waited ${secs} s; nothing on screen is loading though the page never reports complete (${st.why}), so it is read as loaded`;
  if (st.stable) return `waited ${secs} s; ${st.why} stopped changing, so the page is read as loaded`;
  return `waited ${secs} s and it is still loading (${st.why}); read again, or use --no-wait to skip waiting`;
}

async function resolveOnce(conn, targetId, ref, token) {
  const r = await evaluate(conn, targetId, resolveRefExpression(ref, token));
  if (!r || r.error) {
    const err = new Error(`${REF_ERRORS[r?.error] || `Could not resolve ${ref}`}${r?.by ? ` (covered by ${r.by})` : ''}`);
    err.code = r?.error || 'ref_error';
    throw err;
  }
  return r;
}

// Late images and lazy content shift layout after a scroll; act only once the element
// stops moving, so the input lands on it and not on whatever slid into its place.
async function resolveRef(conn, targetId, ref, token) {
  let r;
  try { r = await resolveOnce(conn, targetId, ref, token); }
  catch (e) {
    // A sticky header or a floating bar often sits over an element near the screen's edge:
    // bring it to the middle of the screen and look again before refusing the click.
    if (e.code !== 'covered') throw e;
    await evaluate(conn, targetId, `(function(){ var el = ${refLookupExpression(ref, token)}; if (el && typeof el !== 'string') el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); })()`).catch(() => {});
    await new Promise(res => setTimeout(res, 150));
    r = await resolveOnce(conn, targetId, ref, token);
  }
  for (let i = 0; i < 4; i++) {
    await new Promise(res => setTimeout(res, 50));
    const next = await resolveOnce(conn, targetId, ref, token);
    if (Math.abs(next.x - r.x) < 3 && Math.abs(next.y - r.y) < 3) return next;
    r = next;
  }
  return r;
}

// Resolve whatever the caller gave us (ref, CSS selector, or coordinates) into
// a click point in CSS pixels.
async function pointFor(conn, targetId, { ref, selector, x, y, token }) {
  if (typeof x === 'number' && typeof y === 'number') return { x, y };
  if (ref) return resolveRef(conn, targetId, ref, token);
  if (selector) {
    const r = await evaluate(
      conn,
      targetId,
      `(function(){
         var el = document.querySelector(${JSON.stringify(selector)});
         if (!el) return null;
         for (var node = el; node; node = node.parentElement || (node.getRootNode && node.getRootNode().host)) {
           if (node.nodeType === 1 && (node.hasAttribute('data-cdp') || node.getAttribute('data-cdp-internal') === 'true')) return { internal: true };
         }
         // Scroll only when it is not fully on screen: some widgets (Airbnb's date picker)
         // close on any scroll, so scrolling an element already in view breaks the click.
         var r = el.getBoundingClientRect();
         if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth || !r.width || !r.height) {
           el.scrollIntoView({block:'center', inline:'center', behavior:'instant'});
           r = el.getBoundingClientRect();
         }
         return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), tag: el.tagName.toLowerCase() };
       })()`,
    );
    if (!r) throw new Error(`No element matches ${selector}`);
    if (r.internal) throw new Error(`Selector ${selector} matches Chrome CDP’s annotation UI, not the web page.`);
    return r;
  }
  throw new Error('Give a ref, a selector, or x/y coordinates.');
}

// ----------------------------------------------------------------- input ----

function modifierMask(mods = []) {
  return mods.reduce((m, name) => m | (MODIFIERS[String(name).toLowerCase()] || 0), 0);
}

// An input event that starts a navigation can lose its acknowledgement from the old page,
// so the call would wait out its full timeout. Input gets a short timeout; a timeout is
// carried on from (the event was sent; the next read sees what it did), anything else throws.
const INPUT_MS = 6000;
async function sendInput(conn, targetId, method, params) {
  try { return await conn.send(targetId, method, params, INPUT_MS); }
  catch (e) { if (/timed out/i.test(String(e.message))) return { uncertain: true }; throw e; }
}

// The input opened a JavaScript dialog (the daemon answers the input when it opens): say
// so in the result, with the command that answers it.
function dialogNote(results, targetId) {
  const d = results.find(r => r?.dialogOpened)?.dialogOpened;
  if (!d) return {};
  return { dialog: { type: d.type, message: d.message }, next: `the page opened a JavaScript ${d.type} and waits for an answer: browserctrl dialog ${targetId.slice(0, 8)} --accept   (or --dismiss)` };
}

export async function click(conn, targetId, opts = {}) {
  const { button = 'left', clickCount = 1, modifiers = [] } = opts;
  const p = await pointFor(conn, targetId, opts);
  const mods = modifierMask(modifiers);
  const sent = [];
  sent.push(await sendInput(conn, targetId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, modifiers: mods }));
  sent.push(await sendInput(conn, targetId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x: p.x, y: p.y, button, clickCount, modifiers: mods,
  }));
  sent.push(await sendInput(conn, targetId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: p.x, y: p.y, button, clickCount, modifiers: mods,
  }));
  return { clicked: { x: p.x, y: p.y }, button, clickCount, ...dialogNote(sent, targetId) };
}

export async function hover(conn, targetId, opts = {}) {
  const p = await pointFor(conn, targetId, opts);
  await sendInput(conn, targetId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  return { hovered: { x: p.x, y: p.y } };
}

export async function drag(conn, targetId, { from, to }) {
  const a = await pointFor(conn, targetId, from);
  const b = await pointFor(conn, targetId, to);
  await conn.send(targetId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
  await conn.send(targetId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 });
  // A couple of intermediate moves: some drag implementations ignore a single jump.
  for (const t of [0.33, 0.66, 1]) {
    await conn.send(targetId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: Math.round(a.x + (b.x - a.x) * t), y: Math.round(a.y + (b.y - a.y) * t), button: 'left',
    });
  }
  await conn.send(targetId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  return { dragged: { from: { x: a.x, y: a.y }, to: { x: b.x, y: b.y } } };
}

export async function type(conn, targetId, text) {
  await conn.send(targetId, 'Input.insertText', { text });
  return { typed: text.length > 60 ? `${text.slice(0, 60)}...` : text };
}

// Accepts "Enter", "cmd+a", "shift+Tab", or a single character.
export async function key(conn, targetId, spec) {
  const parts = String(spec).split('+');
  const name = parts.pop();
  const mods = modifierMask(parts);
  const known = KEYS[name] || KEYS[name[0].toUpperCase() + name.slice(1)];
  const def = known || { code: name.toUpperCase().charCodeAt(0), key: name, text: name.length === 1 ? name : undefined };
  const base = { modifiers: mods, key: def.key, windowsVirtualKeyCode: def.code, nativeVirtualKeyCode: def.code };
  const sent = [await sendInput(conn, targetId, 'Input.dispatchKeyEvent', {
    ...base,
    type: def.text && !mods ? 'keyDown' : 'rawKeyDown',
    ...(def.text && !mods ? { text: def.text } : {}),
  })];
  if (!sent[0]?.dialogOpened) sent.push(await sendInput(conn, targetId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' }));
  return { pressed: spec, ...dialogNote(sent, targetId) };
}

// Set a form value the way a framework will notice: native setter plus the
// input/change events React and friends listen for.
// Types the value the way a person does (select what is there, then insert text), so
// inputs that react to keystrokes (search-as-you-type, token filters, comboboxes,
// framework-controlled fields) see it. Falls back to setting the value when typing did
// not take (date pickers, read-only masks).
// The element a ref or selector names, followed to the field it stands for: a label to its
// control, a wrapper holding exactly one field to that field. Anything else is not a field,
// and the error names the nearest field in the same snapshot so the next call can use it.
function fieldLocator(ref, selector, token) {
  const base = ref ? refLookupExpression(ref, token) : `document.querySelector(${JSON.stringify(selector || '')})`;
  return `var el = ${base};
       if (typeof el === 'string') return { error: 'ref', code: el };
       if (!el) return { error: 'not_found' };
       for (var node = el; node; node = node.parentElement || (node.getRootNode && node.getRootNode().host)) {
         if (node.nodeType === 1 && (node.hasAttribute('data-cdp') || node.getAttribute('data-cdp-internal') === 'true')) return { error: 'internal' };
       }
       if (!el.ownerDocument || !el.ownerDocument.defaultView) return { error: 'ref', code: 'frame_replaced' };
       var W = el.ownerDocument.defaultView; // a ref can sit in a same-origin frame
       // By tag, not instanceof: an element from another frame fails instanceof against this window.
       function isField(n) {
         return !!n && n.nodeType === 1 && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName));
       }
       if (!isField(el)) {
         var via = null;
         if (el.tagName === 'LABEL' && el.control) via = el.control;
         if (!via) { var inner = el.querySelectorAll ? Array.prototype.filter.call(el.querySelectorAll('input:not([type=hidden]),textarea,select,[contenteditable=""],[contenteditable=true]'), function (n) { return n.getClientRects().length; }) : []; if (inner.length === 1) via = inner[0]; }
         if (!via) { var lab = el.closest && el.closest('label'); if (lab && lab.control) via = lab.control; }
         if (!via && el.getAttribute) { var forId = el.getAttribute('aria-controls') || el.getAttribute('for'); var t = forId && el.ownerDocument.getElementById(forId); if (isField(t)) via = t; }
         if (!via) {
           var r0 = el.getBoundingClientRect(), best = null, bestD = Infinity, snap = window.__cdp;
           ((snap && snap.els) || []).forEach(function (n, k) {
             if (!isField(n) || !n.isConnected) return;
             var r = n.getBoundingClientRect(); if (!r.width && !r.height) return;
             var dx = Math.max(0, r.left - r0.right, r0.left - r.right), dy = Math.max(0, r.top - r0.bottom, r0.top - r.bottom), d = Math.hypot(dx, dy * 2); // the same line first
             if (d < bestD) { bestD = d; best = 'ref_' + (k + 1) + ' (' + (n.getAttribute('aria-label') || n.getAttribute('placeholder') || n.name || n.tagName.toLowerCase()).slice(0, 40) + ')'; }
           });
           return { error: 'not_field', tag: el.tagName.toLowerCase(), name: ((el.getAttribute && el.getAttribute('aria-label')) || el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 40), nearest: best };
         }
         el = via;
       }
       function current() { return el.isContentEditable ? el.textContent : el.value; }`;
}

function fieldError(r, what) {
  if (r?.error === 'ref') {
    const err = new Error(REF_ERRORS[r.code] || `Could not resolve ${what}`);
    err.code = r.code;
    return err;
  }
  if (r?.error === 'not_found') return new Error(`No element for ${what}`);
  if (r?.error === 'internal') return new Error(`${what} belongs to Chrome CDP’s annotation UI, not the web page.`);
  if (r?.error === 'not_field') {
    return new Error(`${what} is a <${r.tag}>${r.name ? ` "${r.name}"` : ''}, not a field you can type into.` +
      (r.nearest ? ` Nearest field: ${r.nearest}.` : '') + ' Click it instead, or re-run read and pick a textbox.');
  }
  return null;
}

// Set a form value the way a framework will notice: native setter plus the
// input/change events React and friends listen for.
// Types the value the way a person does (select what is there, then insert text), so
// inputs that react to keystrokes (search-as-you-type, token filters, comboboxes,
// framework-controlled fields) see it. Falls back to setting the value when typing did
// not take (date pickers, read-only masks).
export async function fill(conn, targetId, { ref, selector, value, token }) {
  if (!ref && !selector) throw new Error('fill needs a target: browserctrl fill <tab> ref_N "value" (or --ref ref_N / --selector CSS) --value "…"');
  const text = String(value ?? '');
  const find = fieldLocator(ref, selector, token);
  const setValue = `var proto = el.tagName === 'TEXTAREA' ? W.HTMLTextAreaElement.prototype
                 : el.tagName === 'SELECT' ? W.HTMLSelectElement.prototype
                 : el.tagName === 'INPUT' ? W.HTMLInputElement.prototype : null;
       var setter = proto && Object.getOwnPropertyDescriptor(proto, 'value');
       if (el.isContentEditable) el.textContent = ${JSON.stringify(text)};
       else if (setter && setter.set) setter.set.call(el, ${JSON.stringify(text)});
       else el.value = ${JSON.stringify(text)};
       el.dispatchEvent(new Event('input', { bubbles: true }));
       el.dispatchEvent(new Event('change', { bubbles: true }));`;
  const prep = await evaluate(conn, targetId, `(function(){
       ${find}
       var typeable = el.isContentEditable || el.tagName === 'TEXTAREA' ||
         (el.tagName === 'INPUT' && !/^(date|datetime-local|month|week|time|color|range|file|checkbox|radio|hidden)$/.test(el.type));
       if (!typeable) { el.focus(); ${setValue} return { done: true, tag: el.tagName.toLowerCase(), value: current() }; }
       el.focus();
       if (el.isContentEditable) {
         var r = el.ownerDocument.createRange(); r.selectNodeContents(el);
         var sel = W.getSelection(); sel.removeAllRanges(); sel.addRange(r);
       } else { try { el.select(); } catch (e) { try { el.setSelectionRange(0, el.value.length); } catch (e2) {} } }
       return { before: current() || '' };
     })()`);
  const bad = fieldError(prep, ref || selector);
  if (bad) throw bad;
  if (prep?.done) return { ok: true, tag: prep.tag, value: prep.value };
  // Typing needs the page to take input; a background tab that does not (seen on Windows)
  // would hang, so give it 1.5 s and fall back to setting the value below.
  try {
    if (text) await conn.send(targetId, 'Input.insertText', { text }, 1500);
    else if (prep.before) await key(conn, targetId, 'Backspace');
  } catch {}
  const out = await evaluate(conn, targetId, `(function(){
       ${find}
       var now = current() || '';
       var took = ${JSON.stringify(text)} === '' ? now === '' : now !== ${JSON.stringify(prep.before)} || now === ${JSON.stringify(text)};
       if (!took) { ${setValue} return { ok: true, tag: el.tagName.toLowerCase(), value: current(), typed: false }; }
       return { ok: true, tag: el.tagName.toLowerCase(), value: now, typed: true };
     })()`);
  const bad2 = fieldError(out, ref || selector);
  if (bad2) throw bad2;
  return out;
}

export async function selectOption(conn, targetId, { ref, selector, value, label, token }) {
  const locator = ref
    ? `(function(){ var el = ${refLookupExpression(ref, token)}; return typeof el === 'string' ? null : el; })()`
    : `document.querySelector(${JSON.stringify(selector || '')})`;
  const out = await evaluate(
    conn,
    targetId,
    `(function(){
       var el = ${locator};
       if (!el || el.tagName.toLowerCase() !== 'select') return { error: 'not_select' };
       var want = ${JSON.stringify(value ?? null)}, wantLabel = ${JSON.stringify(label ?? null)};
       var opt = Array.prototype.find.call(el.options, function (o) {
         return (want !== null && o.value === want) || (wantLabel !== null && o.text.trim() === wantLabel);
       });
       if (!opt) return { error: 'no_option', options: Array.prototype.map.call(el.options, function (o) { return o.text.trim(); }).slice(0, 30) };
       el.value = opt.value;
       el.dispatchEvent(new Event('input', { bubbles: true }));
       el.dispatchEvent(new Event('change', { bubbles: true }));
       return { ok: true, selected: opt.text.trim(), value: opt.value };
     })()`,
  );
  if (out?.error === 'not_select') throw new Error(`${ref || selector} is not a <select>`);
  if (out?.error === 'no_option') throw new Error(`No such option. Available: ${(out.options || []).join(' | ')}`);
  return out;
}

export async function upload(conn, targetId, { ref, selector, files }) {
  const paths = (Array.isArray(files) ? files : [files]).map(f => {
    if (!fs.existsSync(f)) throw new Error(`File not found: ${f}`);
    return f;
  });
  const { root } = await conn.send(targetId, 'DOM.getDocument', { depth: -1, pierce: true });
  let nodeId;
  if (selector) {
    ({ nodeId } = await conn.send(targetId, 'DOM.querySelector', { nodeId: root.nodeId, selector }));
  } else if (ref) {
    const objId = await conn.send(targetId, 'Runtime.evaluate', {
      expression: `(function(){ var el = ${refLookupExpression(ref)}; return typeof el === 'string' ? null : el; })()`,
    });
    const { nodeId: n } = await conn.send(targetId, 'DOM.requestNode', { objectId: objId.result.objectId });
    nodeId = n;
  }
  if (!nodeId) throw new Error(`No file input for ${ref || selector}`);
  await conn.send(targetId, 'DOM.setFileInputFiles', { files: paths, nodeId });
  return { uploaded: paths };
}

export async function scroll(conn, targetId, { x = 100, y = 300, deltaX = 0, deltaY = 400 }) {
  const handled = await evaluate(conn, targetId, `(() => {
    if (document.visibilityState === 'visible') return false;
    const dx = ${JSON.stringify(deltaX)}, dy = ${JSON.stringify(deltaY)};
    let el = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
    for (; el; el = el.parentElement || el.getRootNode()?.host) {
      const style = getComputedStyle(el);
      const scrollX = dx && /auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth;
      const scrollY = dy && /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight;
      if (scrollX || scrollY) { el.scrollBy({left: dx, top: dy, behavior: 'instant'}); return true; }
    }
    window.scrollBy({left: dx, top: dy, behavior: 'instant'});
    return true;
  })()`);
  if (handled) return { scrolled: { deltaX, deltaY }, background: true };
  await conn.send(targetId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
  return { scrolled: { deltaX, deltaY } };
}

export async function scrollTo(conn, targetId, { ref, selector, token }) {
  const p = await pointFor(conn, targetId, { ref, selector, token });
  return { scrolledTo: ref || selector, at: { x: p.x, y: p.y } };
}

// ------------------------------------------------------------ navigation ----

export async function navigate(conn, targetId, url, { waitUntil = 'load', timeoutMs = 30000 } = {}) {
  const started = Date.now();
  await conn.send(targetId, 'Page.navigate', { url }, timeoutMs);
  if (waitUntil === 'none') return { url, waited: 'none' };
  await waitForReady(conn, targetId, { waitUntil, timeoutMs: timeoutMs - (Date.now() - started) });
  const now = await evaluate(conn, targetId, 'location.href');
  return { url: now, waited: waitUntil, ms: Date.now() - started };
}

export async function reload(conn, targetId, {waitUntil = 'load', timeoutMs = 30000} = {}) {
  if (!['load', 'domcontentloaded', 'networkidle', 'none'].includes(waitUntil)) throw new Error('Unsupported reload wait mode');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) throw new Error('Reload timeout must be greater than 0 and at most 120000ms');
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    const ms = Math.ceil(deadline - performance.now());
    if (ms <= 0) throw new Error(`Reload timed out after ${timeoutMs}ms; it was not replayed. Inspect the tab before continuing.`);
    return ms;
  };
  const send = async (method, params = {}) => {
    const ms = remaining();
    let timer;
    try {
      return await Promise.race([
        conn.send(targetId, method, params, ms),
        new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('Reload deadline exceeded; its outcome may be uncertain and it was not replayed.')), ms);}),
      ]);
    } finally {clearTimeout(timer);}
  };
  const initial = await send('Page.getFrameTree');
  const loaderId = initial.frameTree?.frame?.loaderId;
  if (waitUntil !== 'none' && !loaderId) throw new Error('Cannot observe the current document loader. No reload was sent.');
  await send('Page.reload');
  if (waitUntil === 'none') return {reloaded: true, waited: 'none'};
  // The old document may still report complete after Page.reload acknowledges.
  while (true) {
    const current = await send('Page.getFrameTree');
    if (current.frameTree?.frame?.loaderId && current.frameTree.frame.loaderId !== loaderId) break;
    await sleep(Math.min(100, remaining()));
  }
  const observation = await waitForBackgroundReady(conn, targetId, {
    waitUntil: waitUntil === 'networkidle' ? 'load' : waitUntil, timeoutMs: remaining(),
  });
  if (waitUntil === 'networkidle') {
    let lastCount = -1, stableSince = performance.now();
    while (true) {
      const value = await send('Runtime.evaluate', {expression: "performance.getEntriesByType('resource').length", returnByValue: true});
      if (value.exceptionDetails || !Number.isFinite(value.result?.value)) throw new Error('Reload could not observe network quiet; it was not replayed.');
      if (value.result.value !== lastCount) {lastCount = value.result.value; stableSince = performance.now();}
      else if (performance.now() - stableSince >= 500) break;
      await sleep(Math.min(100, remaining()));
    }
  }
  return {...observation, reloaded: true, waited: waitUntil};
}

// A page whose main thread is stuck cannot run a reload: its renderer has to go. Ending
// it (Page.crash) and navigating to the same address starts a fresh renderer. Typed
// input and page state are lost, as with any reload.
export async function hardReload(conn, targetId, { timeoutMs = 30000 } = {}) {
  let url = null;
  try { url = (await conn.browser('Target.getTargetInfo', { targetId }, 5000)).targetInfo?.url; } catch {}
  if (!url || /^(about|chrome|devtools):/.test(url)) throw new Error('Cannot tell which page this tab was showing; open it again with browserctrl nav.');
  await conn.send(targetId, 'Page.crash', {}, 3000).catch(() => {});
  await sleep(500);
  return { ...(await navigate(conn, targetId, url, { waitUntil: 'load', timeoutMs })), restartedRenderer: true };
}

// A page whose main thread is stuck (a looping script, a hung renderer) cannot run a
// reload. Stop its script first (Runtime.terminateExecution is answered even while the
// page is busy), then load the same address again. If the page still does not answer, end
// its renderer and load it again; if even that fails, replace the tab: close it and open
// the same address in a new one. A replaced tab has a new id, and its refs, claim and
// recording do not carry over. Typed input and page state are lost in every case.
export async function recoverTab(conn, targetId, { timeoutMs = 20000 } = {}) {
  // A wedged renderer can stall the daemon long enough that it drops this client; one
  // reconnect and retry keeps recovery going instead of failing on its first step.
  const daemonGone = (e) => /Daemon (connection|IPC)/.test(String(e?.message || e));
  const again = async (fn) => {
    try { return await fn(); } catch (e) {
      if (!daemonGone(e) || !conn.reconnect) throw e;
      await conn.reconnect();
      return fn();
    }
  };
  let url = null, why = '';
  try { url = (await again(() => conn.browser('Target.getTargetInfo', { targetId }, 5000))).targetInfo?.url; } catch (e) { why = ` (${String(e.message || e).slice(0, 120)})`; }
  if (!url || /^(about|chrome|devtools):/.test(url)) throw new Error(`Cannot tell which page this tab was showing${url ? ` (it shows ${url})` : why}; open it again with browserctrl nav.`);
  const tried = [];
  // Recovered once the new document answers, and still answers a second later (a page
  // that wedges again right after loading is not recovered). Each check is short, so a
  // stuck page fails fast.
  const answers = async (id, ms) => {
    const end = Date.now() + ms;
    const ready = async () => {
      try {
        const r = await conn.send(id, 'Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, 3000);
        return ['interactive', 'complete'].includes(r?.result?.value);
      } catch { return false; }
    };
    while (Date.now() < end) {
      if (await ready()) { await sleep(1000); if (await ready()) return true; }
      await sleep(250);
    }
    return false;
  };
  await conn.send(targetId, 'Runtime.terminateExecution', {}, 3000).then(() => tried.push('stopped its script'), () => {});
  try {
    await conn.send(targetId, 'Page.navigate', { url }, Math.min(10000, timeoutMs));
    if (await answers(targetId, timeoutMs)) return { recovered: 'reloaded', tab: targetId.slice(0, 8), url, tried: [...tried, 'reloaded'] };
  } catch {}
  tried.push('reload did not answer');
  await conn.send(targetId, 'Page.crash', {}, 3000).catch(() => {});
  await sleep(500);
  try {
    await conn.send(targetId, 'Page.navigate', { url }, Math.min(10000, timeoutMs));
    if (await answers(targetId, timeoutMs)) return { recovered: 'restarted its renderer', tab: targetId.slice(0, 8), url, tried: [...tried, 'restarted its renderer'] };
  } catch {}
  tried.push('a new renderer did not answer');
  await again(() => conn.browser('Target.closeTarget', { targetId }, 5000)).catch(() => {});
  claims.release(conn.port, targetId);
  const fresh = await again(() => newTab(conn, url));
  await answers(fresh.targetId, timeoutMs);
  return { recovered: 'replaced the tab', replaced: true, oldTab: targetId.slice(0, 8), tab: fresh.id, targetId: fresh.targetId, url, tried: [...tried, `closed it and opened ${url} in tab ${fresh.id}`] };
}

export const refresh = reload;

// Readiness without a fixed sleep: document.readyState, then optionally a
// quiet period with no new resource entries.
export async function waitForReady(conn, targetId, { waitUntil = 'load', timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  // A new tab shows its initial about:blank, already "complete", before the real URL
  // commits: not ready while the tab is headed elsewhere.
  let target = null;
  try { target = (await conn.browser('Target.getTargetInfo', { targetId })).targetInfo.url; } catch {}
  const headedElsewhere = target && !/^about:blank/.test(target);
  while (Date.now() < deadline) {
    const r = await evaluate(conn, targetId, '[document.readyState, location.href]').catch(() => null);
    const [state, href] = r || [];
    const blank = headedElsewhere && /^about:blank/.test(href || '');
    if (!blank && (state === 'complete' || (waitUntil === 'domcontentloaded' && state === 'interactive'))) break;
    await sleep(100);
  }
  if (waitUntil !== 'networkidle') return { ready: waitUntil };
  let lastCount = -1;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const count = await evaluate(conn, targetId, "performance.getEntriesByType('resource').length").catch(() => lastCount);
    if (count !== lastCount) {
      lastCount = count;
      stableSince = Date.now();
    } else if (Date.now() - stableSince > 500) {
      return { ready: 'networkidle', resources: count };
    }
    await sleep(100);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for network idle.`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// One wait to replace every blind sleep in a script.
export async function waitFor(
  conn,
  targetId,
  { selector, text, url, fn, gone, networkIdle, present = false, timeoutMs = 15000 } = {},
) {
  if (networkIdle) return waitForReady(conn, targetId, { waitUntil: 'networkidle', timeoutMs });
  const deadline = Date.now() + timeoutMs;
  // "Appeared" means visible, not merely present in the DOM. A display:none
  // node that is already in the markup would otherwise satisfy the wait
  // instantly and hand back a page that has not actually updated. Pass
  // present:true when existence really is the condition you mean.
  const visible = sel => `(function(){
     var e = document.querySelector(${JSON.stringify(sel)});
     if (!e) return false;
     var r = e.getBoundingClientRect(), s = getComputedStyle(e);
     return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity || '1') > 0.05;
   })()`;
  const expr = selector
    ? present
      ? `!!document.querySelector(${JSON.stringify(selector)})`
      : visible(selector)
    : gone
      ? present
        ? `!document.querySelector(${JSON.stringify(gone)})`
        : `!${visible(gone)}`
      : text
        ? `(document.body ? document.body.innerText : '').includes(${JSON.stringify(text)})`
        : url
          ? `location.href.includes(${JSON.stringify(url)})`
          : fn;
  if (!expr) throw new Error('waitFor needs one of: selector, text, url, gone, fn, networkIdle');
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(conn, targetId, expr).catch(e => {
      last = e.message;
      return false;
    });
    if (last) return { matched: selector || gone || text || url || 'fn', ms: timeoutMs - (deadline - Date.now()) };
    await sleep(150);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${selector || gone || text || url || 'condition'}. ` +
      `Check the page with: cdp read <tab>`,
  );
}

// ------------------------------------------------------------ screenshots ---

export async function screenshot(conn, targetId, { path: outPath = path.join(os.tmpdir(), `cdp-shot-${targetId.slice(0,8)}.png`), fullPage = false, ref, selector, region, token, emulateFocus = false } = {}) {
  try {
    if (emulateFocus) await conn.send(targetId, 'Emulation.setFocusEmulationEnabled', {enabled:true});
    const params = { format: 'png', captureBeyondViewport: Boolean(fullPage) };
    if (fullPage) {
      const m = await conn.send(targetId, 'Page.getLayoutMetrics');
      const size = m.cssContentSize || m.contentSize;
      params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
    } else if (ref || selector) {
      const el = await evaluate(
        conn,
        targetId,
        ref
          ? `(function(){ var e = ${refLookupExpression(ref, token)};
               if (!e || typeof e === 'string') return null; e.scrollIntoView({block:'center', behavior:'instant'});
               var r = e.getBoundingClientRect();
               return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`
          : `(function(){ var e = document.querySelector(${JSON.stringify(selector)});
               if (!e) return null; e.scrollIntoView({block:'center', behavior:'instant'});
               var r = e.getBoundingClientRect();
               return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`,
      );
      if (!el) throw new Error(`No element for ${ref || selector}`);
      params.clip = { x: Math.round(el.x), y: Math.round(el.y), width: Math.ceil(el.width), height: Math.ceil(el.height), scale: 1 };
      params.captureBeyondViewport = true;
    } else if (region) {
      params.clip = { ...region, scale: 1 };
      params.captureBeyondViewport = true;
    }
    void token;
    const r = await conn.send(targetId, 'Page.captureScreenshot', params, 30000);
    const buffer = Buffer.from(r.data, 'base64');
    fs.writeFileSync(outPath, buffer);
    const dpr = await evaluate(conn, targetId, 'window.devicePixelRatio').catch(() => 1);
    return { path: outPath, bytes: buffer.length, dpr, base64: r.data };
  } finally {
    if (emulateFocus) {
      try { await conn.send(targetId, 'Emulation.setFocusEmulationEnabled', {enabled:false}); }
      catch (cause) { throw new Error('Screenshot focus emulation could not be disabled. Inspect the tab before continuing.', {cause}); }
    }
  }
}

// ----------------------------------------------------------- diagnostics ----

export async function diagnostics(conn, targetId, { limit = 50, clear = false, kinds } = {}) {
  const all = await conn.events(targetId, { limit, clear });
  if (!kinds) return all;
  const want = new Set(kinds);
  return Object.fromEntries(Object.entries(all).filter(([k]) => want.has(k)));
}

export async function failedRequests(conn, targetId, { limit = 50 } = {}) {
  const { network } = await conn.events(targetId, { limit: 500 });
  return network.filter(r => r.failed || (r.status && r.status >= 400)).slice(-limit);
}

export async function cookies(conn, targetId, { urls } = {}) {
  const r = await conn.send(targetId, 'Network.getCookies', urls ? { urls } : {});
  return r.cookies;
}

export async function setCookie(conn, targetId, cookie) {
  await conn.send(targetId, 'Network.setCookie', cookie);
  return { set: cookie.name };
}

// ------------------------------------------------------------- annotation ---

// Install the shared overlay into a tab. Registered for future documents too,
// so it survives navigation without the human re-arming it.
export async function installOverlay(conn, targetId, { bridgePort = 17222, force = false } = {}) {
  if (force) {
    // Both halves of the guard have to go: the object in this world, and the
    // marker on <html> that stops any world from installing twice. Clearing
    // only the object leaves the page with no overlay at all.
    await evaluate(
      conn,
      targetId,
      'try{delete window.__cdpOverlay;document.documentElement.removeAttribute("data-cdp-overlay");}catch(e){};true',
    ).catch(() => {});
  }
  const source =
    `window.__cdpBridge=${JSON.stringify(`http://127.0.0.1:${bridgePort}`)};\n` +
    fs.readFileSync(new URL('./overlay/annotate.js', import.meta.url), 'utf8');
  const { identifier } = await conn.send(targetId, 'Page.addScriptToEvaluateOnNewDocument', { source });
  await evaluate(conn, targetId, source, { timeoutMs: 5000 });
  return { installed: targetId.slice(0, 8), identifier };
}

export async function overlayState(conn, targetId) {
  return evaluate(conn, targetId, 'window.__cdpOverlay ? (window.__cdpOverlay.isOn() ? "on" : "installed") : "absent"');
}

export async function toggleOverlay(conn, targetId) {
  return evaluate(conn, targetId, 'window.__cdpOverlay ? (window.__cdpOverlay.toggle(), window.__cdpOverlay.isOn()) : null');
}

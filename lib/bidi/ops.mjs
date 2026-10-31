// browserctrl's shared commands over WebDriver BiDi. Each function takes an open session
// (lib/bidi/client.mjs) and returns data; the CLI prints it. Input goes through
// input.performActions, so pages see real pointer and key events.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deserialize } from './client.mjs';
import { SANDBOX, SNAPSHOT, LOCATE, SELECT_CONTENT, CHOOSE_OPTION, PROBE, PAGE_TEXT, PAGE_HTML, PAGE_TITLE, SCROLL } from './page.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// WebDriver key codes for the names browserctrl's key command takes.
export const KEYS = {
  enter: '', return: '', tab: '', escape: '', esc: '', backspace: '',
  delete: '', space: ' ', arrowleft: '', arrowup: '', arrowright: '', arrowdown: '',
  left: '', up: '', right: '', down: '', home: '', end: '',
  pageup: '', pagedown: '', shift: '', control: '', ctrl: '', alt: '',
  meta: '', cmd: '', command: '',
};

export const shortId = context => String(context).slice(0, 8);

/** Top-level tabs: [{ context, url }]. */
export async function topContexts(s) {
  const tree = await s.send('browsingContext.getTree', { maxDepth: 0 });
  return (tree.contexts || []).map(c => ({ context: c.context, url: c.url }));
}

/** A tab word (full id or unique prefix) as a context id. */
export async function resolveContext(s, word) {
  const tabs = await topContexts(s);
  if (!word) {
    const list = tabs.map(t => `  ${shortId(t.context)}  ${t.url}`).join('\n');
    throw Object.assign(new Error(`No tab given. Pick one:\n${list}`), { code: 'TAB_REQUIRED' });
  }
  const w = String(word).toLowerCase();
  const exact = tabs.find(t => t.context.toLowerCase() === w);
  if (exact) return exact.context;
  const hits = tabs.filter(t => t.context.toLowerCase().startsWith(w));
  if (hits.length === 1) return hits[0].context;
  if (hits.length > 1) throw Object.assign(new Error(`Tab "${word}" matches ${hits.length} tabs; give more of its id`), { code: 'TAB_AMBIGUOUS' });
  throw Object.assign(new Error(`No tab "${word}". browserctrl tabs lists them.`), { code: 'TAB_NOT_FOUND' });
}

/** Run a page function (lib/bidi/page.mjs) in the sandbox realm; returns its parsed JSON. */
export async function callPage(s, context, fn, args = {}) {
  const r = await s.send('script.callFunction', {
    functionDeclaration: fn, arguments: [{ type: 'string', value: JSON.stringify(args) }],
    target: { context, sandbox: SANDBOX }, awaitPromise: true, resultOwnership: 'none',
  });
  if (r.type === 'exception') throw new Error(`page script failed: ${r.exceptionDetails?.text || 'exception'}`);
  const value = r.result?.value;
  return typeof value === 'string' ? JSON.parse(value) : deserialize(r.result);
}

/** Wait until the document is complete (tolerates the moment a navigation swaps realms). */
export async function waitForLoad(s, context, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const p = await callPage(s, context, PROBE, {});
      if (p.ready === 'complete') return p;
    } catch {}
    await sleep(150);
  }
  return null;
}

export async function tabs(s) {
  const list = await topContexts(s);
  const out = [];
  for (const t of list) {
    let title = '';
    try { title = (await callPage(s, t.context, PAGE_TITLE)).title; } catch {}
    out.push({ id: shortId(t.context), context: t.context, title, url: t.url });
  }
  return out;
}

// Camoufox does not answer browsingContext.create (its openWindow is disabled), but a page
// may still open a tab. Open it straight at the URL from an existing tab: Camoufox replaces a
// popup's browsing context once it loads, so the tab is reported only after its id and
// document have settled, and the popup is never navigated over BiDi.
async function openFromPage(s, url, { timeoutMs = 30000 } = {}) {
  const before = await topContexts(s);
  if (!before.length) throw new Error('The browser has no tab to open another from');
  const seen = new Set(before.map(t => t.context));
  const target = url || 'about:blank';
  const r = await s.send('script.evaluate', {
    expression: `Boolean(window.open(${JSON.stringify(target)}, "_blank"))`, target: { context: before[0].context },
    awaitPromise: false, userActivation: true, resultOwnership: 'none',
  });
  if (r.type === 'exception' || r.result?.value === false) throw new Error('The browser refused to open a new tab');
  const deadline = Date.now() + timeoutMs;
  let candidate = null;
  let anyFresh = null;
  let steady = 0;
  while (Date.now() < deadline) {
    const fresh = (await topContexts(s)).filter(t => !seen.has(t.context));
    anyFresh = fresh[0]?.context ?? anyFresh;
    const pick = fresh.find(t => target === 'about:blank' || t.url !== 'about:blank') || null;
    if (pick) {
      const p = await callPage(s, pick.context, PROBE, {}).catch(() => null);
      const loaded = p?.ready === 'complete' && (target === 'about:blank' || p.url !== 'about:blank');
      steady = loaded && candidate === pick.context ? steady + 1 : 0;
      candidate = pick.context;
      if (steady >= 2) return { context: candidate, url: p.url };
    }
    await sleep(150);
  }
  // The tab exists but its page has not loaded yet (a slow site): report it as it is.
  if (candidate || anyFresh) return { context: candidate || anyFresh, url: target, loading: true };
  throw new Error(`No new tab appeared within ${timeoutMs / 1000}s`);
}

export async function open(s, url) {
  let context = null;
  if (!/camoufox/i.test(s.capabilities?.browserName || '')) {
    try {
      ({ context } = await s.send('browsingContext.create', { type: 'tab' }, { timeoutMs: 15000 }));
    } catch (error) {
      if (!/unsupported operation/i.test(error.message)) throw error;
    }
  }
  if (!context) {
    const opened = await openFromPage(s, url);
    return { id: shortId(opened.context), context: opened.context, url: opened.url };
  }
  const landed = url ? await navigate(s, context, url) : 'about:blank';
  return { id: shortId(context), context, url: landed };
}

/**
 * Navigate without BiDi's own wait, then poll the page until the new document is complete.
 * Camoufox can leave a navigate that waits for "complete" unanswered; polling cannot hang.
 */
export async function navigate(s, context, url, { timeoutMs = 30000 } = {}) {
  const before = await callPage(s, context, PROBE, {}).catch(() => null);
  const r = await s.send('browsingContext.navigate', { context, url, wait: 'none' });
  const deadline = Date.now() + timeoutMs;
  await sleep(100);
  while (Date.now() < deadline) {
    const p = await callPage(s, context, PROBE, {}).catch(() => null);
    const moved = !before || p?.url !== before.url || before.url === url || p?.url === url;
    if (p && moved && p.ready === 'complete') return p.url;
    await sleep(150);
  }
  throw Object.assign(new Error(`${url} did not finish loading within ${timeoutMs / 1000}s (navigation ${r.navigation || 'started'})`), { code: 'ETIMEDOUT' });
}

export async function nav(s, context, url) {
  if (!url) throw Object.assign(new Error('Usage: browserctrl nav <tab> <url>'), { code: 'USAGE' });
  return { navigated: await navigate(s, context, url) };
}

export async function close(s, context) {
  await s.send('browsingContext.close', { context });
  return { closed: shortId(context) };
}

export async function focus(s, context) {
  await s.send('browsingContext.activate', { context });
  return { focused: shortId(context) };
}

export async function read(s, context, { maxText = 6000, all = false } = {}) {
  await waitForLoad(s, context, { timeoutMs: 10000 });
  return callPage(s, context, SNAPSHOT, { maxText, all });
}

export function formatRead(snap) {
  const lines = [snap.title || '(untitled)', snap.url];
  const above = snap.viewport ? (snap.scrollY / snap.viewport).toFixed(1) : '0';
  const below = snap.viewport ? Math.max(0, (snap.scrollHeight - snap.scrollY - snap.viewport) / snap.viewport).toFixed(1) : '0';
  lines.push(`scroll ${snap.scrollY}/${snap.scrollHeight} · ${above} screens above, ${below} below`);
  lines.push(`stats: ${snap.refs.length} interactive`, '');
  for (const r of snap.refs) {
    const extra = [...r.state, r.where ? `(${r.where})` : ''].filter(Boolean).join(' ');
    lines.push(` ${r.ref.padEnd(8)} ${r.role.padEnd(10)} ${r.name}${extra ? `   ${extra}` : ''}`);
  }
  lines.push('', '--- text ---', snap.text || '');
  return lines.join('\n');
}

export async function text(s, context) { return callPage(s, context, PAGE_TEXT); }
export async function html(s, context) { return callPage(s, context, PAGE_HTML); }

export async function evaluate(s, context, expression) {
  const r = await s.send('script.evaluate', { expression, target: { context }, awaitPromise: true, resultOwnership: 'none' });
  if (r.type === 'exception') throw new Error(`eval threw: ${r.exceptionDetails?.text || 'exception'}`);
  return deserialize(r.result);
}

export async function shot(s, context, { file, full = false } = {}) {
  const r = await s.send('browsingContext.captureScreenshot', { context, origin: full ? 'document' : 'viewport' });
  const target = file ? path.resolve(file) : path.join(os.tmpdir(), `browserctrl-shot-${Date.now()}.png`);
  const bytes = Buffer.from(r.data, 'base64');
  fs.writeFileSync(target, bytes);
  return { path: target, bytes: bytes.length };
}

/** A target from --ref/--selector/x,y or a positional ref_N/CSS word. */
export function targetOf(positional, flags) {
  const word = positional[2] !== undefined ? String(positional[2]) : '';
  if (flags.ref) return { ref: String(flags.ref) };
  if (flags.selector) return { selector: String(flags.selector) };
  if (flags.x !== undefined && flags.y !== undefined) return { x: Number(flags.x), y: Number(flags.y) };
  if (/^ref_\d+$/.test(word)) return { ref: word };
  if (word && /^[#.[]|^[a-z]+[#.[:]/i.test(word)) return { selector: word };
  return null;
}

async function locate(s, context, target, verb) {
  if (!target) throw Object.assign(new Error(`${verb} needs a target: a ref from read (ref_N), --selector <css>, or --x/--y`), { code: 'USAGE' });
  if (target.x !== undefined) return { x: target.x, y: target.y, found: true };
  const where = await callPage(s, context, LOCATE, target);
  if (!where.found) {
    throw Object.assign(new Error(target.ref ? `${target.ref} is not on the page any more; read it again for fresh refs` : `No element matches ${target.selector}`), { code: 'TARGET_NOT_FOUND' });
  }
  return where;
}

const pointer = actions => ({ type: 'pointer', id: 'browserctrl-mouse', parameters: { pointerType: 'mouse' }, actions });
const keys = actions => ({ type: 'key', id: 'browserctrl-keys', actions });

/**
 * After a click or key: watch briefly for a navigation to start (a new URL, or a document that
 * is loading), and if one does, wait for the new page. A redirect that starts later than the
 * watch window is for `wait --url`.
 */
export async function settle(s, context, before, { watchMs = 1000, loadMs = 15000, pollMs = 100 } = {}) {
  const watchUntil = Date.now() + watchMs;
  let last = null;
  while (Date.now() < watchUntil) {
    await sleep(pollMs);
    last = await callPage(s, context, PROBE, {}).catch(() => ({ ready: 'loading' }));
    if (last.ready !== 'complete' || (before && last.url && last.url !== before)) {
      const loadUntil = Date.now() + loadMs;
      while (Date.now() < loadUntil) {
        const p = await callPage(s, context, PROBE, {}).catch(() => null);
        if (p?.ready === 'complete' && (!before || p.url !== before || last.url === before)) return { url: p.url, ...(before && p.url !== before ? { navigated: true } : {}) };
        await sleep(150);
      }
      return { url: last.url, loading: true };
    }
  }
  return last?.url ? { url: last.url } : {};
}

export async function click(s, context, target, { button = 0, count = 1 } = {}) {
  const where = await locate(s, context, target, 'click');
  if (where.disabled) throw Object.assign(new Error('That element is disabled'), { code: 'DISABLED' });
  let before = null;
  try { before = (await callPage(s, context, PROBE, {})).url; } catch {}
  const presses = [];
  for (let i = 0; i < count; i++) presses.push({ type: 'pointerDown', button }, { type: 'pointerUp', button });
  await s.send('input.performActions', { context, actions: [pointer([{ type: 'pointerMove', x: where.x, y: where.y, origin: 'viewport' }, ...presses])] });
  await s.send('input.releaseActions', { context }).catch(() => {});
  return { clicked: target.ref || target.selector || `(${where.x}, ${where.y})`, ...(where.covered ? { warning: 'another element covered the target at its centre' } : {}), ...(await settle(s, context, before)) };
}

export async function hover(s, context, target) {
  const where = await locate(s, context, target, 'hover');
  await s.send('input.performActions', { context, actions: [pointer([{ type: 'pointerMove', x: where.x, y: where.y, origin: 'viewport' }])] });
  return { hovered: target.ref || target.selector || `(${where.x}, ${where.y})` };
}

/** Key actions that type text; "\n" presses Enter. */
export function typingActions(value) {
  const out = [];
  for (const ch of String(value)) {
    const v = ch === '\n' ? KEYS.enter : ch;
    out.push({ type: 'keyDown', value: v }, { type: 'keyUp', value: v });
  }
  return out;
}

export async function type(s, context, value, target = null) {
  if (target) await click(s, context, target);
  await s.send('input.performActions', { context, actions: [keys(typingActions(value))] });
  return { typed: String(value).length };
}

export async function fill(s, context, target, value) {
  const where = await locate(s, context, target, 'fill');
  if (where.tag === 'select') throw Object.assign(new Error('That is a <select>; use browserctrl select'), { code: 'USAGE' });
  await s.send('input.performActions', { context, actions: [pointer([{ type: 'pointerMove', x: where.x, y: where.y, origin: 'viewport' }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }])] });
  await callPage(s, context, SELECT_CONTENT, target.x !== undefined ? { selector: ':focus' } : target);
  await s.send('input.performActions', { context, actions: [keys([{ type: 'keyDown', value: KEYS.backspace }, { type: 'keyUp', value: KEYS.backspace }, ...typingActions(value)])] });
  await s.send('input.releaseActions', { context }).catch(() => {});
  const check = target.x !== undefined ? null : await callPage(s, context, SELECT_CONTENT, target).catch(() => null);
  return { filled: target.ref || target.selector || 'focused element', value: check?.value ?? String(value) };
}

/** "Enter", "Control+a", "Shift+Tab": modifiers held while the last key is pressed. */
export function keyActions(combo) {
  const parts = String(combo).split('+').map(p => p.trim()).filter(Boolean);
  if (!parts.length) throw Object.assign(new Error('Usage: browserctrl key <tab> <key>, e.g. Enter or Control+a'), { code: 'USAGE' });
  const code = p => KEYS[p.toLowerCase()] ?? (p.length === 1 ? p : null);
  const codes = parts.map(p => {
    const c = code(p);
    if (c === null) throw Object.assign(new Error(`Unknown key "${p}". Use a character or one of: ${Object.keys(KEYS).join(', ')}`), { code: 'USAGE' });
    return c;
  });
  const down = codes.map(v => ({ type: 'keyDown', value: v }));
  const up = [...codes].reverse().map(v => ({ type: 'keyUp', value: v }));
  return [...down, ...up];
}

export async function key(s, context, combo) {
  let before = null;
  try { before = (await callPage(s, context, PROBE, {})).url; } catch {}
  await s.send('input.performActions', { context, actions: [keys(keyActions(combo))] });
  await s.send('input.releaseActions', { context }).catch(() => {});
  return { pressed: combo, ...(await settle(s, context, before)) };
}

export async function select(s, context, target, option) {
  if (!target || target.x !== undefined) throw Object.assign(new Error('select needs a ref from read or --selector'), { code: 'USAGE' });
  if (option === undefined || option === '') throw Object.assign(new Error('select needs the option: browserctrl select <tab> <ref> <option> (or --label/--value)'), { code: 'USAGE' });
  const r = await callPage(s, context, CHOOSE_OPTION, { ...target, option });
  if (!r.found) throw Object.assign(new Error(`${target.ref || target.selector} is not on the page`), { code: 'TARGET_NOT_FOUND' });
  if (r.error === 'no option') throw new Error(`No option "${option}". Options: ${r.options.join(' | ')}`);
  if (r.error) throw new Error(`Cannot select: ${r.error}`);
  return { selected: r.chosen, value: r.value };
}

export async function scroll(s, context, { to, dy }) {
  const amount = to === 'up' ? -600 : to === 'down' ? 600 : Number(dy ?? 600);
  return callPage(s, context, SCROLL, { to, dy: amount });
}

/** Poll until every given condition holds. Resolves { met, ...last probe }. */
export async function wait(s, context, { text: t, url, selector, gone = false, timeoutMs = 15000, pollMs = 250 } = {}) {
  if (t === undefined && url === undefined && selector === undefined) {
    throw Object.assign(new Error('wait needs --text, --url or --selector'), { code: 'USAGE' });
  }
  const deadline = Date.now() + timeoutMs;
  let last = {};
  while (true) {
    try {
      last = await callPage(s, context, PROBE, { text: t, url, selector, gone });
      const met = (t === undefined || last.text) && (url === undefined || last.urlMatch) && (selector === undefined || last.selector);
      if (met) return { met: true, url: last.url };
    } catch {}
    if (Date.now() >= deadline) return { met: false, url: last.url };
    await sleep(pollMs);
  }
}

export async function status(s, port) {
  const list = await topContexts(s);
  return {
    available: true, protocol: 'webdriver-bidi', port,
    browser: s.capabilities.browserName, version: s.capabilities.browserVersion, tabs: list.length,
  };
}

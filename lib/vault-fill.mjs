// Protected field fill (contract v2): one vault value into one input, then a tainted tab.
// The value travels only over private stdio/IPC and Input.insertText. It is never part of a
// Runtime.evaluate expression, a log line, a marker file or a reply.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { BROWSERS, SOCK, runtimePath, agentId } from './env.mjs';
import { validateVaultRecovery } from './vault-entry.mjs';
import { page } from './page/index.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIELD_KINDS = { username: ['text', 'email', 'tel'], password: ['password'], totp: ['text', 'tel', 'number', 'password'] };
const fail = (code, attempted = false) => ({ status: attempted ? 'indeterminate' : 'failed', verification: 'not_verified', input_attempted: attempted, action_may_have_run: false, code });
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));

export function validateVaultFill(r, now = Date.now() / 1000) {
  if (!exact(r, ['version', 'request_id', 'deadline', 'destination', 'field', 'value']) || r.version !== 2 || typeof r.request_id !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(r.request_id) ||
      !Number.isFinite(r.deadline) || r.deadline <= now || r.deadline > now + 120) throw Error('invalid_request');
  const d = r.destination;
  if (!exact(d, ['browser', 'origins', 'tab_id', 'element']) || typeof d.browser !== 'string' || !Object.hasOwn(BROWSERS, d.browser) ||
      typeof d.tab_id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(d.tab_id) || typeof d.element !== 'string' || !d.element.trim() || d.element.length > 512) throw Error('invalid_destination');
  if (!Array.isArray(d.origins) || d.origins.length < 1 || d.origins.length > 8 || new Set(d.origins).size !== d.origins.length) throw Error('invalid_destination');
  for (const origin of d.origins) {
    let u; try { u = new URL(origin); } catch { throw Error('invalid_destination'); }
    if (typeof origin !== 'string' || u.protocol !== 'https:' || u.origin !== origin || u.username || u.password) throw Error('invalid_destination');
  }
  if (!Object.hasOwn(FIELD_KINDS, r.field) || typeof r.value !== 'string' || !r.value || r.value.length > 8192) throw Error('invalid_fields');
  return r;
}

// `@e12`, `e12` and `ref_3` use the snapshot refs ordinary commands use; anything else is CSS.
export function elementSpec(element) {
  const m = /^@?(ref_\d+|e\d+)$/.exec(element.trim());
  return m ? { ref: m[1] } : { selector: element };
}

// ------------------------------------------------------------------ redaction --

// The forms a value takes in strings a page or URL hands back: raw, URI- and form-encoded,
// JSON-escaped and HTML-entity encoded (named, decimal and hex).
export function secretForms(value) {
  const forms = new Set([value, encodeURIComponent(value), encodeURI(value), encodeURIComponent(value).replace(/%20/g, '+'), JSON.stringify(value).slice(1, -1)]);
  for (const f of [...forms]) forms.add(f.replace(/%[0-9A-F]{2}/g, h => h.toLowerCase()));
  const named = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  for (const q of ['"', '&quot;', '&#34;', '&#x22;']) for (const a of ["'", '&#39;', '&#x27;', '&apos;']) forms.add(named.replaceAll('"', q).replaceAll("'", a));
  const chars = [...value];
  forms.add(chars.map(c => `&#${c.codePointAt(0)};`).join(''));
  forms.add(chars.map(c => `&#x${c.codePointAt(0).toString(16)};`).join(''));
  return [...forms].filter(Boolean).sort((a, b) => b.length - a.length);
}

export function createRedactor(values) {
  const forms = [...new Set([...values].flatMap(secretForms))].sort((a, b) => b.length - a.length);
  const text = s => { for (const f of forms) if (s.includes(f)) s = s.split(f).join('[redacted]'); return s; };
  const walk = v => typeof v === 'string' ? text(v)
    : Array.isArray(v) ? v.map(walk)
    : object(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [text(k), walk(x)]))
    : v;
  return forms.length ? walk : v => v;
}

export function containsSecret(s, values) {
  if (typeof s !== 'string' || !s) return false;
  let decoded = s;
  try { decoded = decodeURIComponent(s.split('+').join(' ')); } catch {}
  return [...values].some(v => decoded.includes(v) || secretForms(v).some(f => s.includes(f)));
}

// ------------------------------------------------------------ page functions --
// These run in browserctrl's isolated vault world with `this` bound to the element. They
// receive origins and the field name, never the value.

const CHECK = `function (a) {
  const el = this, kinds = ${JSON.stringify(FIELD_KINDS)};
  const check = () => {
    const view = el.ownerDocument && el.ownerDocument.defaultView;
    if (!el.isConnected || !view || window !== window.top) return 'element_not_found';
    for (let w = view; w !== window; w = w.parent) { if (!w.frameElement || w.parent === w) return 'element_not_found'; }
    if (!a.origins.includes(location.origin) || !a.origins.includes(view.location.origin)) return 'origin_mismatch';
    if (el.localName !== 'input' || el.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !kinds[a.field].includes(el.type)) return 'element_kind_mismatch';
    if (el.disabled || el.matches(':disabled') || el.readOnly) return 'element_not_editable';
    const r = el.getBoundingClientRect(), s = view.getComputedStyle(el);
    if (!el.getClientRects().length || !r.width || !r.height || s.visibility === 'hidden' || s.display === 'none') return 'element_not_visible';
    return null;
  };
  const deepActive = () => {
    let e = document.activeElement;
    for (let i = 0; e && e !== el && i < 32; i++) e = (e.shadowRoot && e.shadowRoot.activeElement) || (e.contentDocument && e.contentDocument.activeElement) || null;
    return e === el;
  };
  try {
    let code = check();
    if (code) return { code };
    if (a.focus) {
      el.focus();
      if (!deepActive()) return { code: 'focus_failed' };
      code = check();
      if (code) return { code };
    }
    if (a.verify) return { ok: deepActive(), length: el.value.length };
    return { ok: true };
  } catch (e) { return { code: 'element_check_failed' }; }
}`;

const BY_SELECTOR = selector => `(() => { try { const n = document.querySelectorAll(${JSON.stringify(selector)}); return n.length === 1 ? n[0] : n.length ? 'ambiguous' : 'no_match'; } catch { return 'invalid_selector'; } })()`;

// Everything the v1 scan looks at (URL, text, attributes, input values, open shadow roots,
// templates), returned to the daemon, which looks for the values itself.
const DOCUMENT_STRINGS = `(() => { try {
  if (document.readyState !== 'complete' || document.querySelector('iframe,frame')) return { ok: false };
  const out = [location.href]; let size = 0;
  const add = v => { if (typeof v === 'string' && v) { out.push(v); size += v.length; } };
  const scan = root => {
    add(root.textContent); add(root.documentElement && root.documentElement.textContent);
    for (const e of root.querySelectorAll('*')) {
      for (const at of e.attributes) add(at.value);
      if (typeof e.value === 'string') add(e.value);
      if (e.shadowRoot) scan(e.shadowRoot);
      if (e instanceof HTMLTemplateElement) scan(e.content);
      if (size > 8e6) throw 0;
    }
  };
  scan(document);
  return { ok: true, strings: out };
} catch { return { ok: false }; } })()`;

// ----------------------------------------------------------------- the gate --

export const TAINTED = 'tab_tainted: a protected vault field was filled in this tab. Screenshots, eval, raw CDP, ' +
  'recording and console/network capture stay off until the tab closes or navigates to a page that shows no secret. ' +
  'Navigation, clicks, keys, scrolling and reads (text, read, items, do) still work, with filled values redacted.';
const ORPHANED = 'tab_tainted: this tab held a protected vault fill when the daemon restarted, so every operation except ' +
  'closing it is refused. Ask the owner to close the tab, then run browserctrl-vault --recover with the same agent id.';
// Methods that capture pages or run caller code outside browserctrl's structured reads.
const CAPTURE = /^(Page\.(captureScreenshot|captureSnapshot|startScreencast|screencastFrameAck|printToPDF|addScriptToEvaluateOnNewDocument)|Runtime\.(addBinding|compileScript|runScript)|Network\.(getResponseBody|getRequestPostData|takeResponseBodyForInterceptionAsStream|getResponseBodyForInterception)|Fetch\.|Debugger\.|Profiler\.|HeapProfiler\.|Tracing\.|LayerTree\.|Cast\.|HeadlessExperimental\.|Input\.(startScreencast))/;
const TARGET_RAW = new Set(['Target.attachToTarget', 'Target.sendMessageToTarget', 'Target.exposeDevToolsProtocol', 'Target.detachFromTarget']);
const BROWSER_CAPTURE = /^(Tracing\.|Target\.(attachToBrowserTarget|setAutoAttach|autoAttachRelated|sendMessageToTarget|exposeDevToolsProtocol))/;

// The tab an IPC request acts on, if it names one.
export const targetOf = req => req.op === 'browser' ? req.params?.targetId : req.op === 'vault-fill' ? req.request?.destination?.tab_id
  : ['cdp', 'events', 'render', 'detach'].includes(req.op) ? req.targetId : null;

export function createFillGate(port, { recording, send, sessionFor, withInput, onLift = () => {}, now = () => Date.now() / 1000 }) {
  const marker = runtimePath(`vault-taint-${port}.json`);
  const journal = runtimePath(`vault-requests-${port}.json`);
  const taints = new Map(); // targetId -> {values, scan, loaderId, scanned, scannedAt}
  let saved = { version: 2, tabs: {} };
  try { const m = JSON.parse(fs.readFileSync(marker, 'utf8')); if (m.version === 2 && object(m.tabs)) saved = m; } catch {}
  // Tabs marked by an earlier daemon: their values are gone, so nothing can be redacted.
  const orphans = new Set(Object.keys(saved.tabs));
  // Tabs opened through this daemon: their history is browserctrl's to reset. Kept
  // values-free on disk so a restart still knows them.
  const createdFile = runtimePath(`vault-created-${port}.json`);
  let created = new Set();
  try { const c = JSON.parse(fs.readFileSync(createdFile, 'utf8')); if (Array.isArray(c.targets)) created = new Set(c.targets.filter(t => typeof t === 'string')); } catch {}
  const saveCreated = () => {
    try { const tmp = `${createdFile}.tmp`; fs.writeFileSync(tmp, JSON.stringify({ version: 1, targets: [...created].slice(-5000) }), { mode: 0o600 }); fs.renameSync(tmp, createdFile); } catch {}
  };
  let redact = v => v;
  const save = () => {
    if (!Object.keys(saved.tabs).length) { try { fs.unlinkSync(marker); } catch (e) { if (e.code !== 'ENOENT') throw e; } return; }
    const tmp = `${marker}.tmp`; fs.writeFileSync(tmp, JSON.stringify(saved), { mode: 0o600 }); fs.renameSync(tmp, marker);
  };
  const rebuild = () => { redact = createRedactor([...taints.values()].flatMap(t => [...t.values])); };
  const lift = targetId => {
    taints.delete(targetId); delete saved.tabs[targetId]; save(); rebuild(); onLift(targetId);
  };

  function taint(targetId, request, owner, loaderId) {
    const t = taints.get(targetId) || { values: new Set(), scan: new Set() };
    t.values.add(request.value);
    if (request.field !== 'username') t.scan.add(request.value);
    t.loaderId = loaderId; t.scanned = null;
    const prior = saved.tabs[targetId];
    saved.tabs[targetId] = { browser: request.destination.browser, owner, origins: [...new Set([...(prior?.origins || []), ...request.destination.origins])] };
    // Durable before the value reaches the page.
    save();
    taints.set(targetId, t); rebuild();
  }

  function useRequestId(id) {
    let seen; try { seen = JSON.parse(fs.readFileSync(journal, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') return 'journal_unavailable'; seen = {}; }
    const key = crypto.createHash('sha256').update(id).digest('hex');
    if (seen[key]) return 'request_already_used';
    if (Object.keys(seen).length >= 10000) return 'journal_full';
    seen[key] = true;
    const tmp = `${journal}.tmp`; fs.writeFileSync(tmp, JSON.stringify(seen), { mode: 0o600 }); fs.renameSync(tmp, journal);
    return null;
  }

  // Resolve the element to an object in the isolated vault world of the top frame.
  async function resolve(sid, frameId, element) {
    const { executionContextId } = await send('Page.createIsolatedWorld', { frameId, worldName: 'browserctrl-vault' }, sid, 5000);
    const spec = elementSpec(element);
    if (spec.selector) {
      const r = await send('Runtime.evaluate', { expression: BY_SELECTOR(spec.selector), contextId: executionContextId, returnByValue: false }, sid, 5000);
      return r.result?.subtype === 'node' ? { objectId: r.result.objectId } : { code: 'element_not_found' };
    }
    // Refs live in the page's own world, where snapshots put them.
    const r = await send('Runtime.evaluate', { expression: page('ref-lookup', { ref: spec.ref, token: null }), returnByValue: false }, sid, 5000);
    if (r.result?.subtype !== 'node') return { code: 'element_not_found' };
    const { node } = await send('DOM.describeNode', { objectId: r.result.objectId }, sid, 5000);
    await send('Runtime.releaseObject', { objectId: r.result.objectId }, sid, 5000).catch(() => {});
    const { object: o } = await send('DOM.resolveNode', { backendNodeId: node.backendNodeId, executionContextId }, sid, 5000).catch(() => ({}));
    return o?.objectId ? { objectId: o.objectId } : { code: 'element_not_found' };
  }
  const call = (sid, objectId, args) => send('Runtime.callFunctionOn', { functionDeclaration: CHECK, objectId, arguments: [{ value: args }], returnByValue: true }, sid, 5000)
    .then(r => r.exceptionDetails ? { code: 'element_check_failed' } : (r.result?.value || { code: 'element_check_failed' }));

  return {
    tainted: targetId => taints.has(targetId) || orphans.has(targetId),
    active: () => taints.size > 0,
    taintedCount: () => taints.size + orphans.size,
    redact: v => redact(v),
    hasOrphan: targetId => orphans.has(targetId),

    targetOf,
    // The one place that decides whether an operation may touch a tainted tab.
    refusal(req) {
      const target = targetOf(req);
      if (req.op === 'browser' && taints.size && BROWSER_CAPTURE.test(String(req.method))) return TAINTED;
      if (!target) return null;
      // A fill answers with its own fixed code.
      if (req.op === 'vault-fill') return null;
      if (orphans.has(target)) return req.op === 'browser' && req.method === 'Target.closeTarget' ? null : ORPHANED;
      if (!taints.has(target)) return null;
      if (req.op === 'cdp' && (!req.mediated || req.caller || CAPTURE.test(String(req.method)))) return TAINTED;
      if (req.op === 'events' && req.limit !== 0) return TAINTED;
      if (req.op === 'browser' && TARGET_RAW.has(req.method)) return TAINTED;
      return null;
    },

    // A cross-document navigation to a page that shows no password or code lifts the taint,
    // after the tab's history is reset so Back cannot restore the filled form.
    async settle(targetId) {
      const t = taints.get(targetId);
      if (!t) return;
      try {
        const sid = await sessionFor(targetId);
        const { frameTree } = await send('Page.getFrameTree', {}, sid, 5000);
        const frame = frameTree.frame;
        if (!frame.loaderId || frame.loaderId === t.loaderId || frameTree.childFrames?.length) return;
        if (t.scanned === frame.loaderId && Date.now() - t.scannedAt < 2000) return;
        t.scanned = frame.loaderId; t.scannedAt = Date.now();
        if (containsSecret(frame.url, t.scan)) return;
        if (t.scan.size) {
          const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'browserctrl-vault' }, sid, 5000);
          const r = await send('Runtime.evaluate', { expression: DOCUMENT_STRINGS, contextId: executionContextId, returnByValue: true }, sid, 10000);
          const v = r.result?.value;
          if (r.exceptionDetails || v?.ok !== true || !Array.isArray(v.strings) || v.strings.some(s => containsSecret(s, t.scan))) return;
        }
        const current = await send('Page.getFrameTree', {}, sid, 5000);
        if (current.frameTree.frame.loaderId !== frame.loaderId || !taints.has(targetId)) return;
        await send('Page.resetNavigationHistory', {}, sid, 5000);
        const history = await send('Page.getNavigationHistory', {}, sid, 5000);
        if (history.entries?.length !== 1 || history.currentIndex !== 0 || history.entries[0].url !== frame.url) return;
        if (taints.get(targetId) === t && t.loaderId !== frame.loaderId) lift(targetId);
      } catch { /* An unverified lift keeps the taint. */ }
    },

    closed(targetId) {
      if (taints.has(targetId)) lift(targetId);
      if (created.delete(targetId)) saveCreated();
    },
    created(targetId) { if (typeof targetId === 'string' && !created.has(targetId)) { created.add(targetId); saveCreated(); } },

    async recover(request, owner, verifyAbsent) {
      try { validateVaultRecovery(request); } catch { return fail('invalid_request'); }
      const d = request.destination, entry = saved.tabs[d.tab_id];
      if (!orphans.has(d.tab_id) || !entry) return fail('recovery_unavailable');
      if (entry.browser !== d.browser || entry.owner !== owner || !entry.origins.includes(d.origin)) return fail('recovery_mismatch');
      try { if (!(await verifyAbsent(d.tab_id))) return fail('target_still_present'); } catch { return fail('recovery_unverified'); }
      orphans.delete(d.tab_id); delete saved.tabs[d.tab_id]; save();
      return { status: 'completed', verification: 'not_verified', input_attempted: false, action_may_have_run: false, code: 'closed_target_recovered' };
    },

    // `authorize(targetId)` holds the tab for this caller or returns a refusal code.
    async run(request, owner, authorize = () => null) {
      try { validateVaultFill(request, now()); } catch { return fail('invalid_request'); }
      const d = request.destination, targetId = d.tab_id;
      if (orphans.has(targetId)) return fail('tab_tainted');
      if (recording()) return fail('capture_or_action_active');
      let targetInfos;
      try { ({ targetInfos } = await send('Target.getTargets', {}, undefined, 5000)); } catch { return fail('browser_unavailable'); }
      if (!targetInfos.some(t => t.targetId === targetId && t.type === 'page')) return fail('tab_not_found');
      // Lifting the taint resets the tab's whole history. The first fill therefore needs a
      // tab browserctrl opened, or one with no earlier history to lose.
      if (!taints.has(targetId) && !created.has(targetId)) {
        try {
          const history = await send('Page.getNavigationHistory', {}, await sessionFor(targetId), 5000);
          if (history.entries?.length !== 1) return fail('tab_not_dedicated');
        } catch { return fail('tab_not_dedicated'); }
      }
      let denied, used;
      try { denied = authorize(targetId); } catch { denied = 'tab_not_owned'; }
      if (denied) return fail(denied);
      try { used = useRequestId(request.request_id); } catch { used = 'journal_unavailable'; }
      if (used) return fail(used);
      let attempted = false, objectId, sid;
      try {
        sid = await sessionFor(targetId);
        const { frameTree } = await send('Page.getFrameTree', {}, sid, 5000);
        let top; try { top = new URL(frameTree.frame.url).origin; } catch { top = null; }
        if (!d.origins.includes(top)) return fail('origin_mismatch');
        const found = await resolve(sid, frameTree.frame.id, d.element);
        if (found.code) return fail(found.code);
        objectId = found.objectId;
        const args = { origins: d.origins, field: request.field };
        const checked = await call(sid, objectId, args);
        if (!checked.ok) return fail(checked.code || 'element_check_failed');
        return await withInput(targetId, sid, async () => {
          if (now() >= request.deadline) return fail('deadline_passed');
          const focused = await call(sid, objectId, { ...args, focus: true });
          if (!focused.ok) return fail(focused.code || 'element_check_failed');
          taint(targetId, request, owner, frameTree.frame.loaderId);
          attempted = true;
          await send('Input.insertText', { text: request.value }, sid, 10000);
          const after = await call(sid, objectId, { ...args, verify: true });
          return after.ok && after.length === request.value.length
            ? { status: 'completed', verification: 'filled', input_attempted: true, action_may_have_run: false }
            : fail(after.code || 'fill_unverified', true);
        });
      } catch {
        return fail(attempted ? 'fill_outcome_uncertain' : 'fill_failed', attempted);
      } finally {
        if (objectId) send('Runtime.releaseObject', { objectId }, sid, 5000).catch(() => {});
      }
    },
  };
}

// ------------------------------------------------------------------- driver --

// The listener on the daemon socket, found by the OS, must run this install's daemon-run.mjs.
export async function daemonTrusted(sock, port, { root = ROOT, exec = run } = {}) {
  if (process.platform === 'win32') return false;
  let expected;
  try { expected = fs.realpathSync(path.join(root, 'lib', 'daemon-run.mjs')); } catch { return false; }
  let pids;
  try {
    const { stdout } = await exec(fs.existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof', ['-t', '--', sock], { timeout: 5000 });
    pids = [...new Set(stdout.split('\n').map(s => s.trim()).filter(Boolean))].map(Number).filter(pid => pid !== process.pid);
  } catch { return false; }
  if (!pids.length || pids.some(pid => !Number.isInteger(pid) || pid <= 1)) return false;
  for (const pid of pids) {
    try {
      if (fs.existsSync(`/proc/${pid}/cmdline`)) {
        const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
        if (argv.length !== 3 || fs.realpathSync(argv[1]) !== expected || argv[2] !== String(port)) return false;
      } else {
        const { stdout } = await exec('/bin/ps', ['-ww', '-o', 'command=', '-p', String(pid)], { timeout: 5000 });
        if (!stdout.trim().endsWith(` ${expected} ${port}`)) return false;
      }
    } catch { return false; }
  }
  return true;
}

// `port` and `trusted` are for tests; the installed driver derives the port from the browser.
export async function submitVaultFill(request, { trusted = daemonTrusted, port } = {}) {
  try { validateVaultFill(request); } catch { return fail('invalid_request'); }
  port ??= BROWSERS[request.destination.browser].port;
  const sock = SOCK(port);
  // No ensureDaemon(): a missing or old daemon is never started or replaced from here.
  return new Promise(resolve => {
    const socket = net.connect(sock);
    let buf = '', sent = false, finished = false;
    const done = result => { if (finished) return; finished = true; socket.destroy(); resolve(result); };
    socket.setTimeout(Math.max(5000, Math.min(45000, (request.deadline - Date.now() / 1000) * 1000 + 5000)), () => done(fail('adapter_timeout', sent)));
    socket.on('connect', async () => {
      let ok = false;
      try { ok = await trusted(sock, port); } catch {}
      if (finished) return;
      if (!ok) return done(fail('daemon_untrusted'));
      sent = true;
      socket.write(JSON.stringify({ reqId: 1, op: 'vault-fill', owner: agentId(), label: 'vault-fill', request }) + '\n');
    });
    socket.on('data', chunk => {
      buf += chunk;
      if (buf.length > 8192) return done(fail('adapter_response_invalid', sent));
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        const row = JSON.parse(buf.slice(0, nl)), v = row.result;
        // The daemon answers with an error only before a fill starts (an old daemon, a busy or blocked one).
        if (row.error !== undefined && v === undefined) return done(fail('daemon_refused'));
        const keys = object(v) ? Object.keys(v) : [];
        if (!object(v) || !keys.every(k => ['status', 'verification', 'input_attempted', 'action_may_have_run', 'code'].includes(k)) ||
            !['completed', 'failed', 'indeterminate'].includes(v.status) || !['filled', 'not_verified'].includes(v.verification) ||
            typeof v.input_attempted !== 'boolean' || v.action_may_have_run !== false || (v.code !== undefined && !/^[a-z_]{1,64}$/.test(v.code))) return done(fail('adapter_unavailable', sent));
        done(v);
      } catch { done(fail('adapter_response_invalid', sent)); }
    });
    socket.on('error', () => done(fail('adapter_unavailable', sent)));
    socket.on('end', () => done(fail('adapter_disconnected', sent)));
  });
}

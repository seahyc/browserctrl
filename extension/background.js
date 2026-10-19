// The extension's whole job is to be the transport the injected path cannot
// be: it owns the loopback call, so page CSP and Chromium's Local Network
// Access rules never come into it, and it works in tabs where no debug port
// is on.
//
// It deliberately holds no annotation logic. annotate.js is the same file the
// daemon injects.
//
// How it authenticates: the bridge refuses anything without its token, and
// trusts this extension by its Origin header (chrome-extension://<id>), which a
// web page cannot set. The id is fixed by the `key` in manifest.json. So these
// fetches carry no secret; the one place a token is needed is opening the tray
// in a tab (a navigation has no Origin), and openTray() asks for it.
const BRIDGE = 'http://127.0.0.1:17222';
const OUTBOX_KEY = 'cdp-annotation-outbox';

async function openTray() {
  try {
    const { token } = await (await fetch(`${BRIDGE}/api/token`)).json();
    await chrome.tabs.create({ url: `${BRIDGE}/tray?t=${token}` });
  } catch {
    await chrome.notifications.create(`cdp-tray-${Date.now()}`, {
      type: 'basic', iconUrl: 'icons/icon48.png', title: 'Could not open the tray', message: 'Could not reach the cdp bridge. Run `browserctrl bridge`.',
    }).catch(() => {});
  }
}

async function post(path, body) {
  const res = await fetch(BRIDGE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// A page can be closed immediately after its note is saved, and the bridge can
// be restarting at precisely that moment. Keep the handoff in extension
// storage until the bridge confirms it, rather than showing a false success.
async function outbox() {
  return (await chrome.storage.local.get(OUTBOX_KEY))[OUTBOX_KEY] || [];
}

async function queueAnnotation(payload) {
  const queued = await outbox();
  queued.push({ id: crypto.randomUUID(), payload, createdAt: Date.now() });
  await chrome.storage.local.set({ [OUTBOX_KEY]: queued });
}

async function flushOutbox() {
  const queued = await outbox();
  if (!queued.length) return { sent: 0, waiting: 0 };
  const waiting = [];
  let sent = 0;
  for (const item of queued) {
    try {
      await post('/annotations', item.payload);
      sent += 1;
    } catch {
      waiting.push(item);
    }
  }
  await chrome.storage.local.set({ [OUTBOX_KEY]: waiting });
  return { sent, waiting: waiting.length };
}

chrome.runtime.onMessage.addListener((envelope, sender, sendResponse) => {
  if (!envelope) return;

  // The content script cannot call loopback itself on an HTTPS page, so every
  // read goes through here too, not just writes.
  if (envelope.kind === 'pins-request' || envelope.kind === 'resolve') {
    (async () => {
      try {
        if (envelope.kind === 'resolve') {
          await fetch(`${BRIDGE}/api/annotations/${envelope.id}`, { method: 'DELETE' });
        }
        const pins = await (await fetch(`${BRIDGE}/api/annotations?url=${encodeURIComponent(envelope.url)}`)).json();
        const live = await (await fetch(`${BRIDGE}/api/sessions`)).json();
        sendResponse({ pins, sessions: live });
      } catch (e) {
        sendResponse({ pins: [], sessions: [], error: e.message });
      }
    })();
    return true;
  }

  if (envelope.kind !== 'annotation') return;
  const payload = { ...envelope.payload, source: 'extension' };
  if (sender.tab) payload.page = { ...(payload.page || {}), url: sender.tab.url, title: sender.tab.title };
  (async () => {
    try {
      const row = await post('/annotations', payload);
      sendResponse({ ok: true, id: row.id });
    } catch (err) {
      await queueAnnotation(payload);
      sendResponse({ ok: false, queued: true, error: err.message });
    }
  })();
  return true; // keep the channel open for the async reply
});

async function markTab(tab, note = null) {
  // The bridge resolves which debuggable browser this tab belongs to; the
  // extension only knows its own tab id, which is not a CDP target id.
  return post('/api/marks/by-url', { url: tab.url, title: tab.title, note });
}

async function toggleAnnotate(tab) {
  try {
    await chrome.tabs.sendMessage(tab.id, { kind: 'command', command: 'toggle-annotate' });
    return { ok: true };
  } catch {
    await chrome.action.setBadgeText({ text: '—', tabId: tab.id });
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }), 1500);
    const error = 'This page cannot be annotated. Switch to a normal website; browser pages, PDFs, and the Web Store are protected.';
    await chrome.notifications.create(`cdp-annotate-${Date.now()}`, {
      type: 'basic', iconUrl: 'icons/icon48.png', title: 'Cannot annotate this page', message: error,
    }).catch(() => {});
    return { ok: false, error };
  }
}

async function handTab(tab) {
  try {
    await markTab(tab);
  } catch {
    try {
      await chrome.tabs.sendMessage(tab.id, {
        kind: 'command', command: 'toast', text: 'Could not reach the cdp bridge. Your handoff was not sent.',
      });
    } catch {}
    return { ok: false, error: 'Could not reach the cdp bridge.' };
  }
  try {
    await chrome.tabs.sendMessage(tab.id, {
      kind: 'command', command: 'toast', text: 'This tab is handed to the agent. In Codex, send: review my browser handoff',
    });
  } catch {}
  await chrome.action.setBadgeText({ text: '✓', tabId: tab.id });
  setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }), 4000);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.kind || !['toggle-active-annotate', 'hand-active-tab'].includes(message.kind)) return;
  (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return sendResponse({ ok: false, error: 'No active tab.' });
    sendResponse(message.kind === 'toggle-active-annotate' ? await toggleAnnotate(tab) : await handTab(tab));
  })();
  return true;
});

// The toolbar is the everyday path: click it, point at an element, write the
// note. Whole-tab handoff is useful but rare, so it belongs in the context
// menu instead of stealing half of the primary UI.
chrome.action.onClicked.addListener(async tab => {
  if (tab) await toggleAnnotate(tab);
});

function installMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'cdp-hand-tab', title: 'Hand this tab to the agent', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'cdp-open-tray', title: 'Manage handed-off tabs…', contexts: ['action'] });
  });
}
chrome.runtime.onInstalled.addListener(installMenus);
installMenus();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;
  if (info.menuItemId === 'cdp-hand-tab') await handTab(tab);
  if (info.menuItemId === 'cdp-open-tray') await openTray();
});

chrome.commands.onCommand.addListener(async command => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (command === 'toggle-annotate') {
    await toggleAnnotate(tab);
  }
  if (command === 'mark-tab') await handTab(tab);
});

// Badge the toolbar with the number of annotations still waiting, so the
// human can see the queue is non-empty without asking the agent.
async function refreshBadge() {
  try {
    const rows = await (await fetch(`${BRIDGE}/api/annotations`)).json();
    const n = Array.isArray(rows) ? rows.length : 0;
    await chrome.action.setBadgeText({ text: n ? String(n) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#2f6feb' });
  } catch {
    await chrome.action.setBadgeText({ text: '' });
  }
}
chrome.alarms?.create('cdp-badge', { periodInMinutes: 0.25 });
chrome.alarms?.onAlarm.addListener(a => {
  if (a.name === 'cdp-badge') {
    refreshBadge();
    flushOutbox();
  }
});
flushOutbox().then(refreshBadge);

// ---------------------------------------------------------------------------
// Agent browser control
// ---------------------------------------------------------------------------
// Everything above is the human -> agent handoff path (annotations, marks).
// Everything below is the reverse: it lets an agent drive browser-level
// chrome.* APIs that the DevTools Protocol simply does not expose — tab
// groups, bookmarks, history, downloads, sessions, reading list, and the tab
// operations CDP lacks (pin, mute, duplicate, move, discard, zoom).
//
// There is deliberately NO message protocol here. The agent attaches CDP to
// this service worker and calls Runtime.evaluate with any chrome.* expression.
// Whatever the manifest grants, the agent can call — so this file never has to
// keep an RPC schema in sync with the API surface.
//
// MV3 terminates an idle worker after ~30s, at which point it disappears from
// /json/list and an agent's attach looks flaky. The heartbeat below keeps it
// attachable; chrome.alarms is the only supported keep-warm in MV3.

chrome.alarms?.create('cdp-agent-heartbeat', { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm.addListener(a => {
  if (a.name === 'cdp-agent-heartbeat') globalThis.__cdpAgentLastBeat = Date.now();
});

// Stable marker so the CLI can find THIS worker among every extension service
// worker in the browser, without hardcoding an extension id (which changes
// with the unpacked-load path).
globalThis.__cdpAgentBrowser = { version: chrome.runtime.getManifest().version, ready: true };

// Convenience wrappers for sequences that are tedious to hand-write each time.
// Reachable as `await __cdpAgent.<fn>(...)` via Runtime.evaluate.
globalThis.__cdpAgent = {
  /** Group tabs whose URL contains any of `patterns` into one named group. */
  async groupByUrl(patterns, { title = 'agent', color = 'blue', collapsed = false } = {}) {
    const all = await chrome.tabs.query({});
    const ids = all.filter(t => patterns.some(p => (t.url || '').includes(p))).map(t => t.id);
    if (!ids.length) return { grouped: 0, missing: patterns };
    const groupId = await chrome.tabs.group({ tabIds: ids });
    await chrome.tabGroups.update(groupId, { title, color, collapsed });
    return { grouped: ids.length, groupId, title, missing: patterns.filter(p => !all.some(t => (t.url || '').includes(p))) };
  },

  /** Remove matching tabs from their current groups without closing them. */
  async ungroupByUrl(patterns) {
    const all = await chrome.tabs.query({});
    const ids = all.filter(t => t.groupId > -1 && patterns.some(p => (t.url || '').includes(p))).map(t => t.id);
    if (ids.length) await chrome.tabs.ungroup(ids);
    return { ungrouped: ids.length };
  },

  /** Readable overview of every tab, annotated with its group. */
  async outline() {
    const [tabs, groups] = await Promise.all([chrome.tabs.query({}), chrome.tabGroups.query({})]);
    const byId = Object.fromEntries(groups.map(g => [g.id, g]));
    return tabs.map(t => ({
      id: t.id, title: t.title, url: t.url, pinned: t.pinned,
      muted: !!t.mutedInfo?.muted, discarded: t.discarded,
      group: t.groupId > -1 ? (byId[t.groupId]?.title ?? String(t.groupId)) : null,
    }));
  },

  /** Restore the most recently closed tab or window. */
  async undoClose() {
    const [recent] = await chrome.sessions.getRecentlyClosed({ maxResults: 1 });
    if (!recent) return { restored: null };
    await chrome.sessions.restore(recent.sessionId);
    return { restored: recent.tab?.url ?? `${recent.window?.tabs?.length} tabs` };
  },
};

// Generic invoker: reach any granted chrome.* API without this file or the CLI
// needing to know it exists. `path` is dotted from the chrome namespace, e.g.
// "tabs.update", "bookmarks.search", "downloads.pause", "tabGroups.move".
globalThis.__cdpAgent.api = async function (path, args = []) {
  const parts = path.replace(/^chrome\./, '').split('.');
  let ctx = chrome;
  for (const part of parts.slice(0, -1)) {
    ctx = ctx?.[part];
    if (!ctx) throw new Error(`no such chrome namespace: ${parts.slice(0, -1).join('.')}`);
  }
  const fnName = parts[parts.length - 1];
  const fn = ctx?.[fnName];
  if (typeof fn !== 'function') throw new Error(`chrome.${path} is not a function (permission missing?)`);
  return await fn.apply(ctx, args);
};

// What is actually reachable, given what the manifest granted. Saves guessing
// whether a failure is a typo or a missing permission.
globalThis.__cdpAgent.apis = function () {
  const out = {};
  for (const ns of Object.keys(chrome)) {
    const v = chrome[ns];
    if (!v || typeof v !== 'object') continue;
    const fns = Object.keys(v).filter(k => typeof v[k] === 'function');
    if (fns.length) out[ns] = fns.sort();
  }
  return out;
};

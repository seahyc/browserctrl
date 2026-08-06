// The extension's whole job is to be the transport the injected path cannot
// be: it owns the loopback call, so page CSP and Chromium's Local Network
// Access rules never come into it, and it works in tabs where no debug port
// is on.
//
// It deliberately holds no annotation logic. annotate.js is the same file the
// daemon injects.
const BRIDGE = 'http://127.0.0.1:17222';

async function post(path, body) {
  const res = await fetch(BRIDGE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
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
  post('/annotations', payload)
    .then(row => sendResponse({ ok: true, id: row.id }))
    .catch(err => sendResponse({ ok: false, error: err.message }));
  return true; // keep the channel open for the async reply
});

async function markTab(tab, note = null) {
  // The bridge resolves which debuggable browser this tab belongs to; the
  // extension only knows its own tab id, which is not a CDP target id.
  return post('/api/marks/by-url', { url: tab.url, title: tab.title, note });
}

chrome.commands.onCommand.addListener(async command => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (command === 'toggle-annotate') {
    // Message the content script rather than injecting: injecting would
    // require host permissions for every site the human ever annotates.
    try {
      await chrome.tabs.sendMessage(tab.id, { kind: 'command', command: 'toggle-annotate' });
    } catch {
      // No content script here (a chrome:// page, the web store, a PDF).
      await chrome.action.setBadgeText({ text: '—', tabId: tab.id });
      setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }), 1500);
    }
  }
  if (command === 'mark-tab') {
    // A 1.5s badge on the toolbar is invisible in practice, so say it in the
    // page where the human is actually looking.
    let ok = true;
    try {
      await markTab(tab);
    } catch {
      ok = false;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, {
        kind: 'command',
        command: 'toast',
        text: ok ? 'This tab is handed to the agent' : 'Could not reach the cdp bridge: run `cdp bridge`',
      });
    } catch {
      /* no content script here */
    }
    await chrome.action.setBadgeText({ text: ok ? '✓' : '!', tabId: tab.id });
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }), 4000);
  }
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
chrome.alarms?.onAlarm.addListener(a => a.name === 'cdp-badge' && refreshBadge());
refreshBadge();

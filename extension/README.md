# browserctrl handoff extension

Wraps the same `annotate.js` the daemon injects. It exists for the three things
injection cannot do:

- a toolbar click that immediately enters annotation mode,
- a browser-level shortcut (Alt+A annotate, Alt+M hand over this tab),
- a popup that marks several tabs at once, including ones you are not on,
- working in tabs where no debug port is on, because the background worker owns
  the loopback call.

`annotate.js` is a copy of `../lib/overlay/annotate.js`, refreshed by
`npm run sync-extension`. Never edit it here.

## Install

Chrome or Dia: `chrome://extensions` → Developer mode → Load unpacked → choose
this folder. The bridge starts automatically when an agent uses the annotation or tray features; run
`browserctrl bridge` once if you want the extension ready before the agent arrives.
The extension folder is `extension/` inside the install folder (`browserctrl where` prints it).

To hand off a precise problem: click the toolbar icon → click the element →
write the note → Save. The confirmation tells you the exact Codex message to
send. To hand off a whole tab or manage several tabs, right-click the toolbar
icon and choose the relevant menu item. If the bridge is briefly unavailable,
the extension persists the annotation and retries it instead of claiming it
sent.

## How it talks to the bridge

The bridge refuses any request without its token, because any web page can call
loopback. It trusts this extension by its origin (`chrome-extension://<id>`),
which a page cannot set. The id is fixed by the `key` in `manifest.json`, so it
is the same wherever the folder is loaded. If you loaded the extension before
that key existed, remove and load it again, or set `BROWSERCTRL_BRIDGE_EXTENSION_ID`
to the old id.

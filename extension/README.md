# cdp handoff extension

Wraps the same `annotate.js` the daemon injects. It exists for the three things
injection cannot do:

- a browser-level shortcut (Alt+A annotate, Alt+M hand over this tab),
- a popup that marks several tabs at once, including ones you are not on,
- working in tabs where no debug port is on, because the background worker owns
  the loopback call.

`annotate.js` is a copy of `../lib/overlay/annotate.js`, refreshed by
`npm run sync-extension`. Never edit it here.

## Install

Chrome or Dia: `chrome://extensions` → Developer mode → Load unpacked → choose
this folder. The bridge must be running: `cdp bridge`.

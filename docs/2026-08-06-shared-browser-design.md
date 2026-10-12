# Shared browser: human and agent on the same tabs

Design, 2026-08-06. Builds on browserctrl v2.

## Problem

Three gaps between what an agent can do with a browser and what the work
actually needs:

1. **Reference.** A human says "this tab" and means the one in front of them.
   An agent says "tab 32BD908B". Neither is legible to the other.
2. **Annotation.** A human wants to mark several elements ("this button should
   be disabled", "this copy is wrong") and have the agent address all of them
   on the next turn, the way the Codex app collects annotations.
3. **Recording.** A human wants to demonstrate a flow, possibly across tabs and
   across applications, annotate the recording, and have the agent act on it
   with real element references rather than pixel coordinates.

## Non-goals

- Replaying recordings automatically. A recording produces steps a human or
  agent can read and edit; turning it into an autonomous test is a later,
  separate decision.
- Driving non-browser applications. Outside the browser we capture what was on
  screen and which window was frontmost, nothing more.
- Depending on any single harness. The contract is MCP tools plus a CLI.

## 1. Tab identity

The human's focused tab is already discoverable: exactly one tab reports
`document.hasFocus() === true` with `visibilityState === 'visible'`. No UI is
needed to answer "the tab I am looking at".

- `browserctrl tabs` marks it `←you`.
- `--tab active` resolves to it. `browser_tabs` returns `focused: true` on it.
- `browserctrl name <tab> <alias>` records a human-readable alias in the same store as
  claims. `--tab checkout` then works for both sides, and the annotation
  overlay offers naming so the human can christen a tab without the terminal.
- A tab discarded by memory saver may fail evaluation. `browserctrl focus` selects
  and revives it; `tabs` labels a suspended tab `(suspended)`. `wake` remains a
  compatibility alias for `focus`. A failed evaluation alone does not establish
  that the tab was discarded.

Taking over a human-opened tab already works in v2 and needs nothing new: tabs
are enumerated regardless of who opened them, and claims arbitrate.

### Marks: handing over tabs you are not on

Focus answers "the tab I am on". It cannot answer "these three tabs are for
you", which is the more common case: you line up a few tabs while working on
something else and want the agent to take them.

A **mark** is a human-set handoff flag on a tab. It is deliberately not a
claim: a claim is the agent's mutual exclusion between agents, a mark is your
instruction to an agent. Marks live beside claims and carry an optional note.

Ways to mark, all writing the same store, in order of availability:

- **CLI, no install, any tab:** `browserctrl mark <tab|url-substring> [--note "…"]`,
  `browserctrl unmark`, `browserctrl marks`. Marking by URL substring means you never have to
  switch to the tab or learn its id.
- **Tray page, no install:** `browserctrl tray` opens a local page listing every tab
  with title, URL and favicon, each with a checkbox. Tick the tabs you are
  handing over, add a note, done. This is the answer for marking tabs you are
  not on before the extension exists, and it works in any browser with the
  debug port.
- **Overlay badge:** hands over the tab you are currently on, one keystroke.
- **Extension popup (phase 5):** the same list as the tray, but one click from
  the toolbar with no debug port needed, plus a browser-level shortcut. This is
  the best version of the interaction and the main reason the extension earns
  its keep.

Agent side: `--tab marked` resolves when exactly one tab is marked and lists
them when several are, `browserctrl marks` and `browser_marks` return the set with
notes, and the piggyback line reports marked tabs the same way it reports
pending annotations. Annotating a tab marks it implicitly, since annotating is
already a handover.

Marks expire after 8 hours so a forgotten mark does not silently steer a later
session, and `browserctrl marks` shows the age.

## 2. Annotation

### Overlay

One overlay script, `lib/overlay/annotate.js`, is the single implementation.
It is delivered two ways:

- **Injected** by the daemon via `Page.addScriptToEvaluateOnNewDocument`, so it
  survives navigation. Works today, no install, any Chromium with the debug
  port on. The daemon auto-attaches to all tabs so any tab is annotatable.
- **Wrapped by an extension** (`extension/`), which loads the identical script
  as a content script. This is what covers the cases injection cannot: a
  browser with no debug port, a tab the daemon never attached to, and a real
  browser-level keyboard shortcut and toolbar button.

Injection ships first; the extension wraps it without forking the behaviour.

### Interaction

Hotkey toggles annotate mode. Hovering outlines the element under the cursor
and shows its role and accessible name. Clicking captures it and opens a small
note field. Escape exits. A badge shows the pending count and clears the queue.

### What a captured annotation stores

```json
{
  "id": "an_7f3c",
  "createdAt": "2026-08-06T15:41:02.881Z",
  "note": "this should be disabled until preview runs",
  "tab": { "targetId": "32BD…", "alias": "houston-access", "url": "…", "title": "…" },
  "element": {
    "role": "button", "name": "Confirm and apply",
    "testid": "wb-confirm", "selector": "main button:nth-of-type(9)",
    "box": { "x": 658, "y": 373, "w": 152, "h": 32 },
    "html": "<button …>Confirm and apply</button>",
    "screenshot": "~/.cdp/annotations/an_7f3c.png"
  }
}
```

The selector is generated by preferring, in order: a test id, a unique id, a
role plus accessible name, then a structural path. The agent gets several ways
to find the element again, so one going stale is not fatal.

### Storage

The daemon owns the queue at `~/.cdp/annotations/queue.jsonl`, not the page.
Annotations therefore survive navigation, tab close, and browser restart, and
are readable by an agent that was not running when they were made.

### Handoff, across harnesses

Ordered by portability:

1. **`browser_annotations` MCP tool** (`peek`, `consume`, `clear`), plus
   `browserctrl annotations`. Works in every MCP client: Claude Code, Codex, opencode,
   Cursor. This is the contract.
2. **Result piggyback.** Any `browser_*` tool result appends
   `[3 pending annotations: call browser_annotations]` when the queue is
   non-empty. Requires nothing of the harness, and covers every flow where the
   agent already touches the browser.
3. **Hook shim, where the harness has one.** Claude Code gets a
   `UserPromptSubmit` hook that prepends pending annotations to the next
   message, which is the Codex-app-like experience. Codex has only outbound
   `notify`, so it relies on 1 and 2. An opencode plugin can be added later.

Protocol-level server push (logging notifications, `resources/updated`) is
deliberately not depended on: client handling varies too much to build on.

## 3. Recording

`browserctrl record start --browser dia [--video] [--apps]` … `browserctrl record stop`,
writing `~/.cdp/recordings/<id>/`.

### Layers, one clock

Every layer timestamps against the same monotonic wall clock, which is what
makes a video mark resolvable to an element.

- **`events.jsonl`, browser semantics.** An injected recorder captures click,
  input, change, submit, keydown, navigation, tab open and tab close, each with
  the same element identity block an annotation carries, plus the tab. This is
  the layer that makes a recording useful to an agent, and it works with no
  video at all.
- **`screen.mp4`, optional.** ffmpeg avfoundation captures the screen. macOS
  asks for the screen-recording permission once. Fallback `screencapture -v`.
- **`windows.jsonl`, optional.** The frontmost application and window title,
  sampled each second via osascript. Cheap, and it makes a mark taken while
  Slack or the terminal was frontmost legible without an accessibility crawl.

### Output

- `steps.md`: the event log rendered as readable steps, one line per action
  with the element's role and name, grouped by tab and by frontmost app.
- The raw `events.jsonl` for anything that needs precision.

## 4. Video annotation

`browserctrl annotate <recording-id>` opens a local page with the video, a mark button,
and a note field. Each mark stores `{ t, note }`.

Resolution turns marks into agent-actionable context. For each mark:

- Browser events within ±2s are attached, nearest first, with full element
  identity.
- If no browser event is near, the frontmost window at that second is attached
  from `windows.jsonl`, plus a frame grab.

The agent reads resolved marks through `browser_recording` / `browserctrl recording
<id>`, receiving, for example:

> at 0:42, "this should be disabled until preview runs" — nearest event: click
> on button "Confirm and apply" `[data-testid=wb-confirm]`, tab
> `houston-access`, `…/admin/workbench-access`

which is directly actionable, unlike a frame number.

## Phasing

Each phase is independently useful and independently shippable.

1. **Tab identity and marks.** `--tab active`, `←you`, aliases, suspended
   labelling, `browserctrl mark/unmark/marks`, the `browserctrl tray` page, `--tab marked`.
2. **Annotation, injected.** Overlay, queue, `browser_annotations`, piggyback,
   Claude Code hook.
3. **Recording, browser only.** `events.jsonl`, `steps.md`.
4. **Video and window timeline.** ffmpeg, osascript sampling, `browserctrl annotate`,
   mark resolution.
5. **Extension.** Wraps the same overlay and recorder, adds toolbar and
   browser-level shortcut, covers tabs with no debug port.

## Testing

Extends the v2 rig, which drives a throwaway headless browser.

- Tab identity: focus one of two tabs, assert `active` resolves to it.
- Marks: mark by URL substring, assert `--tab marked` resolves to that tab,
  that a second mark makes it list rather than guess, and that marks expire.
- Annotation: drive the overlay's own API in the fixture page, assert the queue
  entry has a selector that still resolves after a re-render.
- Recording: perform a scripted click and input, assert `events.jsonl` contains
  both with correct element identity, and that `steps.md` reads correctly.
- Resolution: synthesise events and marks with known offsets, assert each mark
  attaches the right event.
- Video and the extension are verified by hand; both are hard to assert
  headlessly and neither carries logic the other layers do not already cover.

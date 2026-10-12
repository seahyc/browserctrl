---
name: browserctrl
description: Control explicitly selected Chromium browsers or Safari 27+ from the terminal or MCP. Use for page automation, browser QA, or tab organization; macOS Dia supports dormant tabs. Safari uses Apple's separate automation session.
---

# browserctrl

Project source and issues: [seahyc/browserctrl](https://github.com/seahyc/browserctrl).

Invoke this skill as `$browserctrl`. The primary CLI is `browserctrl`; `cdp`
and `browserctl` remain compatibility commands. Legacy runtime paths under
`skills/chrome-cdp` have no SKILL.md and are not a second skill.

## Safari and platform selection

Select the browser explicitly. Chromium uses the existing CDP commands on macOS,
Linux and Windows. Windows uses named pipes and a PowerShell lock adapter, not
AppleScript. Automatic relaunch and screen video remain macOS-only. See
[compatibility and test evidence](docs/compatibility.md) before promising support.

For Safari 27+ on macOS, use `--browser safari` and the separate Apple MCP adapter.
Check `browserctrl safari tools --browser safari` for supported schemas. Safari
Settings must allow remote automation and external agents; obtain the user's
permission before granting that access. Do not restart Safari to fix an uncertain
operation. Read the returned error and re-observe before retrying an action.

```sh
browserctrl open https://example.com --browser safari
browserctrl tabs --browser safari
browserctrl reload <full-tab-handle> --browser safari --until load
browserctrl read <full-tab-handle> --browser safari
browserctrl safari call page_interactions --tab <full-tab-handle> --args '{"interactions":[{"type":"click","node":"42","purpose":"Open details"}]}' --browser safari
```

Safari calls use full native tab handles and node UIDs from Safari's own content
read, never Chromium `ref_N` values. Every page call needs an explicit handle;
the daemon checks the claim and serializes tab selection plus the call. Supply a
stable `CDP_AGENT_ID` for CLI workflows or `agentId` on every shared MCP call.
Release your claims at handoff. The MCP `browser_safari` tool supports `tools`,
`call`, `status` and `stop`; common browser tools also route supported operations
when `browser="safari"`. Unsupported operations fail explicitly. Python's
`ChromeCDP` client, tab grouping, dormant Dia tabs, recording, uploads and raw CDP
remain Chromium-only. Safari reload schedules `location.reload()` once through native JavaScript
evaluation and observes the new document. It is an adapter helper, not a direct
Apple MCP reload tool. Safari `focus` and its `wake` alias select the automation
context through `switch_tab`; normal Safari window foregrounding is not
guaranteed. Safari creates an automation session; do not assume access
to the user's existing Safari tabs or signed-in state. Verify background behavior
against a disposable page before offering an unattended workflow.

## Start here: reuse the shared connection

For every browser action, use this skill's CLI, MCP server, or SDK. They share
one daemon connection per browser. Do not create direct WebSocket clients or use
Playwright `connect_over_cdp` against the signed-in browser: those bypass the pool
and can trigger a fresh debugging approval for each connection.

1. Select Dia explicitly with `--browser dia` or MCP `browser: "dia"` when using
   the user's Dia session.
2. Choose one unique identity for this agent and keep it across all calls:
   `CDP_AGENT_ID` for CLI/Python, or `agentId` for MCP. Give sibling agents
   different identities, even when they share one MCP server.
3. Before bulk browsing, describe the work and its progress with `activity describe`.
   Read [activity and background readiness](references/activity.md) for status,
   pause/resume controls, and readiness checks. Open a background tab per agent
   and keep its returned tab ID. For an existing
   user-designated tab, read it first and respect its claim. See
   [Tabs and claims](#tabs-and-claims) for ownership and handoffs.
4. Keep the shared daemon running between actions and at task completion.
   Release your claims when finished. Do not stop the daemon, restart Dia, or
   open a direct connection to recover from a timeout. Observe current state
   through the pooled client before deciding whether to retry an action.
5. If approvals repeat, run `doctor --browser dia --watch-seconds 20` and inspect
   callers before changing the connection. See
   [Repeated debugging approvals](#repeated-debugging-approvals).

For CLI use, set `CDP_AGENT_ID` to your unique task identity on every invocation
(or export it once in a persistent shell), then run:

```sh
node ~/.agents/skills/browserctrl/scripts/browserctrl.mjs tabs --browser dia
```

One initial approval or a new approval after browser reconnection can still be
required. The pool cannot suppress approvals from clients that bypass it.

For multi-step work, prepare independent field values once and use guarded
batches or the workflow runner. Both are data-only; Jev selection is optional
in workflows and disabled by default. Read the [batch contract](references/batch.md)
and [workflow contract](references/workflow.md) before using these APIs.

Chrome DevTools Protocol control for agents. Two frontends over one core:

- **CLI**: `scripts/browserctrl.mjs <command>` (also `bin/browserctrl.mjs`)
- **MCP server**: `mcp/server.mjs`, exposing `browser_*` tools to Claude Code, Codex, or any MCP client

Prefer the MCP tools when they are available in your session: screenshots come
back inline, and the schemas stop you guessing CLI syntax. The CLI is the
fallback and the debugging surface.

## Pick a browser explicitly

There is no default browser and no sticky session file. A command without
`--browser` or `--port` fails and prints what is available. This is deliberate:
the old shared default is what made agents think they were driving Chrome while
they were driving Dia.

```bash
browserctrl browsers
# ✓ Dia       --browser dia       :9223  7 tabs  daemon up
# • Chrome    running, not debuggable -> open the toggle at chrome://inspect/#remote-debugging
#   Brave     not running
```

If the selected browser is not debuggable, inspect `browserctrl browsers` and use its
reported enablement instructions. Do not restart the user's signed-in Dia merely
to enable debugging. `browserctrl launch <browser>` quits and relaunches that browser's real
profile with its debug port; use it only when the user has authorized that restart. It reports
`"ready": true` only after the debug port answers (reopening once if the first launch was swallowed
by the quitting instance) and fails loudly otherwise; it never claims success on a browser that did
not come back.

`browserctrl launch <browser> --user-data-dir <dir>` instead starts a separate instance on its own
profile and leaves the user's running browser untouched. Chrome 136+ refuses a debug port on the real
profile, so `launch chrome` without `--user-data-dir` refuses before quitting anything and points to
the `chrome://inspect/#remote-debugging` toggle or the separate-profile option.

## Sharing tabs with the human

Three ways to mean the same tab, so a person and an agent can talk about one:

```bash
browserctrl tabs --browser dia         # the human's tab is flagged ←you
browserctrl read active --browser dia  # "the tab I am looking at", no ids involved
browserctrl name <tab> checkout --browser dia   # then --tab checkout works for both
```

**Marks are how the human hands over tabs they are not on.** A mark is not a
claim: a claim is the agents' mutual exclusion, a mark is the human's
instruction. They expire after 8 hours.

```bash
browserctrl mark "review-app" --note "check the empty state" --browser dia   # by URL substring
browserctrl tray --browser dia          # a page listing every tab with a checkbox each
browserctrl marks --browser dia
browserctrl read marked --browser dia   # the agent resolves the handover
```

## Annotation: point at elements for the agent

```bash
browserctrl overlay <tab> --browser dia   # arm it; the human presses option+A in the page
browserctrl annotations                   # what they marked
browserctrl annotations --consume         # once you have acted on them
```

In annotate mode, hovering outlines elements and clicking one opens a note
field. Each annotation carries the note, the element's role, accessible name,
test id and several selectors, a cropped screenshot, and which tab it was.
Annotating a tab marks it too.

Delivery to the agent, in order of portability: the `browser_annotations` MCP
tool works everywhere; every `browser_*` result appends a line when the queue
is non-empty, which needs nothing from the harness; and in Claude Code a
`UserPromptSubmit` hook puts them in front of the agent automatically.

When Dia's ordinary tab list omits a dormant tab, or a task needs exact
native-tab selection and grouping, read the [Dia native tab reference](references/dia-native.md).
It covers adapter capabilities and background-first grouping. Native focus fallback
requires explicit `--allow-focus`; use it only when temporary foreground selection
is within the user's requested scope.

Transport note, because it is not obvious: the overlay hands data back through
a **CDP binding**, not `fetch`. Current Chromium blocks an HTTPS page from
calling loopback (Local Network Access), so an HTTP bridge call from a real
site silently hangs. The extension path uses its background worker instead,
which is exempt.

## Recording a play

```bash
browserctrl record arm --browser dia      # optional: opens the capture device now, so
                                  # `start` is instant and the first ~2s are on film
browserctrl record start --browser dia --video --label "shortlist flow"
# ... drive the browser, and anything else on screen ...
browserctrl record stop
browserctrl recording <id> --steps        # readable steps with element identity
browserctrl annotate <id> --browser dia   # mark moments on the video
browserctrl recording <id>                # marks resolved to real events
```

`record arm` is opt-in on purpose: an armed capture writes video continuously
whether or not you ever record. `browserctrl record status` says whether one is warm,
`browserctrl record disarm` stops it.

Three layers on one clock: browser events with element identity, an optional
screen video, and a frontmost-app sample each second so time spent outside the
browser is still legible. A mark at 0:42 comes back as "click on button
'Confirm and apply' [data-testid=wb-confirm]", not as a frame number.

## Read before you act

`browserctrl read` snapshots the page into `ref_1..ref_N` with roles, accessible names
and test ids, plus the visible text. Act on refs, not on guessed selectors.

```bash
browserctrl tabs --browser dia
browserctrl read a1b2c3d4 --browser dia
# Use --json when another tool should parse the result; --text none skips page text.
browserctrl read a1b2c3d4 --json --max-text 8000
# ref_1    button     Sign in with Google              [signin-google]
# ref_2    textbox    Your name
# ref_7    select     Access level
```

Refs are invalidated by navigation and by the next `read`. Using a stale ref
returns "re-run browserctrl read" instead of clicking whatever now sits in that slot.

## Acting

Every action takes `--ref ref_3`, `--selector <css>`, or `--x/--y`.

```bash
browserctrl click <tab> --ref ref_3 --browser dia
browserctrl click <tab> --ref ref_3 --button right           # or --count 2, --mod cmd,shift
browserctrl hover <tab> --selector ".menu"
browserctrl fill  <tab> --ref ref_2 --value "Ada Lovelace"   # fires input + change
browserctrl select <tab> --ref ref_7 --label "Exporter"
browserctrl type  <tab> "literal text"
browserctrl key   <tab> Enter                                 # cmd+a, shift+Tab, Escape
browserctrl upload <tab> --ref ref_4 --files /abs/a.pdf,/abs/b.png
browserctrl scroll <tab> --dy 600
browserctrl scroll-to <tab> --ref ref_9
browserctrl drag <tab> --from ref_1 --to ref_2
browserctrl act <tab> --steps '[{"action":"scroll","dy":800},{"action":"key","key":"Enter"}]'
```

`browserctrl act` is the token-efficient batch equivalent of repeated `browser_act`
calls. It stops at the first failure and accepts the same action shapes as the
MCP tool. Add `--json` for machine-readable results.

## Wait for conditions, never sleep

For Chromium page readiness, use `ready` after navigation or attachment. It waits
for the current page without reloading it or selecting its tab. `focus` selects
the tab and may revive a discarded page; it is not a readiness check. Do not call
`focus` for every link in a review loop.

```bash
browserctrl ready <tab> --browser dia --until domcontentloaded --timeout 15000
browserctrl ready <tab> --browser dia --selector ".results" --text "Results"
```

MCP `browser_wait` accepts `readyState: "load"` or `"domcontentloaded"`. Existing
condition waits remain available:

```bash
browserctrl nav <tab> https://example.com --until networkidle   # load | domcontentloaded | networkidle | none
browserctrl wait <tab> --selector ".results"
browserctrl wait <tab> --gone ".spinner"
browserctrl wait <tab> --text "Saved"
browserctrl wait <tab> --url /success
browserctrl wait <tab> --network-idle --timeout 30000
```

`--selector` and `--gone` mean *visible*, not merely present in the DOM. A
`display:none` node that is already in the markup would otherwise satisfy the
wait instantly and hand you a page that has not updated. Add `--present` when
existence really is the condition you mean.

`reload` reloads the current URL without activating the tab and waits for the
new document. Choose `--until load`, `domcontentloaded`, `networkidle` or `none`;
the timeout defaults to 30000 milliseconds. `ready` only observes the existing
page. `focus` selects it without reloading. Legacy `wake` aliases `focus`, and
`refresh` aliases `reload`; focus needs no additional approval flag.

## See what happened

```bash
browserctrl shot <tab> /tmp/out.png            # add --full, or --ref ref_3 / --selector css
browserctrl console <tab>                      # console output + uncaught errors
browserctrl network <tab> --failed             # 4xx/5xx and failed requests
browserctrl cookies <tab>
browserctrl text <tab> --max-text 8000         # bounded visible text (20,000 by default)
browserctrl text <tab> --match '评价|平台'      # only lines matching a case-insensitive regex
browserctrl html <tab> [selector]
browserctrl eval <tab> "location.href"
```

Console and network are buffered by the daemon from the moment it attaches to
a tab, so reload after attaching if you need the events from page load.

## Browser-level control the protocol does not have

CDP drives pages. It cannot touch tab groups, bookmarks, history, downloads,
the reading list, sessions, or half of `chrome.tabs` (pin, mute, duplicate,
move, discard, zoom) — those exist only as extension APIs.

So the extension doubles as a permission carrier. There is no RPC protocol:
`browserctrl ext` attaches CDP to the extension's own service worker and evaluates
there, which means anything the manifest grants is callable without teaching
this CLI about it first.

```bash
browserctrl ext --browser dia                      # is it loaded, and what does it grant
browserctrl ext outline --browser dia              # every tab, annotated with its group
browserctrl ext group --url /merge_requests/42,/merge_requests/71 --title "Review" --color blue
browserctrl ext undo-close --browser dia           # restore the last closed tab
browserctrl ext apis --browser dia                 # every chrome.* function actually reachable
browserctrl ext api tabs.update '[123,{"pinned":true}]'    # generic invoker: any granted API
browserctrl ext api bookmarks.search '[{"query":"gitlab"}]'
browserctrl ext api downloads.search '[{"limit":5}]'
browserctrl ext eval "chrome.tabs.query({})" --browser dia # raw expression escape hatch

# Shortcuts for the extension-backed native tab-group API:
browserctrl group --url taobao.com,shopee.sg --title Shopping --color blue
browserctrl ungroup --url taobao.com,shopee.sg
```

The grouping helper includes every matching tab, not just the first match for
each pattern. Native grouping still requires the handoff extension; CDP alone
cannot access tab groups. For task-scoped research, group the tabs immediately
after opening them, keep a ledger of the tabs opened by the task, and close
those tabs before handoff; then ungroup the now-empty group. Never use a broad
URL pattern that could match the user's pre-existing tabs. If a tab is claimed
or protected, leave it open and report it rather than force-closing it.

`browserctrl ext api` is the one that keeps this honest: it dots into the `chrome`
namespace at runtime, so a permission added to the manifest is immediately
callable without touching the CLI. `browserctrl ext apis` lists what is genuinely
reachable, which turns "did I typo it or is the permission missing?" into a
question you can answer.

`browserctrl ext eval` takes any expression; a promise is awaited and the result comes
back as JSON. That is the escape hatch — reach for the named subcommands when
they fit and `eval` when they do not.

This needs the extension loaded (`chrome://extensions` -> Developer mode ->
Load unpacked -> `extension/`). Without it you get a message saying so rather
than a confusing failure. MV3 terminates idle service workers, so the
extension keeps a 30s alarm heartbeat and `browserctrl ext` retries a few times before
declaring it absent.

**The extension stays loopback-only on purpose.** `host_permissions` is pinned
to `127.0.0.1` and `localhost`, and `debugger` is refused; a test enforces
both. None of the APIs above need host access, so broad host permissions would
buy nothing and cost a great deal of trust.

## Tabs and claims

Up to ten agents have been tested concurrently, both as separate client processes
and through one MCP server. Give each agent a unique, stable identity: set
`CDP_AGENT_ID` for CLI/Python, or pass `agentId` on MCP browser calls. Keep that
identity across the agent's calls. Sibling agents must not inherit the same ID.
Without an override, the client uses its chat/session ID, then its process ID.

Open a separate tab for each agent and keep using its returned tab ID. New tabs
open in the background. Target commands, including reads that create snapshot
refs, acquire or renew a 15-minute lease. The daemon rejects other owners before
sending commands. Claims update under a process-safe file lock; another agent
cannot release your lease. Explicit `--steal` transfers an idle tab, but cannot
interrupt an in-flight action. Use handoff or release when sharing a tab deliberately.

Input requests serialize within a tab and briefly emulate focus without selecting
it in the browser UI. Background scrolling uses the page's scrollable element
instead of a wheel event; foreground scrolling retains wheel events.

Structured extension inspection (`ext outline`, `tabs.query`, `tabGroups.query`,
and `tabGroups.get`) can run alongside other agents. Exact `tabs.group`,
`tabs.remove`, `tabGroups.update`, and `native-group` operations check claims
for every selected tab and destination group member. They refuse changes that
affect another owner, including ambiguous duplicate URLs. Scoped mutations
serialize with each other while unrelated page actions continue. Arbitrary
extension evaluation and other browser-wide control still require exclusive
access because they can affect tabs outside the caller's ownership.

Agents still share Dia's cookies, account sessions and website storage; tab leases are coordination, not
isolated accounts or a security sandbox.

After upgrading from clients without identity support, reload their MCP servers.
The daemon rejects identity-less target commands with a reload instruction;
a fresh CLI process uses the new protocol immediately.

```bash
browserctrl open https://example.com --browser dia
browserctrl open https://example.com --browser dia --anonymous
browserctrl tabs --browser dia            # shows [claude-code (3m ago)] on claimed tabs
browserctrl claims
browserctrl release <tab> --browser dia   # or: browserctrl release --mine
browserctrl close <tab> --browser dia
browserctrl focus <tab> --browser dia     # select the tab without reloading
browserctrl reload <tab> --browser dia --until load --timeout 30000
browserctrl status --browser dia          # daemon state
browserctrl stop --browser dia            # stop the daemon for that port
```

Use `--anonymous` for signed-out and clean-session testing. It opens a temporary
isolated browser context with none of the profile's cookies or site storage, so
it does not sign the human out or alter their ordinary tabs. `browserctrl tabs` labels
the tab anonymous, and `browserctrl close` disposes the entire temporary context. This
is isolation, not an authentication bypass: complete the site's normal login
and consent flow when required.

On the registered local Dia endpoint, closing an anonymous tab first closes its
native single-tab window, then disposes the Chromium context after its pages are
gone. Dia 1.49.1 can crash if CDP disposes a context while Dia is creating a
replacement tab. Listing/resolving tabs therefore never performs context cleanup.
If the native window cannot be uniquely matched (including internal new-tab URLs,
duplicate URLs, or multiple tabs), cleanup fails safely and retains ownership;
close that private window normally. Local native-window cleanup does not apply
to forwarded/custom endpoints. After updating this code, existing MCP server
processes must be reloaded to pick up operation changes, or use a fresh CLI process.


## MCP tools

Same capabilities, typed. Register once:

```bash
# Claude Code
claude mcp add browser -- node ~/.agents/skills/browserctrl/mcp/server.mjs

# Codex
codex mcp add browser -- node ~/.agents/skills/browserctrl/mcp/server.mjs
```

Tools: `browser_list`, `browser_tabs`, `browser_open`, `browser_close`,
`browser_read`, `browser_navigate`, `browser_wait`, `browser_focus`,
`browser_reload`, `browser_act`,
`browser_screenshot`, `browser_diagnostics`, `browser_eval`,
`browser_annotations`, `browser_marks`, `browser_annotate_mode`,
`browser_record`, `browser_recording`, `browser_activity`.

`browser_wake` and `browser_refresh` remain aliases for `browser_focus` and
`browser_reload`. The SDK uses `ops.focus` and `ops.reload`, with `ops.wake` and
`ops.refresh` as aliases. The Chromium Python client exposes `client.focus(tab)`
and `client.reload(tab, wait_until='load', timeout=None)`; `client.wake` and
`client.refresh` are aliases.

`browser_act` takes one action or a `steps` array that runs in order and stops
at the first failure. Screenshots return inline images to clients that render
them and always include the saved path, so Codex can read the PNG itself.

## Architecture

```
lib/discovery.mjs   which browsers are debuggable, and how to enable the rest
lib/daemon.mjs      one master daemon per port: browser WS, sessions, event buffers
lib/claims.mjs      atomic tab ownership leases across agents
lib/anonymous.mjs   contexts created by --anonymous, for safe whole-context cleanup
lib/state.mjs       human-set state: tab aliases and marks
lib/refs.mjs        the page snapshot and ref resolution
lib/ops.mjs         every operation, one function each
lib/overlay/        the annotation overlay, shared verbatim with the extension
lib/annotations.mjs the annotation queue
lib/recorder.mjs    recording lifecycle    lib/recstore.mjs  where recordings live
lib/bridge.mjs      loopback HTTP: tray page, video annotator, extension endpoint
lib/pages/          tray and video-annotator pages
bin/browserctrl.mjs         CLI frontend        mcp/server.mjs   MCP frontend
hooks/              Claude Code UserPromptSubmit hook
extension/          wraps the same overlay; adds a popup and browser shortcuts
```

A daemon per port holds one browser WebSocket, so Chrome's "Allow remote
debugging?" prompt fires once per session rather than per command, and console
and network events survive between invocations. It reconnects across a browser
restart and exits after 300 days idle. A new browser connection can still require approval.

All of this skill's CLI, MCP, and Python clients for one port reuse this daemon and browser
WebSocket. A kernel-held file lock gives one daemon ownership of each port and
is released automatically on process exit, including crashes. Startup reserves
the local socket before connecting to the browser;
concurrent clients wait for that connection, including its approval dialog.
Lock acquisition uses macOS `/usr/bin/lockf`, or `/usr/bin/flock` on Linux. The
small `.lock` file remains on disk; its existence does not mean a daemon is alive.
Tab attachments and domain initialization are shared across clients. Tab claims
still govern which agent may act; sharing a connection does not share ownership.

Recovery is demand-driven, with no periodic browser health checks. New clients
allow up to 30 seconds for daemon IPC liveness and 5 seconds for browser HTTP
discovery, avoiding replacement merely because the host is busy. They check
local status instead of sending a browser health command on every
connection. Older clients get a fast, explicitly unchecked transport status from
their legacy health handshake, so their shorter deadlines cannot retire a live
daemon. Updated `health()` and `doctor` wait for the full browser probe.
A command timeout triggers one shared browser-level probe, allowing
30 seconds for a response. Other browser replies during that window also prove
the transport is alive, so a slow health command does not force reapproval.
Commands default to a 30-second protocol timeout; explicit action timeouts still
apply. Target IPC deadlines include a separate 60-second initialization allowance for
attachment and domain setup. The requested action keeps its own protocol timeout;
initialization does not consume that action's timeout or trigger a replay.
For MCP integrations, allow at least 120 seconds for the enclosing tool call
when a tab needs initialization; a 60-second client deadline can expire first.
Keep action timeouts separate, and observe state after any uncertain timeout.
The Python sidecar's outer deadline includes the same initialization allowance
and the pending approval window, so it does not close a reusable connection
before the daemon can answer.
The daemon retires only when that window ends with no response or other request
progress. An approval handshake waits up to five minutes on the same connection
before failing; concurrent clients share that pending handshake.
Recordings carry the recorder process PID and start identity. A dead owner,
reused PID, or legacy recording without an owner is inactive; the daemon leaves
its saved recording intact and skips automatic tab instrumentation. Reload old
recording clients before starting a new recording.

A subsequent connection creates a replacement. If the daemon itself stops answering,
connection setup verifies its recorded PID, process start time, and socket ownership
before terminating it. Unverifiable ownership fails without killing a process.
Timed-out or interrupted actions are never replayed. Use `reconnect()` and make a
fresh observation before deciding whether an action needs repeating.

## Background screenshot frames

Chromium can stop generating frames for background tabs on Windows. If a
background screenshot stalls, use `browserctrl shot <tab> output.png
--emulate-focus` or MCP `browser_screenshot emulateFocus=true`. This temporarily
emulates page focus through CDP, then disables it after capture. It does not
activate a browser tab or an OS window, but the page can observe focus events.
Use it only when overriding that tab's focus emulation is acceptable. A cleanup
failure is reported; inspect the tab before continuing. Focus emulation is not
a guarantee: Windows CI needed an active owned target for reliable capture.
Safari uses Apple's
separate screenshot implementation and does not support this option.

## Tests

```bash
cd ~/.agents/skills/browserctrl && npm test
```

The suite drives a throwaway headless browser on port 9333 with its own
user-data-dir, so it never touches a real profile. It also checks that every
command documented here exists in the CLI: v1 shipped docs for `net`, `loadall`
and `snap --compact`, none of which existed.

## The extension

`extension/` is loaded unpacked from `chrome://extensions` (Developer mode).
Its toolbar click is the primary path: it immediately enters annotation mode.
It also provides browser-level shortcuts (option+A annotate, option+M hand over
this tab), and a right-click toolbar menu for the less-common whole-tab and
multi-tab handoffs. After saving a note, send “review my browser handoff” in
the agent task. If the bridge is temporarily unavailable, the extension retains
the note and retries it rather than falsely confirming it.
It carries no annotation logic: `extension/annotate.js` is a verbatim copy of
`lib/overlay/annotate.js`, refreshed with `npm run sync-extension`, and a test
fails if the two drift.

## Gotchas

- Only loaded tabs appear in `browserctrl tabs`. A tab discarded by memory saver needs
  `browserctrl focus` (or a click in the browser) before it responds.
- Screenshots are native resolution: CSS px = image px / DPR, and `shot` prints
  the DPR.
- `browserctrl type` inserts text at the current focus and works inside cross-origin
  iframes, where `eval` cannot reach.
- Element refs come from one snapshot. If the page re-renders (a modal opens, a
  list reorders), read again before acting.
- The overlay and the recorder refuse to install twice, so after changing
  either, use `browserctrl overlay <tab> --force` or start a fresh recording rather
  than expecting a silent upgrade.
- A daemon started before a code change keeps running the old logic. Clients
  compare a code version on connect and restart a stale daemon, which is why
  you may see "restarting the daemon" after editing `lib/`.
- Screen recording needs the macOS permission once, granted to whatever runs
  ffmpeg.


## Persistent Python client and helpers

The shared client is `python/chrome_cdp`, backed by `bin/stdio.mjs`. Add this skill's
`python/` directory to PYTHONPATH. One sidecar stays alive for the entire client;
there is no subprocess per observation/action and no second browser daemon.

```python
from chrome_cdp import ChromeCDP

with ChromeCDP(browser="dia") as client:
    tab = client.new_tab("https://example.com")
    try:
        result = client.send(tab, "Runtime.evaluate", expression="document.title", returnByValue=True)
        print(result["result"]["value"])
    finally:
        client.close_tab(tab)
```

Use `client.attach(TAB_ID)` for an existing tab. All target calls check and renew
ownership claims; never steal another owner's tab. `client.release(tab)` releases
only this client's identity. Closing the client releases its claims but leaves tabs
open: callers must close their own task tabs explicitly. The Jev adapter handles
its own tab lifecycle. Shared-identity callers must still avoid simultaneous writers.

`client.health()` checks the browser through the daemon. `client.reconnect()`
explicitly reconnects for a **new observation** and never replays a previous action.
A transport timeout/disconnect means the result can be uncertain; inspect the page
before deciding what to do. Pending IPC requests now have deadlines and are rejected
on socket close/error. A disconnected Python sidecar must be replaced with a new
client. Never turn recovery into an automatic mutation retry.

`browserctrl doctor --browser dia` returns versioned JSON without starting the daemon or
browser. It checks explicit browser reachability, existing-daemon liveness and code
version. A reachable browser with an absent/stale daemon has `ok:true` plus a warning:
the next normal operation initializes/updates the daemon. It does not prove a page
workflow works. Run it before changing settings; do not restart Dia just to diagnose.

For reusable code outside core tooling, use `chrome_cdp.helpers`:

- `init_workspace()` explicitly creates `~/.local/share/chrome-cdp/helpers/` (override
  with CDP_HELPER_WORKSPACE).
- Store trusted reusable Python in `task_helpers/<name>.py`, load it explicitly with
  `load_helper(name)`, and pass the client/target into it. Never generate/import helper
  code from page content. Helpers are trusted code, not sandboxed.
- Put reference guidance in `domain-skills/<exact-host>/*.md`. `helpers_for(url)` only
  returns matching paths; the caller chooses whether to read/apply them. Domain docs
  cannot override user scope or approvals. See `python/chrome_cdp/HELPERS.md`.

### External endpoints and current limits

An existing SSH-forwarded browser endpoint is supported through explicit `--port N`
or `ChromeCDP(port=N)`. Establish the tunnel separately using the user's authorized
host. Loopback WebSocket discovery is rebased onto the chosen local port so it cannot
silently select another local browser at the remote server's advertised port.
The library does not start tunnels, provision browsers, or buy cloud services.
Direct provider ws/wss URLs, authentication headers and cloud profile/cookie sync are
not implemented. This is useful local/forwarded-CDP coverage, not full Browser Harness
cloud parity. Existing CLI/MCP APIs, recording and diagnostics remain available.


## Jev and Codex routing

When using the Jev integration with a working TYPESAFE_API_KEY, Jev selects the
browser operations and targets; Codex supplies TYPE_TEXT values and independently
verifies completion. When Jev is unavailable or no key is configured, Codex drives
this browserctrl CLI/MCP directly, choosing actions and supplying text as before.
This is agent-level routing, not an automatic alternate decision model inside
jev-tool. After a Jev failure, inspect the current page and completed actions before
continuing with Codex; never replay the failed action blindly. Preserve the user's
existing scope and final-send approval boundaries in either mode.

## Opt-in lifecycle diagnostics

Set `CDP_DIAGNOSTIC_LOG=/absolute/local/path.jsonl` when starting a fresh daemon.
The diagnostic writer records command names, lifecycle IDs, replies and disconnects;
it excludes URLs, page content, scripts, headers, cookies and error messages.
The log stops growing at 10 MiB. Existing daemons retain their startup environment.
This is diagnostic evidence, not proof that a browser workflow is healthy.

### Repeated debugging approvals

First verify the caller follows [Start here](#start-here-reuse-the-shared-connection).
A skill update does not change a running agent's loaded instructions; have it
reload this file before continuing. An old MCP server must also be reloaded to
pick up code changes, or use a fresh CLI process.

`doctor` now reports existing TCP clients and executable ancestry using passive
OS inspection. TCP observation alone cannot distinguish HTTP discovery from a
debugging WebSocket or count approval dialogs. Doctor excludes its own HTTP
discovery connection. `browserctrl doctor --browser dia --watch-seconds 20` saves a bounded
incident capture (maximum 60 seconds). It does not open a debugging connection,
start a daemon, or install a recurring check. Very short connections can be
missed; an empty capture does not prove there were no prompts. The normal doctor
health check uses an existing daemon connection when available.

Daemon lifecycle logs are enabled by default under
`~/.local/share/chrome-cdp/telemetry/`; override with `CDP_TELEMETRY_DIR`, or disable
lifecycle logging with `CDP_TELEMETRY=0`. Logs contain connection lifecycle,
request timing and protocol method metadata, with hashed agent identities; no
page content, URLs, JavaScript, parameters, cookies, or full process arguments.
Logs rotate and incident captures retain the latest 20 files, at most 1 MiB each.
Capture is explicit and still works when lifecycle logging is disabled. Existing
daemons pick up logging on their next replacement; historical connections are
not reconstructed. A missing stop record may indicate an abrupt exit, but does
not by itself prove a crash. Keep a capture when reporting repeated prompts.

---
name: chrome-cdp
description: Drive any Chromium browser (Chrome, Dia, Brave, Edge, Arc) from the terminal or as MCP tools - list and pick a browser, snapshot a page into stable element refs, click/fill/select/upload by ref, wait for real conditions instead of sleeping, screenshot, and read console and network logs. Use for browser QA, dogfooding a review app, or any task that needs a real logged-in browser session.
---

# chrome-cdp

Chrome DevTools Protocol control for agents. Two frontends over one core:

- **CLI**: `scripts/cdp.mjs <command>` (also `bin/cdp.mjs`)
- **MCP server**: `mcp/server.mjs`, exposing `browser_*` tools to Claude Code, Codex, or any MCP client

Prefer the MCP tools when they are available in your session: screenshots come
back inline, and the schemas stop you guessing CLI syntax. The CLI is the
fallback and the debugging surface.

## The one rule: pick a browser explicitly

There is no default browser and no sticky session file. A command without
`--browser` or `--port` fails and prints what is available. This is deliberate:
the old shared default is what made agents think they were driving Chrome while
they were driving Dia.

```bash
cdp browsers
# ✓ Dia       --browser dia       :9223  7 tabs  daemon up
# • Chrome    running, not debuggable -> open the toggle at chrome://inspect/#remote-debugging
#   Brave     not running
```

Enable a browser that is running but not debuggable:

```bash
cdp launch dia          # quits it and reopens with --remote-debugging-port=9223
```

Chrome 146+ refuses `--remote-debugging-port` on a real profile, so for your
signed-in Chrome profile use the `chrome://inspect/#remote-debugging` toggle
instead. Other browsers take the launch flag fine.

## Sharing tabs with the human

Three ways to mean the same tab, so a person and an agent can talk about one:

```bash
cdp tabs --browser dia         # the human's tab is flagged ←you
cdp read active --browser dia  # "the tab I am looking at", no ids involved
cdp name <tab> checkout --browser dia   # then --tab checkout works for both
```

**Marks are how the human hands over tabs they are not on.** A mark is not a
claim: a claim is the agents' mutual exclusion, a mark is the human's
instruction. They expire after 8 hours.

```bash
cdp mark "review-app" --note "check the empty state" --browser dia   # by URL substring
cdp tray --browser dia          # a page listing every tab with a checkbox each
cdp marks --browser dia
cdp read marked --browser dia   # the agent resolves the handover
```

## Annotation: point at elements for the agent

```bash
cdp overlay <tab> --browser dia   # arm it; the human presses option+A in the page
cdp annotations                   # what they marked
cdp annotations --consume         # once you have acted on them
```

In annotate mode, hovering outlines elements and clicking one opens a note
field. Each annotation carries the note, the element's role, accessible name,
test id and several selectors, a cropped screenshot, and which tab it was.
Annotating a tab marks it too.

Delivery to the agent, in order of portability: the `browser_annotations` MCP
tool works everywhere; every `browser_*` result appends a line when the queue
is non-empty, which needs nothing from the harness; and in Claude Code a
`UserPromptSubmit` hook puts them in front of the agent automatically.

Transport note, because it is not obvious: the overlay hands data back through
a **CDP binding**, not `fetch`. Current Chromium blocks an HTTPS page from
calling loopback (Local Network Access), so an HTTP bridge call from a real
site silently hangs. The extension path uses its background worker instead,
which is exempt.

## Recording a play

```bash
cdp record arm --browser dia      # optional: opens the capture device now, so
                                  # `start` is instant and the first ~2s are on film
cdp record start --browser dia --video --label "shortlist flow"
# ... drive the browser, and anything else on screen ...
cdp record stop
cdp recording <id> --steps        # readable steps with element identity
cdp annotate <id> --browser dia   # mark moments on the video
cdp recording <id>                # marks resolved to real events
```

`record arm` is opt-in on purpose: an armed capture writes video continuously
whether or not you ever record. `cdp record status` says whether one is warm,
`cdp record disarm` stops it.

Three layers on one clock: browser events with element identity, an optional
screen video, and a frontmost-app sample each second so time spent outside the
browser is still legible. A mark at 0:42 comes back as "click on button
'Confirm and apply' [data-testid=wb-confirm]", not as a frame number.

## Read before you act

`cdp read` snapshots the page into `ref_1..ref_N` with roles, accessible names
and test ids, plus the visible text. Act on refs, not on guessed selectors.

```bash
cdp tabs --browser dia
cdp read a1b2c3d4 --browser dia
# Use --json when another tool should parse the result; --text none skips page text.
cdp read a1b2c3d4 --json --max-text 8000
# ref_1    button     Sign in with Google              [signin-google]
# ref_2    textbox    Your name
# ref_7    select     Access level
```

Refs are invalidated by navigation and by the next `read`. Using a stale ref
returns "re-run cdp read" instead of clicking whatever now sits in that slot.

## Acting

Every action takes `--ref ref_3`, `--selector <css>`, or `--x/--y`.

```bash
cdp click <tab> --ref ref_3 --browser dia
cdp click <tab> --ref ref_3 --button right           # or --count 2, --mod cmd,shift
cdp hover <tab> --selector ".menu"
cdp fill  <tab> --ref ref_2 --value "Ada Lovelace"   # fires input + change
cdp select <tab> --ref ref_7 --label "Exporter"
cdp type  <tab> "literal text"
cdp key   <tab> Enter                                 # cmd+a, shift+Tab, Escape
cdp upload <tab> --ref ref_4 --files /abs/a.pdf,/abs/b.png
cdp scroll <tab> --dy 600
cdp scroll-to <tab> --ref ref_9
cdp drag <tab> --from ref_1 --to ref_2
cdp act <tab> --steps '[{"action":"scroll","dy":800},{"action":"key","key":"Enter"}]'
```

`cdp act` is the token-efficient batch equivalent of repeated `browser_act`
calls. It stops at the first failure and accepts the same action shapes as the
MCP tool. Add `--json` for machine-readable results.

## Wait for conditions, never sleep

```bash
cdp nav <tab> https://example.com --until networkidle   # load | domcontentloaded | networkidle | none
cdp wait <tab> --selector ".results"
cdp wait <tab> --gone ".spinner"
cdp wait <tab> --text "Saved"
cdp wait <tab> --url /success
cdp wait <tab> --network-idle --timeout 30000
```

`--selector` and `--gone` mean *visible*, not merely present in the DOM. A
`display:none` node that is already in the markup would otherwise satisfy the
wait instantly and hand you a page that has not updated. Add `--present` when
existence really is the condition you mean.

## See what happened

```bash
cdp shot <tab> /tmp/out.png            # add --full, or --ref ref_3 / --selector css
cdp console <tab>                      # console output + uncaught errors
cdp network <tab> --failed             # 4xx/5xx and failed requests
cdp cookies <tab>
cdp text <tab> --max-text 8000         # bounded visible text (20,000 by default)
cdp text <tab> --match '评价|平台'      # only lines matching a case-insensitive regex
cdp html <tab> [selector]
cdp eval <tab> "location.href"
```

Console and network are buffered by the daemon from the moment it attaches to
a tab, so reload after attaching if you need the events from page load.

## Browser-level control the protocol does not have

CDP drives pages. It cannot touch tab groups, bookmarks, history, downloads,
the reading list, sessions, or half of `chrome.tabs` (pin, mute, duplicate,
move, discard, zoom) — those exist only as extension APIs.

So the extension doubles as a permission carrier. There is no RPC protocol:
`cdp ext` attaches CDP to the extension's own service worker and evaluates
there, which means anything the manifest grants is callable without teaching
this CLI about it first.

```bash
cdp ext --browser dia                      # is it loaded, and what does it grant
cdp ext outline --browser dia              # every tab, annotated with its group
cdp ext group --url /merge_requests/42,/merge_requests/71 --title "Review" --color blue
cdp ext undo-close --browser dia           # restore the last closed tab
cdp ext apis --browser dia                 # every chrome.* function actually reachable
cdp ext api tabs.update '[123,{"pinned":true}]'    # generic invoker: any granted API
cdp ext api bookmarks.search '[{"query":"gitlab"}]'
cdp ext api downloads.search '[{"limit":5}]'
cdp ext eval "chrome.tabs.query({})" --browser dia # raw expression escape hatch

# Shortcuts for the extension-backed native tab-group API:
cdp group --url taobao.com,shopee.sg --title Shopping --color blue
cdp ungroup --url taobao.com,shopee.sg
```

The grouping helper includes every matching tab, not just the first match for
each pattern. Native grouping still requires the handoff extension; CDP alone
cannot access tab groups. For task-scoped research, group the tabs immediately
after opening them, keep a ledger of the tabs opened by the task, and close
those tabs before handoff; then ungroup the now-empty group. Never use a broad
URL pattern that could match the user's pre-existing tabs. If a tab is claimed
or protected, leave it open and report it rather than force-closing it.

`cdp ext api` is the one that keeps this honest: it dots into the `chrome`
namespace at runtime, so a permission added to the manifest is immediately
callable without touching the CLI. `cdp ext apis` lists what is genuinely
reachable, which turns "did I typo it or is the permission missing?" into a
question you can answer.

`cdp ext eval` takes any expression; a promise is awaited and the result comes
back as JSON. That is the escape hatch — reach for the named subcommands when
they fit and `eval` when they do not.

This needs the extension loaded (`chrome://extensions` -> Developer mode ->
Load unpacked -> `extension/`). Without it you get a message saying so rather
than a confusing failure. MV3 terminates idle service workers, so the
extension keeps a 30s alarm heartbeat and `cdp ext` retries a few times before
declaring it absent.

**The extension stays loopback-only on purpose.** `host_permissions` is pinned
to `127.0.0.1` and `localhost`, and `debugger` is refused; a test enforces
both. None of the APIs above need host access, so broad host permissions would
buy nothing and cost a great deal of trust.

## Tabs and claims

Multiple agents share one browser, so tabs are claimed. Any mutating command
auto-claims the tab it touches for 15 minutes. Another agent touching a claimed
tab is refused by name and can override with `--steal`.

```bash
cdp open https://example.com --browser dia
cdp open https://example.com --browser dia --anonymous
cdp tabs --browser dia            # shows [claude-code (3m ago)] on claimed tabs
cdp claims
cdp release <tab> --browser dia   # or: cdp release --mine
cdp close <tab> --browser dia
cdp wake <tab> --browser dia      # revive a tab suspended by memory saver
cdp status --browser dia          # daemon state
cdp stop --browser dia            # stop the daemon for that port
```

Use `--anonymous` for signed-out and clean-session testing. It opens a temporary
isolated browser context with none of the profile's cookies or site storage, so
it does not sign the human out or alter their ordinary tabs. `cdp tabs` labels
the tab anonymous, and `cdp close` disposes the entire temporary context. This
is isolation, not an authentication bypass: complete the site's normal login
and consent flow when required.

## MCP tools

Same capabilities, typed. Register once:

```bash
# Claude Code
claude mcp add browser -- node ~/.agents/skills/chrome-cdp/mcp/server.mjs

# Codex
codex mcp add browser -- node ~/.agents/skills/chrome-cdp/mcp/server.mjs
```

Tools: `browser_list`, `browser_tabs`, `browser_open`, `browser_close`,
`browser_read`, `browser_navigate`, `browser_wait`, `browser_act`,
`browser_screenshot`, `browser_diagnostics`, `browser_eval`,
`browser_annotations`, `browser_marks`, `browser_annotate_mode`,
`browser_record`, `browser_recording`.

`browser_act` takes one action or a `steps` array that runs in order and stops
at the first failure. Screenshots return inline images to clients that render
them and always include the saved path, so Codex can read the PNG itself.

## Architecture

```
lib/discovery.mjs   which browsers are debuggable, and how to enable the rest
lib/daemon.mjs      one master daemon per port: browser WS, sessions, event buffers
lib/claims.mjs      advisory tab ownership across agents
lib/anonymous.mjs   contexts created by --anonymous, for safe whole-context cleanup
lib/state.mjs       human-set state: tab aliases and marks
lib/refs.mjs        the page snapshot and ref resolution
lib/ops.mjs         every operation, one function each
lib/overlay/        the annotation overlay, shared verbatim with the extension
lib/annotations.mjs the annotation queue
lib/recorder.mjs    recording lifecycle    lib/recstore.mjs  where recordings live
lib/bridge.mjs      loopback HTTP: tray page, video annotator, extension endpoint
lib/pages/          tray and video-annotator pages
bin/cdp.mjs         CLI frontend        mcp/server.mjs   MCP frontend
hooks/              Claude Code UserPromptSubmit hook
extension/          wraps the same overlay; adds a popup and browser shortcuts
```

A daemon per port holds one browser WebSocket, so Chrome's "Allow remote
debugging?" prompt fires once per session rather than per command, and console
and network events survive between invocations. It reconnects across a browser
restart and exits after 30 minutes idle.

## Tests

```bash
cd ~/.claude/skills/chrome-cdp && npm test
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

- Only loaded tabs appear in `cdp tabs`. A tab discarded by memory saver needs
  `cdp wake` (or a click in the browser) before it responds.
- Screenshots are native resolution: CSS px = image px / DPR, and `shot` prints
  the DPR.
- `cdp type` inserts text at the current focus and works inside cross-origin
  iframes, where `eval` cannot reach.
- Element refs come from one snapshot. If the page re-renders (a modal opens, a
  list reorders), read again before acting.
- The overlay and the recorder refuse to install twice, so after changing
  either, use `cdp overlay <tab> --force` or start a fresh recording rather
  than expecting a silent upgrade.
- A daemon started before a code change keeps running the old logic. Clients
  compare a code version on connect and restart a stale daemon, which is why
  you may see "restarting the daemon" after editing `lib/`.
- Screen recording needs the macOS permission once, granted to whatever runs
  ffmpeg.

# Tabs and the browser: claims, the human, profiles, browser-level control, the extension

Part of the [browserctrl skill](../SKILL.md).

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
browserctrl tray --browser dia          # prints the tray URL: a page listing every tab with a checkbox each
browserctrl marks --browser dia
browserctrl read marked --browser dia   # the agent resolves the handover
```

The tray is served by the local bridge, which needs a per-install token. The URL that
`browserctrl tray` prints carries it (`http://127.0.0.1:17222/tray?t=...`), so open that URL
rather than typing the address. The token lives in the private runtime folder
(`browserctrl where`).

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
Load unpacked -> the install folder's `extension/`). Without it you get a message saying so rather
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
`BROWSERCTRL_AGENT_ID` (`CDP_AGENT_ID` still works) for CLI/Python, or pass `agentId` on MCP
browser calls. Keep that identity across the agent's calls. Sibling agents must not inherit the
same ID. Without an override, the client uses the harness session ID (Codex, Claude Code),
then the parent process ID. A claim whose owner process has exited counts as released.

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

```bash
browserctrl open https://example.com --browser dia
browserctrl open https://example.com --browser dia --anonymous
browserctrl tabs --browser dia            # shows [claude-code (3m ago)] on claimed tabs
browserctrl claims
browserctrl release <tab> --browser dia   # or: browserctrl release --mine
browserctrl close <tab> --browser dia
browserctrl focus <tab> --browser dia     # select the tab without reloading
browserctrl wake <tab> --browser dia      # render in the background without selecting
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

### Browser profiles

One debug port serves every profile of that browser (Work, Personal, ...).
Profile names come from the browser's `Local State`, found from the running
process, so `--user-data-dir` instances and explicit `--port`s work too.

```bash
browserctrl profiles --browser chrome
# Default      Work                     12 tabs  [default: new tabs land here]
# Profile 1    Personal                 no window
browserctrl tabs --browser chrome                       # profile column per tab
browserctrl tabs --profile work --browser chrome        # only that profile's tabs
browserctrl open https://example.com --profile Personal --browser chrome
```

`--profile` takes the directory, the account email, the display name, or a unique name prefix; an
ambiguous or unknown one fails with the list. MCP: `browser_profiles`, and a
`profile` argument on `browser_tabs` and `browser_open`.

CDP names no profile, so each one is identified once per browser launch by
loading `chrome://version` in a brief background tab inside it and reading its
Profile Path (cached per port). Expect that tab to flash in each profile's tab
strip on the first `tabs`/`profiles` call; single-profile browsers skip it.
`open` in a profile with tabs opens a background tab there; this makes it the
browser's last-used profile. A profile with no window is opened by launching
the browser app with `--profile-directory` (macOS `open -na`), which raises a
new window in it; this needs a local browser process, not a forwarded port.

## The extension

`extension/` (inside the install folder that `browserctrl where` prints) is loaded unpacked from
`chrome://extensions` (Developer mode). The bridge accepts the extension by its fixed id, so
if you loaded it before this id was fixed, remove it and load it again.
Its toolbar click is the primary path: it immediately enters annotation mode.
It also provides browser-level shortcuts (option+A annotate, option+M hand over
this tab), and a right-click toolbar menu for the less-common whole-tab and
multi-tab handoffs. After saving a note, send “review my browser handoff” in
the agent task. If the bridge is temporarily unavailable, the extension retains
the note and retries it rather than falsely confirming it.
It carries no annotation logic: `extension/annotate.js` is a verbatim copy of
`lib/overlay/annotate.js`, refreshed with `npm run sync-extension`, and a test
fails if the two drift.

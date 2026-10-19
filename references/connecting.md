# Connecting: the shared connection, browsers, Safari, diagnostics

Part of the [browserctrl skill](../SKILL.md). Project source and issues:
[seahyc/browserctrl](https://github.com/seahyc/browserctrl). Folders and settings:
[settings.md](settings.md); `browserctrl where` prints the install and data folders.

## Safari and platform selection

Select the browser explicitly. Chromium uses the existing CDP commands on macOS,
Linux and Windows. Windows uses named pipes and a PowerShell lock adapter, not
AppleScript. Relaunching the real profile and screen video remain macOS-only; on Linux and
Windows `browserctrl launch` starts a separate profile instead. Firefox is not supported. See
[compatibility and test evidence](../docs/compatibility.md) before promising support.

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
stable `BROWSERCTRL_AGENT_ID` for CLI workflows or `agentId` on every shared MCP call.
Release your claims at handoff. The MCP `browser_safari` tool supports `tools`,
`call`, `status` and `stop`; common browser tools also route supported operations
when `browser="safari"`. Unsupported operations fail explicitly. Python's
`ChromeCDP` client, tab grouping, dormant Dia tabs, recording, uploads and raw CDP
remain Chromium-only. Safari reload schedules `location.reload()` once through native JavaScript
evaluation and observes the new document. It is an adapter helper, not a direct
Apple MCP reload tool. Safari `focus` and `wake` both select the automation
context through `switch_tab`; normal Safari window foregrounding is not
guaranteed. Safari creates an automation session; do not assume access
to the user's existing Safari tabs or signed-in state. Verify background behavior
against a disposable page before offering an unattended workflow.

## Start here: reuse the shared connection

For every browser action, use the `browserctrl` CLI, the MCP server, or the SDK. They share
one daemon connection per browser. Do not create direct WebSocket clients or use
Playwright `connect_over_cdp` against the signed-in browser: those bypass the pool
and can trigger a fresh debugging approval for each connection.

1. Select Dia explicitly with `--browser dia` or MCP `browser: "dia"` when using
   the user's Dia session.
2. Choose one unique identity for this agent and keep it across all calls:
   `BROWSERCTRL_AGENT_ID` for CLI/Python, or `agentId` for MCP. With none set, the
   harness session id (Codex, Claude Code) or the parent process stands in, and a claim
   whose owner process has gone counts as released. Give sibling agents
   different identities, even when they share one MCP server.
3. Before bulk browsing, describe the work and its progress with `activity describe`.
   Read [activity and background readiness](activity.md) for status,
   pause/resume controls, and readiness checks. Open a background tab per agent
   and keep its returned tab ID. For an existing
   user-designated tab, read it first and respect its claim. See
   [Tabs and claims](tabs-and-browser.md#tabs-and-claims) for ownership and handoffs.
4. Keep the shared daemon running between actions and at task completion.
   Release your claims when finished. Do not stop the daemon, restart Dia, or
   open a direct connection to recover from a timeout. Observe current state
   through the pooled client before deciding whether to retry an action.
5. If approvals repeat, run `doctor --browser dia --watch-seconds 20` and inspect
   callers before changing the connection. See
   [Repeated debugging approvals](#repeated-debugging-approvals).

For CLI use, set `BROWSERCTRL_AGENT_ID` to your unique task identity on every invocation
(or export it once in a persistent shell), then run:

```sh
browserctrl tabs --browser dia
```

One initial approval or a new approval after browser reconnection can still be
required. The pool cannot suppress approvals from clients that bypass it.

For a task on a page (search, filter, open, read a list), send the whole plan in one
`browserctrl do` call: see [Fastest way through a task](reading-and-acting.md#fastest-way-through-a-task).

Two frontends over one core:

- **CLI**: `browserctrl <command>` (`bin/browserctrl.mjs`)
- **MCP server**: `browserctrl-mcp` (`mcp/server.mjs`), exposing `browser_*` tools to any MCP client

Prefer the MCP tools when they are available in your session: screenshots come back
inline, and `browser_do` / `browser_items` are the same `do` and `items` as the CLI.
The CLI is the fallback and the debugging surface.

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

On Linux and Windows, `browserctrl launch <browser>` never touches a running browser. It finds the
program (set `BROWSERCTRL_<BROWSER>_BIN`, for example `BROWSERCTRL_CHROME_BIN`, if it cannot), and
starts a separate instance on its own profile in the data folder (`profiles/<browser>`), or in
`--user-data-dir <dir>`, with the debug port on. If something already answers on that port,
nothing is started. Do the same by hand with
`--remote-debugging-port=9222 --user-data-dir=<a new folder>`, then use `--port 9222`.

## Tests

From a clone of the repository (see [CONTRIBUTING.md](../CONTRIBUTING.md)):

```bash
npm test
```

The suite drives a throwaway headless browser with its own user-data-dir, so it never
touches a real profile, and every test gets its own `BROWSERCTRL_HOME`. It also checks that
every command documented here exists in the CLI.

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

## Opt-in lifecycle diagnostics

Set `BROWSERCTRL_DIAGNOSTIC_LOG=/absolute/local/path.jsonl` when starting a fresh daemon.
The diagnostic writer records command names, lifecycle IDs, replies and disconnects;
it excludes URLs, page content, scripts, headers, cookies and error messages.
The log stops growing at 10 MiB. Existing daemons retain their startup environment.
This is diagnostic evidence, not proof that a browser workflow is healthy.

### Repeated debugging approvals

First verify the caller follows [Start here](#start-here-reuse-the-shared-connection).
An old MCP server must be reloaded to pick up code changes, or use a fresh CLI process.

`doctor` now reports existing TCP clients and executable ancestry using passive
OS inspection. TCP observation alone cannot distinguish HTTP discovery from a
debugging WebSocket or count approval dialogs. Doctor excludes its own HTTP
discovery connection. `browserctrl doctor --browser dia --watch-seconds 20` saves a bounded
incident capture (maximum 60 seconds). It does not open a debugging connection,
start a daemon, or install a recurring check. Very short connections can be
missed; an empty capture does not prove there were no prompts. The normal doctor
health check uses an existing daemon connection when available.

Daemon lifecycle logs are enabled by default in the `telemetry` folder of the data folder
(`browserctrl where`); override with `BROWSERCTRL_TELEMETRY_DIR`, or disable
lifecycle logging with `BROWSERCTRL_TELEMETRY=0`. Logs contain connection lifecycle,
request timing and protocol method metadata, with hashed agent identities; no
page content, URLs, JavaScript, parameters, cookies, or full process arguments.
Logs rotate and incident captures retain the latest 20 files, at most 1 MiB each.
Capture is explicit and still works when lifecycle logging is disabled. Existing
daemons pick up logging on their next replacement; historical connections are
not reconstructed. A missing stop record may indicate an abrupt exit, but does
not by itself prove a crash. Keep a capture when reporting repeated prompts.

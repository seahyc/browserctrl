# Architecture: MCP tools, the daemon, the Python client

Part of the [browserctrl skill](../SKILL.md): these sections moved here whole from the skill file.

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
`browser_reload`, `browser_do`, `browser_items`, `browser_visit`, `browser_act`,
`browser_screenshot`, `browser_diagnostics`, `browser_eval`,
`browser_annotations`, `browser_marks`, `browser_annotate_mode`,
`browser_record`, `browser_recording`, `browser_activity`,
`browser_recipe`, `browser_captcha`, `browser_profiles`.

`browser_refresh` remains an alias for `browser_reload`. `browser_wake`
(`off=true` to stop), `ops.wake(conn, tab, {enabled})` and the Chromium Python
client's `client.wake(tab, off=False)` render a tab in the background without
selecting it. The SDK uses `ops.focus` and `ops.reload`, with `ops.refresh` as an
alias. The Python client exposes `client.focus(tab)` and
`client.reload(tab, wait_until='load', timeout=None)`; `client.refresh` is an alias.

`browser_act` takes one action or a `steps` array that runs in order and stops
at the first failure. Screenshots return inline images to clients that render
them and always include the saved path, so Codex can read the PNG itself.

## Architecture

```
lib/discovery.mjs   which browsers are debuggable, and how to enable the rest
lib/daemon.mjs      one master daemon per port: browser WS, sessions, event buffers
lib/claims.mjs      atomic tab ownership leases across agents
lib/anonymous.mjs   contexts created by --anonymous, for safe whole-context cleanup
lib/profiles.mjs    browser profiles: Local State names, context -> profile probes, open in a profile
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

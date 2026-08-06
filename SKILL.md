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

## Read before you act

`cdp read` snapshots the page into `ref_1..ref_N` with roles, accessible names
and test ids, plus the visible text. Act on refs, not on guessed selectors.

```bash
cdp tabs --browser dia
cdp read a1b2c3d4 --browser dia
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
```

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
cdp text <tab>                         # visible text only
cdp html <tab> [selector]
cdp eval <tab> "location.href"
```

Console and network are buffered by the daemon from the moment it attaches to
a tab, so reload after attaching if you need the events from page load.

## Tabs and claims

Multiple agents share one browser, so tabs are claimed. Any mutating command
auto-claims the tab it touches for 15 minutes. Another agent touching a claimed
tab is refused by name and can override with `--steal`.

```bash
cdp open https://example.com --browser dia
cdp tabs --browser dia            # shows [claude-code (3m ago)] on claimed tabs
cdp claims
cdp release <tab> --browser dia   # or: cdp release --mine
cdp close <tab> --browser dia
cdp wake <tab> --browser dia      # revive a tab suspended by memory saver
cdp status --browser dia          # daemon state
cdp stop --browser dia            # stop the daemon for that port
```

## MCP tools

Same capabilities, typed. Register once:

```bash
# Claude Code
claude mcp add browser -- node ~/.claude/skills/chrome-cdp/mcp/server.mjs

# Codex: ~/.codex/config.toml
# [mcp_servers.browser]
# command = "node"
# args = ["/Users/<you>/.claude/skills/chrome-cdp/mcp/server.mjs"]
```

Tools: `browser_list`, `browser_tabs`, `browser_open`, `browser_close`,
`browser_read`, `browser_navigate`, `browser_wait`, `browser_act`,
`browser_screenshot`, `browser_diagnostics`, `browser_eval`.

`browser_act` takes one action or a `steps` array that runs in order and stops
at the first failure. Screenshots return inline images to clients that render
them and always include the saved path, so Codex can read the PNG itself.

## Architecture

```
lib/discovery.mjs   which browsers are debuggable, and how to enable the rest
lib/daemon.mjs      one master daemon per port: browser WS, sessions, event buffers
lib/claims.mjs      advisory tab ownership across agents
lib/refs.mjs        the page snapshot and ref resolution
lib/ops.mjs         every operation, one function each
bin/cdp.mjs         CLI frontend        mcp/server.mjs   MCP frontend
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

## Gotchas

- Only loaded tabs appear in `cdp tabs`. A tab discarded by memory saver needs
  `cdp wake` (or a click in the browser) before it responds.
- Screenshots are native resolution: CSS px = image px / DPR, and `shot` prints
  the DPR.
- `cdp type` inserts text at the current focus and works inside cross-origin
  iframes, where `eval` cannot reach.
- Element refs come from one snapshot. If the page re-renders (a modal opens, a
  list reorders), read again before acting.

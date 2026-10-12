# Browser and platform compatibility

Evidence collected on 2026-10-12. These are capability checks, not a comparative performance benchmark.

| Browser/platform | Result | Scope |
| --- | --- | --- |
| Dia, macOS | Live session tested | Native inventory includes dormant tabs. Live extension inspection, group collapse, duplicate-tab closure, and refusal to move a claimed tab were verified. A browser restart restored a group expanded, so its collapse state needed restoring. |
| Chrome, macOS | Integration tests run; see [raw summary](chrome-test-results.json) | Owned headless profile only. The first run passed 18 of 22 tests and hit timeouts plus subsequent isolation failures on a heavily loaded host. No claim of seamless reliability from this run. |
| Chrome-family Chromium, Linux | [Full CI passed](https://github.com/seahyc/browserctrl/actions/runs/38226804230) | Ubuntu, Node 22 and 24: 223 Node tests passed, 4 platform/optional tests skipped, zero failures; all 15 Python tests passed. Includes isolated-browser input, screenshots, waits, ten-agent concurrency, and shared activity controls. |
| Safari 27.0.1, macOS | Live local fixture tested | Official MCP discovery and an owned local fixture tab were verified. See the [fixture results](safari-test-results.json). Protocol tests cover serialized tab selection, claims, failed switches and shutdown protection. Typing and clicking changed the local fixture while Finder was active and while a normal Safari window was selected; document.hasFocus() stayed false. A foreign agent was refused. A background screenshot returned a dark image, so screenshot rendering is not verified. |
| Chrome-family Chromium, Windows | [Full CI passed](https://github.com/seahyc/browserctrl/actions/runs/38226804230) | Node 22 and 24: 209 Node tests passed, 18 platform/optional tests skipped, zero failures; all 15 Python tests passed. Includes named pipes, kernel mutex locking, process identity, browser input, CLI/Python/MCP activity controls, and screenshots on an active owned target. Background capture workarounds were inconsistent, so these results do not establish seamless background screenshot support. |

## Dia boundaries

Page snapshots, input, waits, shared connections, tab claims, and extension APIs use the Chromium CDP core. Dia is not required for those operations. Native dormant-tab inventory, exact native selection, and guarded native private-window cleanup use the isolated macOS Dia adapter.

The optional extension's tab-group APIs are Chromium APIs, not Dia-specific. Chrome can use them after loading the extension, but extension grouping in Chrome has not yet been tested here. Dormant tabs absent from both CDP and the extension require the Dia native adapter. Do not infer that Chrome or another browser has the same dormant-tab behavior.

Browser profile discovery supports macOS, Linux and Windows. Automatic relaunch remains macOS-only; elsewhere enable debugging or start an owned profile, then select `--browser` at its configured port or `--port` explicitly. Screen-video capture uses macOS-specific APIs; screenshots use CDP.

## Safari boundaries

Safari does not implement browserctrl's CDP transport. Its WebDriver and official MCP tools are separate protocols. The Safari adapter keeps one official MCP process, serializes current-tab selection and actions, and checks cooperating-agent claims. Common page operations and Apple native tool calls are supported. Chromium groups, dormant Dia tabs, recording, uploads and raw CDP are not supported. Safari automation uses a separate session; it does not imply access to the normal signed-in profile. Background behavior depends on Safari and must be tested separately.

Sources: [Chrome debugging changes](https://developer.chrome.com/blog/remote-debugging-port), [Safari MCP introduction](https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/).

## Upstream comparison

Compared with `pasky/chrome-cdp-skill` main at `ffea76a24b0471663ddd9d9f24335bbc442b6266`, browserctrl adds one shared connection per browser port, cooperating-agent claims, richer snapshots and actions, a typed MCP frontend, a persistent Python client, bounded batches/workflows, optional browser-level extension APIs, and Dia native adapters.

Upstream is smaller, requires no npm dependencies for its CLI, and documents Chrome-family discovery on macOS, Linux, and Windows. browserctrl has broader workflow and coordination features, and now includes a Windows pipe and lock adapter. We have not run an equivalent upstream-vs-browserctrl latency or reliability benchmark, so there is no defensible percentage improvement.

## Latest verified implementation

[Commit 42cc696](https://github.com/seahyc/browserctrl/commit/42cc69601305917f7ca237cce0c178ebe7640992) passed the complete [Linux/Windows Node 22/24 CI matrix](https://github.com/seahyc/browserctrl/actions/runs/38226804230). Linux tests use an owned disposable browser profile and an explicit test-only sandbox setting for the hosted runner. Normal browserctrl commands do not change the browser sandbox.

The tested implementation also passed a dependency audit with zero reported vulnerabilities. Earlier local Google Chrome testing encountered timeouts on a heavily overloaded host. The final local Chrome page suite passed all 18 tests, and an additional owned-browser integration passed background readiness, rapid-navigation warnings, CLI/Python activity, MCP pause, independent owners, claim preservation, resume without replay and focus cleanup while paused. These results do not establish reliability for every signed-in desktop profile under load.

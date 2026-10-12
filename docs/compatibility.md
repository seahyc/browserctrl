# Browser and platform compatibility

Evidence collected on 2026-10-12. These are capability checks, not a comparative performance benchmark.

| Browser/platform | Result | Scope |
| --- | --- | --- |
| Dia, macOS | Live session tested | Native inventory includes dormant tabs. Extension inventory confirmed 22 application/preparation tabs in the Reference group. Collapse state needed restoring after a browser restart. Background grouping/closing honors other owners' claims. |
| Chrome, macOS | Integration tests run; see [raw summary](chrome-test-results.json) | Owned headless profile only. The first run passed 18 of 22 tests and hit timeouts plus subsequent isolation failures on a heavily loaded host. No claim of seamless reliability from this run. |
| Chrome, Linux | CI configured; result pending | Full Node suite and Python tests on Ubuntu with Node 22/24 and an isolated Chrome profile. See GitHub Actions for the actual run status. |
| Safari 27.0.1, macOS | browserctrl unsupported; Apple's MCP discovery tested | `/usr/bin/safaridriver --mcp` connected and exposed its tools. Creating a fixture tab was refused because Safari's Allow remote automation setting is disabled. No Safari page-action or browserctrl integration pass is claimed. |
| Windows | Unsupported | The daemon currently uses Unix sockets and macOS/Linux kernel file locking. A Windows adapter is needed. |

## Dia boundaries

Page snapshots, input, waits, shared connections, tab claims, and extension APIs use the Chromium CDP core. Dia is not required for those operations. Native dormant-tab inventory, exact native selection, and guarded native private-window cleanup use the isolated macOS Dia adapter.

The optional extension's tab-group APIs are Chromium APIs, not Dia-specific. Chrome can use them after loading the extension, but extension grouping in Chrome has not yet been tested here. Dormant tabs absent from both CDP and the extension require the Dia native adapter. Do not infer that Chrome or another browser has the same dormant-tab behavior.

Browser discovery and launch currently use macOS app paths. Linux callers should start their own browser with an explicit debugging port and use `--port`. Screen-video capture uses macOS-specific APIs; screenshots use CDP.

## Safari boundaries

Safari does not implement browserctrl's CDP transport. Its WebDriver and official MCP tools are separate protocols. A future Safari adapter could translate shared page operations, but it would also need ownership and recovery semantics, and capability flags for grouping, dormant tabs, recording, and background behavior. None of that is implemented by this release.

Sources: [Chrome debugging changes](https://developer.chrome.com/blog/remote-debugging-port), [Safari MCP introduction](https://webkit.org/blog/18136/introducing-the-safari-mcp-server-for-web-developers/).

## Upstream comparison

Compared with `pasky/chrome-cdp-skill` main at `ffea76a24b0471663ddd9d9f24335bbc442b6266`, browserctrl adds one shared connection per browser port, cooperating-agent claims, richer snapshots and actions, a typed MCP frontend, a persistent Python client, bounded batches/workflows, optional browser-level extension APIs, and Dia native adapters.

Upstream is smaller, requires no npm dependencies for its CLI, and documents Chrome-family discovery on macOS, Linux, and Windows. browserctrl has broader workflow and coordination features, but does not currently match upstream's Windows support. We have not run an equivalent upstream-vs-browserctrl latency or reliability benchmark, so there is no defensible percentage improvement.

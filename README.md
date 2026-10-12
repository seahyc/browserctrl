# browserctrl

Control a running Chromium browser from the terminal or an MCP client. `browserctrl` connects to browser sessions you already have open, snapshots pages into readable element references, and sends actions through the Chrome DevTools Protocol (CDP).

The project is developed and tested on macOS. Chrome, Dia, Brave, Edge, Chromium, and Arc are recognized there; Dia's native dormant-tab and tab-group controls are macOS-specific. Linux CDP use with an explicitly configured debugging port is possible, but is not yet presented as a tested platform. Windows and Safari are not supported by browserctrl. Safari 27's separate official MCP integration is outside this project.

## Install

Requirements: Node.js 22 or newer. Clone the repository and install its pinned dependencies:

```sh
git clone https://github.com/seahyc/browserctrl.git
cd browserctrl
npm ci
```

Run the CLI from the checkout with `node bin/browserctrl.mjs`. To make the commands available on your `PATH`, run `npm link`; this provides `browserctrl`, plus the compatibility commands `cdp` and `browserctl`. For an agent that loads skills from `~/.agents/skills`, clone or link this repository as `~/.agents/skills/browserctrl` and invoke `$browserctrl`.

The MCP server uses the installed dependency. Configure your MCP client to start `node /absolute/path/to/browserctrl/mcp/server.mjs` from this checkout.

## Connect a browser

Select the browser explicitly; browserctrl has no default browser:

```sh
browserctrl browsers
browserctrl tabs --browser chrome
browserctrl open https://example.com --browser chrome
```

On macOS, enable Chrome remote debugging for the existing profile in `chrome://inspect/#remote-debugging`, then run `browserctrl browsers` again. Recent Chrome versions may reject command-line debugging flags for an existing profile. For a separate clean profile, launch Chrome with a debugging port and a dedicated user-data directory, for example:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir=/tmp/browserctrl-chrome
```

Use `--port <n>` instead of `--browser <name>` for a custom endpoint. Do not point a disposable test at a profile containing data you need.

## Read, then act

Take a fresh page snapshot and use its `ref_` identifiers for actions:

```sh
browserctrl read <tab-id> --browser chrome
browserctrl click <tab-id> --ref ref_2 --browser chrome
browserctrl fill <tab-id> --ref ref_3 --value "Example" --browser chrome
browserctrl wait <tab-id> --text "Saved" --browser chrome
```

Refs are invalidated by navigation and by the next snapshot. Take another snapshot when the page changes. If a command times out or the connection drops during an action, its outcome may be uncertain; browserctrl does not replay that action. Observe the page before deciding whether to try again.

## What it does

browserctrl pools commands through one long-lived daemon per browser port. That connection can retain console and network events across CLI calls. Tab claims coordinate cooperating agents: a claim expires after 15 minutes unless renewed. Claims do not isolate browser data or protect against other tools that bypass browserctrl.

| Capability | Upstream `pasky/chrome-cdp-skill` | `seahyc/browserctrl` |
| --- | --- | --- |
| Connection model | Persistent daemon per tab; 20-minute idle exit, as documented upstream | Shared daemon per browser port; long-lived while in use |
| Coordination | Target selection by tab ID | Per-tab claims, snapshot refs, and named workflows |
| Interfaces | CLI skill | CLI and MCP server over the same core |
| Browser-level workflows | CDP page control | Optional unpacked extension for extension APIs and tab groups; Dia native tab controls on macOS |
| Platform status | Upstream documents Chrome-family detection on macOS, Linux, and Windows | Developed and tested on macOS; Linux with an explicit port is possible, with compatibility results tracked separately |

This comparison describes documented scope, not a performance benchmark. See [compatibility results](docs/compatibility.md) for platform-specific evidence as it becomes available.

The optional extension must be loaded as an unpacked extension from `extension/` in a supported Chromium browser. Extension-backed operations are unavailable without it. CDP page control continues to work without the extension.

For complete command usage, run `browserctrl help`. For bug reports and contributions, see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports are covered in [SECURITY.md](SECURITY.md).

## Attribution and license

browserctrl began as a fork of [pasky/chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill) by Petr Baudis. The upstream project and this project are MIT-licensed; see [LICENSE](LICENSE) for the retained license and copyright notices.

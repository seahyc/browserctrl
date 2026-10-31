# Settings

Every setting is an environment variable named `BROWSERCTRL_<NAME>`. The older
`CDP_<NAME>` spelling is still read when the new one is not set. An empty value counts
as unset. A flag is off when its value is `0`, `false`, `off` or `no`, and on for any
other value. Settings are read from the environment of the process that runs the
command.

Most people set none of these. The ones worth knowing are `BROWSERCTRL_BROWSER` or
`BROWSERCTRL_PORT`, `BROWSERCTRL_AGENT_ID` and `TYPESAFE_API_KEY`.

## Which browser and which agent

| Name | Default | What it does |
| --- | --- | --- |
| `BROWSERCTRL_BROWSER` | none | Browser every command uses when it has no `--browser` (`dia`, `chrome`, `brave`, `edge`, `chromium`, `arc`, `safari`, `firefox`, `camoufox`). |
| `BROWSERCTRL_PORT` | none | Debug port every command uses when it has no `--port`. Wins over `BROWSERCTRL_BROWSER`. |
| `BROWSERCTRL_AGENT_ID` | `pid:<parent pid>` | Identity that owns tab claims. Keep one per agent task. A claim whose owner process is gone counts as released. |
| `BROWSERCTRL_AGENT_LABEL` | `codex`, `claude-code` or `shell` | Name shown for the agent in `browserctrl activity`. |
| `BROWSERCTRL_<BROWSER>_BIN` | found in the usual install places, then PATH (Linux `chromium`: then Playwright's builds) | Path to a browser program for `browserctrl launch`, for example `BROWSERCTRL_CHROME_BIN`, `BROWSERCTRL_FIREFOX_BIN` or `BROWSERCTRL_CAMOUFOX_BIN`. |
| `BROWSERCTRL_FIREFOX_PORT` | 9337 | WebDriver BiDi port for `--browser firefox` when no `--port` is given. |
| `BROWSERCTRL_CAMOUFOX_PORT` | 9338 | WebDriver BiDi port for `--browser camoufox` when no `--port` is given. |
| `BROWSERCTRL_BIDI_IDLE_MS` | 600000 | How long the WebDriver BiDi daemon for a port keeps its session with no requests before it exits. |
| `BROWSERCTRL_BIDI_DEBUG` | off | Set to 1 to print each WebDriver BiDi call and its time to stderr (method names only, no arguments). |

There is no default browser. See [connecting.md](connecting.md).

## Folders

`browserctrl where` prints the install folder and the four folders below.

| Name | Default | What it does |
| --- | --- | --- |
| `BROWSERCTRL_HOME` | per OS, see below | Puts data, config, state and runtime in one folder (runtime in its `run` subfolder). Tests and throwaway runs use it. |
| `BROWSERCTRL_NOTES_DIR` | `<data>/notes` | Flow notes. |
| `BROWSERCTRL_TRACES` | `<data>/traces` | Traces of `do` plans. |
| `BROWSERCTRL_REC_DIR` | `<data>/runs` | Output folder for `rec start`. |
| `BROWSERCTRL_EXEMPLARS` | `<data>/exemplars` | Captured request examples used by recipes. |
| `BROWSERCTRL_TELEMETRY_DIR` | `<data>/telemetry` | Connection lifecycle logs. |
| `BROWSERCTRL_RECORDING` | `<data>/recording.json` | File that remembers `trace on\|off` and `capture on\|off`. |
| `BROWSERCTRL_RECIPES` | `<config>/recipes` | Your own recipes. |
| `BROWSERCTRL_TAPS` | `<config>/taps` | Tapped recipe repositories. |
| `BROWSERCTRL_CAPTCHA_PLUGINS` | none | Comma list of captcha solver plugin files, besides those in `<config>/plugins/`. |
| `BROWSERCTRL_JEV_ENV` | `<config>/jev.env` | File holding `TYPESAFE_API_KEY=...`. |
| `BROWSERCTRL_STATE_DIR` | `<state>` | Folder for the prefetch bookkeeping file only. |
| `BROWSERCTRL_COOLDOWN` | `<state>/cooldown.json` | Sites cooling down after a challenge. |
| `BROWSERCTRL_RECIPE_TABS` | `<state>/recipe-tabs.json` | Tabs recipes opened. |
| `BROWSERCTRL_REC_STATE` | `<state>/rec-tabs.json` | Tabs being recorded. |
| `BROWSERCTRL_READ_TOKENS` | `<state>/read-tokens.json` | Bookkeeping for `read`. |
| `BROWSERCTRL_SETTLE_MEMORY` | `<state>/never-complete.json` | Pages that never finish loading. |
| `BROWSERCTRL_SITE_TROUBLE` | `<state>/site-trouble.json` | Sites that stalled. |
| `BROWSERCTRL_PROFILE_CONTEXTS` | `<state>/profile-contexts` | Prefix of the per-port profile cache files (`<prefix>-<port>.json`). |
| `BROWSERCTRL_CLAIMS_FILE` | `<runtime>/claims.json` | Tab claims. |
| `BROWSERCTRL_ACTIVITY_FILE` | `<runtime>/activity-<port>.json` | Activity monitor state. |

Defaults per OS (`<data>`, `<config>`, `<state>`, `<runtime>`):

- **macOS:** `~/Library/Application Support/browserctrl` for data and config, `state`
  inside it, and `/tmp/browserctrl-<uid>` for runtime (a short path, because socket paths
  are short).
- **Linux:** `$XDG_DATA_HOME/browserctrl` (`~/.local/share`), `$XDG_CONFIG_HOME/browserctrl`
  (`~/.config`), `$XDG_STATE_HOME/browserctrl` (`~/.local/state`), and
  `$XDG_RUNTIME_DIR/browserctrl` (else `/tmp/browserctrl-<uid>`).
- **Windows:** `%LOCALAPPDATA%\browserctrl` for data, `state` and `run` inside it, and
  `%APPDATA%\browserctrl` for config.

The runtime folder holds sockets, claims and the bridge token. It is private to your user
(mode 700); a folder someone else made is refused. Folders from earlier versions
(`~/.cdp`, `~/.local/share/browserctrl`, `~/.config/browserctrl`) keep being used where they
are; nothing is moved on its own. `browserctrl migrate` shows what would move to this OS's
folders, and `browserctrl migrate --apply` moves it once you have stopped any older
browserctrl (its agents and daemons). `browserctrl where` shows which folders are in use.

## Jev (TypeSafe)

Jev answers "which control does this step mean?" for names that are not exact. See
[reading-and-acting.md](reading-and-acting.md#jev).

| Name | Default | What it does |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | none | API key for api.typesafe.ai. Read from the environment, else from the Jev env file. Without it, exact names, refs and selectors still work and nothing is sent. |
| `TYPESAFE_MODEL` | `jev-1.14.0` | Model name. Can also be set in the Jev env file. Screenshot grounding always uses pinned `jev-1.14.0`. |
| `BROWSERCTRL_VISION` | `auto` | Screenshot fallback in `do` when text grounding cannot act. `off` disables it. |
| `BROWSERCTRL_JEV_ENV` | `<config>/jev.env` | Another file to read the key from. |
| `BROWSERCTRL_JEV_ENDPOINT` | `https://api.typesafe.ai/v1/systemone` | Another endpoint, for tests or a proxy. |
| `BROWSERCTRL_JEV_LOG` | off | A file. Every Jev call's input and answer is appended, one JSON line each. Images log only their references and byte sizes. |

## Features

| Name | Default | What it does |
| --- | --- | --- |
| `BROWSERCTRL_TRACE` | on | Keep a log of `do` plans. `0` turns it off. Wins over `browserctrl trace on\|off`. |
| `BROWSERCTRL_CAPTURE` | off | Keep fetch/XHR traffic of attached tabs for `recipe endpoints`. `1` turns it on. Wins over `browserctrl capture on\|off`. |
| `BROWSERCTRL_TRACE_MAX_MB` | 50 | Total cap for traces. |
| `BROWSERCTRL_REC_MAX_MB` | 1000 | Total cap for recordings. |
| `BROWSERCTRL_CAPTURE_MAX_MB` | 200 | Total cap for captured traffic. |
| `BROWSERCTRL_NOTES` | `off` | `on` records flow notes and shows them as hints; `quiet` records without hints. |
| `BROWSERCTRL_SHOW` | off | Same as `--show`: bring the tab forward, outline each target, show a panel of steps. |
| `BROWSERCTRL_PREFETCH` | off | `1`: after a call ends on a list, load the first few item links in background tabs for `visit`. |
| `BROWSERCTRL_PREFETCH_REAPER` | on | Close prefetched tabs nobody took (after 90 s). |
| `BROWSERCTRL_TELEMETRY` | off | `1` keeps local connection lifecycle logs (no page data) for debugging daemon restarts, at most 32 files of 1 MB. |
| `BROWSERCTRL_DIAGNOSTIC_LOG` | off | A file. A fresh daemon writes a protocol trace there. |
| `BROWSERCTRL_CLIENT_TIMING` | off | A file (or `stderr`). Each CLI process appends one JSON line saying where its wall time went: startup, reaching the daemon (probes, spawn, upgrade), IPC round trips with the daemon's own share (`prepMs`) of each, and the time after the command (a recording still) until exit. |
| `BROWSERCTRL_READ_WAIT_MS` | 8000 | How long `read`, `text` and `items` wait for a loading page. |
| `BROWSERCTRL_IDLE_EXIT_MIN` | 720 / 60 | Minutes with no client connected before a daemon exits: 720 on a named browser's port (9222 Chrome, 9223 Dia, ...), 60 on any other. It never exits while recording. |
| `BROWSERCTRL_COOLDOWN_MS` | 1200000 | First cool-down after a challenge (20 min; it doubles within a day, up to 2 h). |
| `BROWSERCTRL_REC_STILLS` | on | `off` logs recording steps without taking the per-action still. |
| `BROWSERCTRL_STILL_SETTLE_MS` | 4000 | How long a recording still waits for the page to settle. |
| `BROWSERCTRL_NOTIFY` | on | `0` silences captcha alerts. |
| `BROWSERCTRL_NOTIFY_SOUND` | system sound on macOS | Sound file to play, or `0` for none. |
| `BROWSERCTRL_NOTIFY_CMD` | none | A command run as `<cmd> "<message>"` when a challenge needs you. |

## Bridge (annotation, tray, recordings)

| Name | Default | What it does |
| --- | --- | --- |
| `BROWSERCTRL_BRIDGE_PORT` | 17222 | Port of the local bridge (127.0.0.1 only). |
| `BROWSERCTRL_BRIDGE_IDLE_MIN` | 60 | Minutes idle before the bridge exits. |
| `BROWSERCTRL_BRIDGE_EXTENSION_ID` | the packaged extension id | Comma list of extra extension ids the bridge accepts, for an extension loaded under another id. |

## Video and screen recording

| Name | Default | What it does |
| --- | --- | --- |
| `BROWSERCTRL_CHROME` | `CHROME_BIN`, else found | Chrome used to render replay videos. |
| `BROWSERCTRL_VIDEO_PROXY` | none | Proxy for pages rendered into a video. |
| `BROWSERCTRL_SCREEN_INDEX` | asked from ffmpeg | The macOS screen device for `video` recordings. |
| `BROWSERCTRL_VIDEO_FPS` | 15 | Frame rate of screen recordings. |
| `BROWSERCTRL_VIDEO_CODEC` | `h264_videotoolbox` | Codec of screen recordings. |
| `BROWSERCTRL_VIDEO_BITRATE` | `5M` | Bitrate of screen recordings. |
| `BROWSERCTRL_VIDEO_WIDTH` | 1728 | Width of screen recordings. |

## Python client

| Name | Default | What it does |
| --- | --- | --- |
| `BROWSERCTRL_STDIO` | found | Path to the package's `bin/stdio.mjs`. Otherwise the client looks in the repo it sits in, then the `browserctrl` command on PATH, then `browserctrl where`. |
| `BROWSERCTRL_HELPER_WORKSPACE` | `<data>/helpers` | Folder for helper code and domain notes. |

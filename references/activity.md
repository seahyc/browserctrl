# Activity and background readiness

Read this reference before bulk browsing, when the user asks which agent is
driving a browser, or when repeated navigation interrupts their browsing.

## Describe the work

Keep one stable `BROWSERCTRL_AGENT_ID` across CLI and Python calls. Before a link audit or another bulk task, register a
short description and the expected number of items:

```sh
browserctrl activity describe --intent 'Reviewing guide links' --completed 0 --total 91 --browser dia
browserctrl activity --browser dia
browserctrl activity --browser dia --json
```

Update `--completed` after meaningful milestones. Use a description a person can
understand without opening the agent's chat. Keep URLs, customer names, page
contents and other sensitive details out of `--intent`. Activity descriptions
live in the private local runtime state, not public telemetry.

The list reports owners, intent, progress, claimed tab IDs and warnings about
rapid navigation. These warnings help explain activity; they do not pause an
agent automatically. Ownership identifies the caller, but does not prove that
its workflow is healthy or that the listed page finished loading.

## Wait in the background

For Chromium, wait for the existing page rather than selecting it:

```sh
browserctrl ready <tab> --browser dia --until load --timeout 15000
browserctrl ready <tab> --browser dia --until domcontentloaded --selector '.results' --text 'Results' --url /results
```

`ready` does not activate the tab or reload the page. It accepts `--until load`
or `--until domcontentloaded`, and optional selector, text and URL conditions.
Existing `wait` commands still handle visible elements, text, URL changes and
network idle. Observe the page after a timeout before deciding whether to retry
an action.

Selecting a discarded tab can cause the browser to load it automatically.
`focus` selects a tab without reloading and can revive a page discarded by
memory saver. Use it when that selection or revival is needed. Calling it after every navigation
makes background work visible to the user.

To reload the current URL while keeping the tab in the background, use:

```sh
browserctrl reload <tab> --browser dia --until load --timeout 30000
```

Reload waits for the actual new document. `--until` accepts `load`,
`domcontentloaded`, `networkidle` or `none`. The timeout defaults to 30000
milliseconds. Choose `none` only when a later observation will verify the result.
`ready` observes the existing page; `focus` selects it; `wake` keeps it rendering in
the background without selecting it; `reload` reloads it (`refresh` is the old name and
still works). Focus requires no additional approval flag.

The SDK provides `ops.focus`, `ops.wake` and `ops.reload` (`ops.refresh` is an alias). The persistent
Chromium Python client provides `client.focus(tab)`, `client.wake(tab, off=False)` and
`client.reload(tab, wait_until='load', timeout=None)` (`client.refresh` is an alias).

Safari uses the same `reload` and `refresh` commands in Apple's separate
automation session. The adapter schedules one `location.reload()` through
Safari's JavaScript evaluation tool, then waits for the old document marker to
disappear and for the requested ready state. For `networkidle`, it also waits
for resource counts to remain quiet for 500 milliseconds. Safari has no direct
native MCP reload operation. `focus` and `wake` use native `switch_tab` to select
the automation context; they do not guarantee that a normal Safari window comes
to the foreground. The Chromium `ready` helper does not establish Safari
readiness support.

## Pause and resume an owner

```sh
browserctrl activity pause --owner workbench-guide-review --browser dia
browserctrl activity resume --owner workbench-guide-review --browser dia
```

These activity controls also support `--browser safari`.

Pause rejects subsequent browserctrl actions from that owner, including queued
inputs that have not been sent. It does not cancel an action already sent to
the browser, release claims, or close tabs. Resume permits new actions; it does
not replay rejected actions. Disabling temporary CDP focus emulation remains
allowed for the same owner so a pause cannot prevent cleanup. After resume, the agent should inspect the page
and continue from the observed state.

## Python calls

The persistent Python client supports `client.activity("describe", intent="Review links",
completed=0, total=91)` and the same `list`, `pause`, `resume` actions. Navigation
warnings appear as Python runtime warnings and in `client.last_warnings`.

Finish by reporting the observed page results and progress. Release claims at
handoff as described in the main skill; a progress description does not replace
tab ownership or its cleanup.

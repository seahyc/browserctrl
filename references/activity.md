# Activity and background readiness

Read this reference before bulk browsing, when the user asks which agent is
driving a browser, or when repeated navigation interrupts their browsing.

## Describe the work

Keep one stable `CDP_AGENT_ID` across CLI and Python calls, or supply the same
`agentId` on MCP calls. Before a link audit or another bulk task, register a
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

`wake` selects a tab and can revive a page discarded by memory saver. Use it
when that selection or revival is needed. Calling it after every navigation
makes background work visible to the user.

Safari uses Apple's separate automation session. The Chromium `ready` helper
does not establish Safari readiness support. Use the supported Safari native
operations and verify their results before promising the same wait behavior.

## Pause and resume an owner

```sh
browserctrl activity pause --owner workbench-guide-review --browser dia
browserctrl activity resume --owner workbench-guide-review --browser dia
```

These activity controls also support `--browser safari` and MCP `browser: "safari"`.

Pause rejects subsequent browserctrl actions from that owner, including queued
inputs that have not been sent. It does not cancel an action already sent to
the browser, release claims, or close tabs. Resume permits new actions; it does
not replay rejected actions. After resume, the agent should inspect the page
and continue from the observed state.

## Python calls

The persistent Python client supports `client.activity("describe", intent="Review links",
completed=0, total=91)` and the same `list`, `pause`, `resume` actions. Navigation
warnings appear as Python runtime warnings and in `client.last_warnings`.

## MCP calls

Use `browser_activity` with an explicit browser and caller identity:

```json
{"browser":"dia","agentId":"guide-review","action":"describe","intent":"Reviewing guide links","completed":0,"total":91}
```

`action` accepts `list`, `describe`, `pause` or `resume`. For `pause` and
`resume`, `owner` identifies the agent to control. It is distinct from
`agentId`, which identifies the caller. For background Chromium readiness, use
`browser_wait` with `readyState: "load"` or `"domcontentloaded"` and the explicit
tab target. Preserve the caller identity across all of these operations.

Finish by reporting the observed page results and progress. Release claims at
handoff as described in the main skill; a progress description does not replace
tab ownership or its cleanup.

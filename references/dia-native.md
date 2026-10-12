# Dia native tab control

Use these commands on macOS when `browserctrl tabs --browser dia` omits a dormant tab,
or when you must select and group exact Dia tabs without creating or closing
tabs. This workflow uses Dia's native scripting interface for inventory and
focus, then the loaded handoff extension for tab groups.

The skill and primary CLI are named `browserctrl`. The `cdp` command remains
a compatibility alias.

## Inspect the native inventory

`native-tabs` reads every Dia window and its tabs, including dormant tabs that
do not appear in the CDP tab list. It is read-only and does not foreground Dia.
Record the exact native UUIDs and titles for the intended tabs.

```sh
browserctrl native-tabs --browser dia
```

Native grouping protects claims on the selected tabs and destination group
members, so unrelated page owners can continue. With `--allow-focus`, it also
checks the previously selected tab before restoring it.

Before standalone native focus, check claims across the browser. Do not act on a tab whose
claim belongs to another agent. A native UUID must identify exactly one tab;
the focus command rejects a missing or ambiguous UUID.

```sh
browserctrl claims --browser dia
browserctrl native-focus <native-uuid> --browser dia
```

`native-focus` selects and wakes the exact tab, temporarily bringing Dia to the
foreground. It accepts a full UUID, not a title, URL, CDP tab ID, or shortened
prefix. Re-read the inventory if the UUID is absent or ambiguous.

## Group exact tabs into an existing group

First inspect the extension and its outline. Confirm the handoff extension is
loaded, and use the outline to identify an existing integer group ID. The
outline also lets you verify the tabs and their group membership after the
operation.

```sh
browserctrl ext --browser dia
browserctrl ext outline --browser dia
browserctrl ext api tabGroups.query '[{}]' --browser dia
```

Pass a comma-separated list of exact native UUIDs and the existing integer
group ID. Run the dry run first to see which tabs the selectors resolve to.
It does not focus tabs or change groups.

```sh
browserctrl native-group --ids <uuid-1>,<uuid-2> --group-id <integer> --browser dia --dry-run
```

After confirming that the dry-run output names only the intended tabs, group
them with the same selectors:

```sh
browserctrl native-group --ids <uuid-1>,<uuid-2> --group-id <integer> --browser dia
browserctrl ext outline --browser dia
```

Grouping uses the extension API in the background when the selected native
URL is already available there, including discarded extension tabs. It does
not focus the native tab just to move it. It does not create or close tabs and
collapses the destination group after the batch.

If a tab is absent from the extension inventory, the default command refuses
before moving any tabs. To allow temporary foreground materialization, add
`--allow-focus` explicitly:

```sh
browserctrl native-group --ids <uuid-1>,<uuid-2> --group-id <integer> --browser dia --allow-focus
```

Only this fallback selects native tabs, and it restores the previously
selected tab in a final cleanup step. The result reports `usedFocus` and
`restored`, so background execution and a focus fallback are distinguishable.
If Dia returns the definite "Tab not found for session ID" refusal, the opt-in
fallback can materialize that tab and move its newly observed extension ID.
Timeouts never trigger a mutation replay.

It verifies membership against the current extension session because Dia can
replace Chromium session IDs during a move. On failure, inspect the outline
before retrying; earlier tabs in the batch may already have moved.

If the extension is absent, stop before grouping and load the handoff extension
through its documented installation flow. Do not substitute URL matching for
the UUID selectors in this workflow.

## Adapter boundary

`lib/tab-control.mjs` contains platform-independent planning, background-first
grouping, verification, and optional selection restoration. It receives native
inventory and focus functions from an adapter. `lib/adapters/index.mjs` selects
an available adapter by browser and OS. `lib/adapters/dia-macos.mjs` owns the
`osascript` invocation and Dia scripting dictionary.

Dia's native inventory currently has a macOS adapter only. Other browser and
OS combinations fail with an explicit adapter-unavailable message for native
commands. Ordinary CDP and extension tab operations remain the portable path;
there is no claim that Dia's dormant inventory is available on Windows or Linux.

# Guarded workflow contract

The workflow harness runs a prepared, data-only plan across several browser screens.
It is the multi-screen counterpart to one guarded batch: the host supplies the goal,
field values, branch decisions, expected states, and final success condition; local
code observes each screen, resolves current elements, executes one bounded stage,
and verifies the result. Plans cannot contain JavaScript or selectors.

## Start the persistent runner

From the skill root:

```sh
node bin/workflow.mjs \
  --browser dia --tab EXACT_TAB_ID --origin https://example.com
```

Use `--url` for a new owned tab. The runner creates it at `about:blank`, explicitly
navigates to the requested same-origin URL, and waits for readiness before its first
observation. Existing tabs remain open; owned tabs close on exit unless `--keep-open`
is set. The runner never launches or restarts a browser.

Send newline-delimited commands: `{"command":"observe"}`, `{"command":"run",
"plan":...}`, or `{"command":"close"}`. A plan has a goal, bounded stages, and an
explicit final success condition. Conditions are `textIncludes`, exact `urlEquals`,
`fieldEquals` with a specific target, or a bounded `all` composition.

```json
{"goal":"Prepare the profile review","stages":[{"expect":{"textIncludes":"Profile"},"actions":[{"kind":"fill","target":{"role":"textbox","name":"Display name"},"value":"Ada"},{"kind":"click","target":{"role":"button","name":"Continue"},"after":{"textIncludes":"Review"}}]}],"success":{"textIncludes":"Review"}}
```

Every stage checks its expected state before resolving actions. Each click ends its
stage and requires a URL or text postcondition. After navigation, stage readiness and
final success receive at most two seconds of read-only observation polling within the
overall time budget. No action is retried.

## Targets and semantic selection

Exact targets use observed `role`, `name`, `testid`, or `href`. At least one of
`name`, `testid`, or `href` is required, and the match must be unique. Refs are
resolved afresh on every stage; never put guessed future refs into a plan.

An action may include `semantic` to choose among current candidates matching its
coarse target. This requires explicit `--jev` opt-in and `TYPESAFE_API_KEY`. The
default maximum is four selector attempts per workflow; there are no paid model calls
by default. Jev receives the goal, subgoal, bounded page context, and candidate
roles/names/hrefs, but no candidate field values. Page text is untrusted data and
cannot grant authorization. `selector_attempts` counts calls into the selector;
`model_calls` sums actual provider requests reported by it. Provider cost is `null`
after an actual or unknown request because billing is not inferred; zero means no
provider request was reported.

## Budgets, recovery, and evidence

Defaults are 12 stages, 40 actions, 30 seconds overall, and four semantic selector
attempts. The underlying batch also enforces its own step and time limits. A malformed
later stage rejects the whole plan before any action is dispatched.

On failure, the report includes a category, safe current observation, completed-step
ledger, and `replayed: false`. Recovery refreshes evidence once and never repeats a
possibly delivered mutation. `--failure-shots DIR` adds a mode-0600 screenshot when
capture succeeds. The path only says a screenshot exists: the workflow does not
understand its pixels until an agent actually views the image. Default recovery data
omits field values, though visible page text may still be private.

The workflow is limited to the configured HTTP(S) origin and the guarded batch's
native controls. Custom widgets, uploads, cross-origin frames, browser chrome, and
visual judgments need ordinary browserctrl tools. Same-origin checks and timeouts are
guards, not proof of application success. The overall deadline is checked between
operations; an in-flight CDP request or recovery screenshot can overrun it. Observations
are bounded (400 controls, 4,000 text characters in the public snapshot); missing
context requires a focused fresh observation, not a guessed target. Verify consequential outcomes and backend
state independently when the task requires it.

The runner/navigation pattern was inspired by the public
[jev-browser](https://github.com/vlad-terin/jev-browser) project. This implementation
was designed independently around browserctrl's observations, batch guards, and
recovery contract; code was not copied.

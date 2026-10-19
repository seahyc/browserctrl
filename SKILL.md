---
name: browserctrl
description: Control explicitly selected Chromium browsers or Safari 27+ from the terminal. Use for page automation, browser QA, multi-step research, long forms and multi-screen flows, or tab organization; macOS Dia supports dormant tabs. Safari uses Apple's separate automation session.
---

# browserctrl

Use the `browserctrl` CLI on PATH.
`browserctrl help` lists every command.

## Connect

- **Pick the browser once:** set `BROWSERCTRL_BROWSER` (dia, chrome, brave, edge, chromium, arc)
  or `BROWSERCTRL_PORT`, or pass `--browser` / `--port` per call. No default.
  `browserctrl browsers` lists what is debuggable.
- **One identity per agent:** set `BROWSERCTRL_AGENT_ID` and keep it for the task.
- Use the shared connection: no own WebSocket or Playwright session, and never stop the daemon
  or restart the browser to recover.
- Open your own background tab (`open <url>`), release claims when done, respect others' claims.

## Fastest way through a task

First `browserctrl site <site or URL>`: its recipes (the site's own API) and flow notes.

| The task needs | Use |
| --- | --- |
| Data a recipe covers | the `recipe run` that `site` prints |
| A page whose address you know or can build (search, sort, filter) | `nav`, then `items` or `text` |
| Two or more interactions you can foresee | one `do` with the whole plan and `--then items` |
| Details from several list items | `visit <links> --grep "<label>"` |
| One click, fill or read | the single command: `click <tab> ref_3`, `fill <tab> ref_5 "x"`, `key <tab> Enter` |
| Controls whose names you cannot guess | `read <tab>` once (refs ref_1..N, then page text), then plan |

- Other reads: `items` (lists as i1, i2...), `text [--match re]`, `find "<words>"` (hidden
  controls too), `fields` (what each form field holds).
- A report whose steps all show ✓ did what it says: answer from it, do not re-read. ⚠ means
  check the page. `changed on the page:` says what the plan changed.
- Only the last step commits. Adding to a cart or filling a form is not a commit.
- Options that change after each pick (chips, counts): one pick per `do`.
- "Find one that...": look for a filter or sort first.

## Plan with `do`

```bash
browserctrl do <tab> 'fill "Where" = "Cleveland"' 'key Enter' 'date 2026-10-17' \
  'click "Search"' 'click "Free parking" => "results show parking"' \
  --dismiss "cookie banner" --then items
```

- **Steps:** `click`, `fill <el> = <value>`, `select <el> = <option>`, `hover`, `key Enter`,
  `type "<text>"`, `scroll down|up`, `nav <url>`, `wait <ms>`, `expect <what shows>`,
  `date YYYY-MM-DD` (any calendar; opens the picker if needed, pages months, confirms the
  pick), `set <slider> = <value>` or `= <min>-<max>`. `optional click "Close"` skips when
  absent; `=> "<expected>"` checks the result in the same request.
- **Whole task in one call:** `extract "<what>"` copies the line of the page that answers it
  into the report (`extracted:`); `pick "<criterion>"` opens the list item that fits best;
  `if "<page shows…>" then <step>`; `click "Filters" | "All filters"` takes the first name
  the page has. Plan to the answer: `… 'pick "cheapest with free cancellation"' 'extract
  "the total price"'`, then answer from `extracted:` without reading the page.
- Blocks use `if "<condition>" { … } else { … }`; bind evidence with `extract "price" as
  number currency SGD as $p`, compare with `if $p < 200 { … }`, and render
  `answer "Price: ${p}"`. Quote the CLI plan against shell expansion. See the
  [blocks and variables reference](references/reading-and-acting.md#blocks-variables-typed-extraction-and-answer)
  for scope, literal dollars and confidence rules.
- **Naming:** elements in words as they appear. Exact names need no model; Jev picks the rest
  and needs `TYPESAFE_API_KEY` (see [settings](references/settings.md)). A step can name
  `ref_25`, an items id `i140` or a CSS selector; those never go to Jev.
  If text cannot find a target, `do` can try a screenshot; `BROWSERCTRL_VISION=off` disables it.
- **It stops instead of guessing:** an unsure pick is marked ⚠; a missing value, an unchanged
  checkbox, an error or a dialog in the way stops with what is there.
- **Lists:** `--repeat 'click "Next"' --until "<condition>" --collect items`.

All options: [`do` reference](references/reading-and-acting.md#plan-several-steps-in-one-call-with-do).

## When something goes wrong

- **A JavaScript dialog:** `dialog <tab> --accept` (or `--dismiss`).
- **The page stopped responding:** `reload <tab>` (or `read --recover`).
- **A captcha or bot check:** `browserctrl captcha <tab>` tries a plain slider, else hands the tab to the user.
- **A timeout or dropped connection:** check the page before retrying; uncertain actions are never replayed.

## Safety

- Never complete a purchase, booking, payment, sign-up, message or deletion unless the user
  asked for it. `do` refuses controls that commit unless the step is `click!` and names it
  exactly. A click by ref is deliberate.
- Recipes call a site's internal API from your logged-in tab, within the site's terms.
  Writes need `--confirm` and are never retried.

## References

| Read | For |
| --- | --- |
| [multi-step-flows.md](references/multi-step-flows.md), [batch.md](references/batch.md), [workflow.md](references/workflow.md) | long forms and multi-screen flows: guarded batches and workflows, verifying outcomes |
| [reading-and-acting.md](references/reading-and-acting.md) | full `do` reference, `read`, waiting, console, network, Jev |
| [sites.md](references/sites.md), [recipes.md](references/recipes.md) | recipes, flow notes, captchas |
| [recording.md](references/recording.md) | recordings, replay, video, annotation |
| [tabs-and-browser.md](references/tabs-and-browser.md) | tabs, claims, profiles, the human, extension |
| [connecting.md](references/connecting.md) | browsers, launching, Safari, diagnostics |
| [activity.md](references/activity.md), [dia-native.md](references/dia-native.md) | agent activity, Dia dormant tabs |
| [architecture.md](references/architecture.md) | CLI, daemon, Python |
| [settings.md](references/settings.md) | every `BROWSERCTRL_*` setting, folders, Jev key |

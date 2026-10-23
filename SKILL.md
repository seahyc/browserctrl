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
- "Find one that...": look for a filter or sort first.

### When the task compares, ranks or checks several things

Put the whole comparison in the plan, after the steps that reach the list. One call then
answers what would otherwise take a read and a decision per item.

| The task asks for | Plan form |
| --- | --- |
| The cheapest, newest, highest-rated… when the site cannot sort by it | `'pick "lowest nightly price" top 1 as $h' 'answer "${h}"'` |
| Details of the first few results | `'for top 3 { extract "price"; extract "cancellation policy" }'` |
| The first result that meets a condition you can only see on its page | `'try pick "free cancellation" up to 3 => "free cancellation"'` |
| Every result that meets a condition | `'each "nonstop and under 6 hours" up to 10 { extract "price" }'` |
| Something only if the page shows it | `'if "the page lists refurbished models" { pick "largest discount" top 1 as $m } else { answer "none listed" }'` |
| A value compared with a limit | `'extract "total price" as number as $p' 'if $p < 200 { answer "under: ${p}" } else { answer "over: ${p}" }'` |

These run after the filter and sort steps in the same `do`. Each item opens in a background
tab and closes after; nothing in a loop commits.
A ranked pick's `${x}` renders the whole item row; `${x.title}`, `${x.link}` and `${x.key}` render
its title, link or sort value (for top K, all chosen items joined by "; "). `pick "first" top 2`
takes the main list in page order.

## Use do well

Most tasks take two `do` calls: one to reach the page, one plan to the answer.

1. **Reach the page and look.** `nav` to an address you can build (search, category), or use the
   site's search, with `--then items`. The report lists the controls on screen and the
   `url params` you can set.
2. **Plan to the answer from real names.** Use only names from a report or `read`; a guessed
   name ("Duration" for a "Length" filter) can make the plan click the wrong control. Set
   filters and sort in the address when `url params` shows them. Then open the result and
   `extract` one fact per step; for "cheapest" or "best", `pick "<criterion>"` first.
3. **Check every step that changes the results:** `'key Enter => "results for Thailand"'`,
   `'click "4 stars & up" => "4 stars"'`. A wrong pick then stops the plan instead of carrying on.

- A guess is fine as the last step, where nothing builds on it.
- A field that suggests as you type: pick the suggestion by the value you typed plus a word
  that makes it unique, `'fill "To" = "90028"' 'click "CA 90028"'`, not by how you expect the
  site to write it ("Los Angeles" was "Hollywood, CA 90028, USA").
- Open a menu, pick its options and apply in one plan: `do` re-reads the page before every
  step, even when chips reorder or counts change after each pick.
- `optional click "Accept all"` clears a banner if there is one; `--dismiss "cookie banner"`
  handles one that appears mid-plan.
- A stopped plan prints `resume: browserctrl do …`, failed step first. Fix that step (a listed
  candidate, a name from `On screen:`, an `i12` item) and run the line; do not split the rest
  into single steps.
- Read the full report and its last line: `✓ done: 3/3 steps` or
  `✗ stopped at step 2/3: <reason>`. Do not hide the report with `tail`.
- No sleep or re-read after `do`: it settles and reports changes.
- Target visible names in the plan instead of grepping refs from `read`.
  Refs are for single commands.
- Without a TypeSafe key, an acted step's expectation is marked unchecked and
  the plan continues with `unsure=true`. Non-exact targets still stop before acting.

## Plan with `do`

```bash
browserctrl do <tab> 'fill "Where" = "Cleveland"' 'key Enter' 'date 2026-10-17' \
  'click "Search"' 'click "Free parking" => "results show parking"' \
  --dismiss "cookie banner" --then items
```

- **Steps:** `click`, `check <el>` (ensure a checkbox is on), `fill <el> = <value>`, `select <el> = <option>`, `hover`, `key Enter`,
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
- Loop over linked details with `for top 3 { extract "price", "cancellation" }`; use
  `pick "lowest listed price" top 3 as $choices` for a ranked list without opening pages.
- "Earliest", "cheapest", "first" across many lines (an availability grid, a rates table) is a
  ranking, not an `extract`: `pick "earliest available date" top 1 as $d` ranks list items or,
  without a list, the page lines that match. `first`/`last` use page order.
- Search safe candidates with `try pick "free cancellation" up to 3 => "cancellation is free"`.
- Ground independent form fills together with `same page { fill "First name" = "Ada"; fill "Last name" = "Lovelace" }`.
- **Naming:** elements in words as they appear. Exact names need no model; Jev picks the rest
  and needs `TYPESAFE_API_KEY` (see [settings](references/settings.md)). A step can name
  `ref_25`, an items id `i140` or a CSS selector; those never go to Jev.
  If text cannot find a target, `do` can try a screenshot; `BROWSERCTRL_VISION=off` disables it.
- **It stops instead of guessing:** an unsure pick is marked ⚠; a missing value, an unchanged
  checkbox, an error or a dialog in the way stops with what is there.
- **Lists:** `--repeat 'click "Next"' --until "<condition>" --collect items`.

All options: [`do` reference](references/reading-and-acting.md#plan-several-steps-in-one-call-with-do).

## Vault credentials

For Safari protected entry, read the Safari section of [vault entry](references/vault-entry.md#safari-27) before requesting an unlock. It uses a fresh disposable automation tab and a separate pinned Safari executor.

For a username, password or authenticator code, use agent-vault's approved
credential-use flow. Never fetch values into agent context or enter them through
ordinary `fill`, `type`, `do` or JavaScript. Read [protected field fill](references/vault-fill.md)
first: the owner approves an item for a set of origins, and each call fills one
field in a tab and element you choose, so multi-step logins are fill, click Next,
fill. Open a new tab for the login; a user's tab with history is refused. After a fill the tab refuses `eval`, `shot` and capture until it closes or
reaches a clean page; reads still work, with values redacted. The older one-form
[vault entry](references/vault-entry.md) still works. A tab claim is not vault
permission, and lease expiry does not log out the website.

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
| [vault-fill.md](references/vault-fill.md), [vault-entry.md](references/vault-entry.md) | protected credential fill through agent-vault (v2, then v1), taint and recovery |
| [settings.md](references/settings.md) | every `BROWSERCTRL_*` setting, folders, Jev key |

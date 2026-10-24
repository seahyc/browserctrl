---
name: browserctrl
description: Control explicitly selected Chromium browsers or Safari 27+ from the terminal. Use for page automation, browser QA, multi-step research, long forms and multi-screen flows, admin consoles and data export, or tab organization; macOS Dia supports dormant tabs. Safari uses Apple's separate automation session.
---

# browserctrl

Use the `browserctrl` CLI on PATH. `browserctrl help` lists every command and flag.

## Connect

- **Every shell call starts fresh.** Put the browser and your identity on each command line,
  or export them in the same call that uses them:
  `BROWSERCTRL_BROWSER=dia BROWSERCTRL_AGENT_ID=<task-name> browserctrl tabs`.
  There is no default browser. `browserctrl browsers` lists what is debuggable.
- Keep one `BROWSERCTRL_AGENT_ID` for the whole task.
- Open your own background tab: `t=$(browserctrl open <url> --id)`. Respect other agents'
  claims. Never stop the daemon, restart the browser or open your own CDP or Playwright session.

## Output and exit codes

| Exit | Meaning |
| --- | --- |
| 0 | done, or found |
| 1 | not found or false (`find`, `text --match`, `wait`, `table`) |
| 2 | usage error |
| 3 | a `do` plan stopped, or a by-name action was unsure |
| 4 | no browser or daemon |
| 5 | refused (claimed tab, cool-down, a committing control, a protected tab) |
| 6 | other failure (timeout, closed tab, page error) |

- Read reports in full. Don't pipe browserctrl through `tail`, `head` or `grep`, and don't send
  it to `/dev/null`: that hides the stop reason and the exit code. Use `-q` for quiet output
  and test the exit code: `browserctrl find "$t" "Next" --enabled -q && …`.
- `--json` on read commands gives one object, `--jsonl` one record per line.
  Details: [scripting](references/scripting.md).

## Fastest way through a task

First `browserctrl site <site or URL>`: its recipes (the site's own API) and flow notes.

| The task needs | Use |
| --- | --- |
| Data a recipe covers | the `recipe run` that `site` prints |
| A page whose address you can build (search, sort, filter) | `nav`, then `items` or `text` |
| One action | by the name you see: `click "$t" "Save"`, `fill "$t" "Search" "aeron"`, `select "$t" "Country" "Singapore"`, `check "$t" "Remember me"` |
| Two or more actions you can foresee | one `do` plan with `--then items` |
| A table or grid | `table "$t"` (`--csv`, `--jsonl`) |
| Part of a long page | `text "$t" --region "<heading>"`, `--from "<line>" --to "<line>"`, `--tail 40` |
| Every page of a paged list or log | one `do` with `--repeat 'click "Next"' --collect rows --out /tmp/rows.jsonl` |
| Details from several list items | `visit <links> --grep "<label>"` |
| Controls whose names you can't guess | `read "$t"` once, then plan from the names it shows |

| Instead of | Use |
| --- | --- |
| `read \| grep` to find a ref | the visible name: `click "$t" "Trust Policy"` |
| `eval` with `querySelectorAll` or `innerText.slice` | `table`, `items`, `text --region/--from/--tail` |
| a shell loop over pages | `do --repeat … --collect … --out` |
| `sleep` | nothing: `nav`, `click` and `do` wait for content; `wait` for a condition; `wait --download` for a file |
| `key Escape; sleep 1` before a click | `do … --dismiss "<that dialog>"` (a notice that only closes is closed for you) |
| `open \| grep` for the tab id | `open <url> --id`, `tabs --ids` |
| scrolling an inner pane with `eval` | `scroll "$t" --in "<pane name>" end` |

## Use `do` well

Most tasks take two `do` calls: one to reach the page, one plan to the answer.

1. **Reach the page and look.** `nav` to an address you can build, or use the site's search,
   with `--then items`. The report lists the controls on screen and the `url params` you can set.
2. **Plan to the answer from real names.** Use names from a report or `read`. A guessed name
   ("Duration" for a "Length" filter) can click the wrong control. Set filters and sort in the
   address when `url params` shows them. Then `extract` one fact per step.
3. **Check steps that change the results:** `'click "4 stars & up" => "4 stars"'`. A wrong pick
   then stops the plan instead of carrying on.

```bash
browserctrl do "$t" 'fill "Where" = "Cleveland"' 'key Enter' 'date 2026-10-17' \
  'click "Free parking" => "results show parking"' 'extract "the lowest price"' \
  --dismiss "cookie banner" --then items
```

- **Reading the report.** It ends with `✓ done: 3/3 steps` or `✗ stopped at step 2/3: <reason>`.
  Steps marked ✓ did what they say: answer from the report, and don't re-read the page.
  An extracted value prints with its source line and page. A ⚠ names what is uncertain (two
  competing lines, a line that did not verify): check only that. `changed on the page:` lists
  what the plan changed.
- **After a stop,** run the `retry:` or `resume:` line it prints. `resume:` is
  `do "$t" --resume --replace '<step>'` with the closest control filled in; swap in another name
  from `On screen:` or an `i12` item if that one is wrong. Don't split the rest into single calls.
- **Without a TypeSafe key,** a plan that needs Jev stops before acting and says how to set it.
  Plans of exact names, refs and CSS selectors run without one.
- **Steps:** `click`, `check`, `fill <el> = <value>`, `select <el> = <option>`, `hover`,
  `key Enter`, `type "<text>"`, `scroll down|up`, `nav <url>`, `expect <what shows>`,
  `date YYYY-MM-DD`, `set <slider> = <value>`, `optional click "Accept all"`, and
  `click "Filters" | "All filters"` for the first name present.
- **Answers in the same call:** `extract "<what>"` copies the answering line into the report;
  `pick "lowest price" top 1 as $x` ranks the main list by a value the page shows, and later
  steps can use `${x.title}` and `${x.link}`. For a detail of the chosen item, keep going in the
  same plan: `'open $x' 'extract "rating"'` (`open $x in new tab` keeps the list). Several items
  in one plan: `for top 3 { extract "price" }` (the first few), `try pick "free cancellation" up to 3
  => "free cancellation"` (the first that qualifies), `each "nonstop" up to 10 { extract "price" }`
  (every one that qualifies). When the site can sort by the criterion, sort there instead. Details:
  [compare, rank or check](references/reading-and-acting.md#compare-rank-or-check-several-items).
- **Suggest-as-you-type fields:** pick the suggestion by the value you typed plus a word that
  makes it unique: `'fill "To" = "90028"' 'click "CA 90028"'`.
- **Plans from a file or another tool:** `browserctrl do "$t" - < plan.txt`, one step per line.
- **Naming:** exact names need no model. Jev picks the rest and needs `TYPESAFE_API_KEY`
  ([settings](references/settings.md)). Refs (`ref_25`), items ids (`i140`) and CSS selectors
  never go to Jev.

Full syntax, blocks, variables and loops: [`do` reference](references/reading-and-acting.md#plan-several-steps-in-one-call-with-do).

## Admin consoles and data

- **Tables and grids:** `table "$t"` reads ARIA grids, split-header tables and div rows as
  header-keyed rows. `--selector` picks one when the page has several.
- **Paged logs and lists:** `do "$t" --repeat 'click "Go to next page"' --collect rows --out FILE`
  writes one JSON line per page and stops at the last page.
- **Inner panes and editors:** `scroll "$t" --in "<pane name>" end`, then `text --region`.
- **Downloads:** click the export control, then `browserctrl wait --download` prints the file path.

## When something goes wrong

- **A dialog in the way:** a notice whose only buttons close it is closed and listed under
  `events`. A dialog that asks for a choice or input stops the plan; the stop prints a `retry:`
  line with `--dismiss` when closing it is safe.
- **"the page acknowledged the click late":** a busy page. Its result was waited for (up to 5 s).
  If the step still stopped, read the page before retrying: the click may have landed.
- **A JavaScript dialog:** `dialog "$t" --accept` (or `--dismiss`).
- **The page stopped responding:** `reload "$t"` (or `read --recover`).
- **A captcha or bot check:** `browserctrl captcha "$t"` tries a plain slider, else hands the tab
  to the user.
- **A timeout or dropped connection:** check the page before retrying. Uncertain actions are
  never replayed.

## Vault credentials

For a username, password or authenticator code, use agent-vault's approved credential-use flow.
Never fetch values into agent context or enter them through `fill`, `type`, `do` or JavaScript.
Read [protected field fill](references/vault-fill.md) first: the owner approves an item for a set
of websites, and each call fills one field in a tab and element you choose, so a multi-step login
is fill, click Next, fill. Open a new tab for the login; a user's tab with history is refused.
After a fill the tab refuses `eval`, `shot` and capture until it closes or reaches a clean page;
reads still work, with values redacted. For Safari, read the Safari section of
[vault entry](references/vault-entry.md#safari-27). A tab claim is not vault permission, and
lease expiry does not log out the website.

## Safety

- Never complete a purchase, booking, payment, sign-up, message or deletion unless the user asked
  for it. `do` refuses a committing control unless the step is `click!` and names it exactly;
  a by-name `click` needs `--commit`. A click by ref is deliberate.
- Recipes call a site's internal API from your signed-in tab, within the site's terms. Writes
  need `--confirm` and are never retried.

## References

| Read | When |
| --- | --- |
| [scripting.md](references/scripting.md) | exit codes, streams, JSON, stdin plans, bulk export |
| [reading-and-acting.md](references/reading-and-acting.md) | full `do` syntax, `read`, `items`, waiting, Jev |
| [multi-step-flows.md](references/multi-step-flows.md), [batch.md](references/batch.md), [workflow.md](references/workflow.md) | long forms and multi-screen flows with verified outcomes |
| [sites.md](references/sites.md), [recipes.md](references/recipes.md) | recipes, flow notes, captchas |
| [recording.md](references/recording.md) | recordings, replay, video |
| [tabs-and-browser.md](references/tabs-and-browser.md) | tabs, claims, profiles, handing over to the user, the extension |
| [connecting.md](references/connecting.md) | browsers, launching, Safari, diagnostics |
| [activity.md](references/activity.md), [dia-native.md](references/dia-native.md) | agent activity, Dia dormant tabs |
| [vault-fill.md](references/vault-fill.md), [vault-entry.md](references/vault-entry.md) | protected credential fill, taint and recovery |
| [settings.md](references/settings.md), [architecture.md](references/architecture.md) | every `BROWSERCTRL_*` setting, the Jev key, the CLI and daemon |

---
name: browserctrl
description: Control explicitly selected Chromium browsers or Safari 27+ from the terminal or MCP. Use for page automation, browser QA, or tab organization; macOS Dia supports dormant tabs. Safari uses Apple's separate automation session.
---

# browserctrl

Project source and issues: [seahyc/browserctrl](https://github.com/seahyc/browserctrl).
Invoke this skill as `$browserctrl`. The CLI is `browserctrl` (`cdp` and `browserctl` are
compatibility names); the MCP server exposes the same commands as `browser_*` tools.

This file is the core: what to use when, the `do` plan, recovery and safety. Details live
in the references listed at the end; read one when a task needs it.

## Connect

- **Pick the browser on every call:** `--browser dia|chrome|brave|edge|chromium|arc` or
  `--port <n>`; or set `BROWSERCTRL_BROWSER` / `BROWSERCTRL_PORT` once in the agent's
  environment. There is no default: `browserctrl browsers` lists what is debuggable.
- **One identity per agent:** set `CDP_AGENT_ID` (MCP: `agentId`) and keep it for the task.
- **Reuse the shared connection.** Never open your own WebSocket or Playwright
  `connect_over_cdp` to the user's browser, never stop the daemon or restart the user's
  browser to recover; observe the tab through browserctrl, then decide.
- Open your own background tab (`open <url>`), keep its id, release claims when done.
  Respect a tab another agent or the user has claimed.

Details: [connecting, browsers, Safari, approvals](references/connecting.md) ·
[tabs, claims, profiles, the human](references/tabs-and-browser.md).

## Fastest way through a task

**Look the site up once before planning:** `browserctrl site <site or URL>` lists its
recipes (the site's own API: no page at all) and its flow notes (facts earlier agents wrote).

| The task needs | Use | Not |
| --- | --- | --- |
| A site's data that a recipe covers | `site <url>`, then the `recipe run` it prints | the UI |
| A page whose address you know or can build (search, sort, filter, item pages) | `nav`, then `items` or `text` | `do` clicking through filters |
| Two or more interactions you can foresee | one `do` call with the whole plan and `--then items` | a read before each click |
| Details from several items of a list | `visit <links> --grep "<label>"` (parallel) | clicking into each item |
| The first N items of the list a plan produces | `do … --open N --grep "<label>"` | a second call |
| One click, one fill or one read | the single command | `do` |
| Controls whose names you cannot guess | `read` once, then plan | repeated reads |

- **Address first:** `do` and `read` end with `url params`, and each step shows how it
  changed the address (`url: +state=closed`); a `nav` to a filtered address beats clicking.
- A report whose steps all show ✓ did what it says: answer from it, don't re-read. ⚠ means
  check the page.
- Each report ends with `changed on the page:` (boxes ticked, values set, sections opened,
  result counts, notices, controls that appeared or went): read it instead of reading the
  page again. A step that landed on a different page says so; `--no-diff` drops the section.
- Only the last step commits: adding to a cart, choosing options and filling a form are
  not commits. After an add, check the page confirms it.
- Options that change after each pick (chips, counts): one pick per `do` call.
- "Find one that…": look for a filter or sort before checking items one by one.
- Fine print decides it: open the result so the evidence is on screen. A site error: retry once.

More: [planning, `do`, reading, waiting](references/reading-and-acting.md).

## Read the page

```bash
browserctrl read <tab>            # refs ref_1..N with roles and names, then the page text
browserctrl items <tab>           # lists, cards and rows as groups of items (ids i1, i2…)
browserctrl text <tab> [--match "<regex>"]
browserctrl find <tab> "<text or regex>"   # a control by its words, hidden ones too: what hides it, its opener, its link
browserctrl fields <tab>          # every form field and what it holds now (boxes, selects, sliders, radios)
```

Reach for `find` and `fields` before `eval`: `find` searches the whole page and open shadow
roots, says `in a hidden section: opens with link "Salary" ref_110` and gives a handle
(`ref_…` or `[data-bc-pin="…"]`) that any `do` step takes; `fields` answers "what did my
plan actually set?" in one call.

`read` lists elements near the viewport (`--all` for the whole page), marks `(covered by …)`,
`(inert)` behind a modal, `*` for new elements, and waits up to 8 s for a loading page
(`--no-wait` skips). Text inside web components (open shadow roots) is included. Refs keep
meaning what your last `read` showed; a control the page redrew is found again by its role
and name, and a ref that is truly gone says so instead of clicking something else.

## Plan with `do`

```bash
browserctrl do <tab> 'fill "Where" = "Cleveland"' 'key Enter' 'date 2026-10-17' 'date 2026-10-20' \
  'click "Increase Pets"' 'click "Search"' 'click "Free parking" => "results show parking"' \
  --dismiss "cookie banner, newsletter popup" --then items
```

- **Steps:** `click`, `fill <el> = <value>`, `select <el> = <option>`, `hover`, `key Enter`,
  `type "<text>"`, `scroll down|up`, `nav <url>`, `wait <ms>`, `expect <what shows>`,
  `date YYYY-MM-DD` (any calendar; opens the picker if needed, pages months, confirms the
  pick), `set <slider> = <value>` or `= <min>-<max>`. `optional click "Close"` skips when
  absent; `=> "<expected>"` checks the result in the same request.
- **Naming:** elements in words as they appear; exact names need no model, Jev picks the
  rest (about 0.35 s). A step can name `ref_25`, an items id `i140`, or a CSS selector, and
  those never go to Jev. Same-name controls stop with each one's row so you can pick by ref.
- **Stops instead of guessing:** an unsure pick is marked ⚠; a pick missing a number or date
  the step names stops; a checkbox that did not change, an error on the page, or a dialog
  in the way stops with what is there. `--dismiss "<kinds>"` closes only the listed kinds.
- **Checks:** checkboxes, radios and toggles report `now checked / pressed`; naming a box or
  toggle that is already on leaves it on (click by ref to turn it off). A radio is always
  clicked. A fill with a number prefers a text box over a slider; a slider that rounds the
  value is marked ⚠ (`set 40, asked 39.99`).
- **Lists:** `--repeat 'click "Next"' --until "<page condition>" --collect items` pages
  through; `--then items` scrolls the results into view and lists them.

All options: [the `do` reference](references/reading-and-acting.md#plan-several-steps-in-one-call-with-do).

## Single actions

```bash
browserctrl click <tab> ref_3            # or "#id", a CSS selector, or x y
browserctrl fill  <tab> ref_5 "text"     # a label follows to its field
browserctrl select <tab> ref_7 --label "Exporter"
browserctrl key <tab> Enter              # type, scroll, scroll-to, hover, drag, upload
browserctrl nav <tab> <url>              # open <url> for a new tab
```

## When something goes wrong

- **A JavaScript dialog is open:** `browserctrl dialog <tab> --accept` (or `--dismiss`).
- **The page stopped responding:** `browserctrl reload <tab>` stops its script and reloads,
  restarts the renderer if needed, and as a last resort reopens the page in a new tab whose
  id it prints (`read`/`text`/`items --recover` do the same). A navigation that finds the
  tab stuck recovers it onto the new address.
- **A captcha or bot check:** `browserctrl captcha <tab>` tries a plain slider once,
  otherwise brings the tab to the user, waits, and reloads once if the wait runs out. A
  site that keeps stalling is named as slowing or blocking automated browsing.
- **A command timed out or the connection dropped:** check the page before retrying; an
  action whose outcome is uncertain is never replayed.
- **Unknown command:** browserctrl names the nearest one (`screenshot` → `shot`).

Details: [captchas](references/sites.md#captchas-and-verification-pages) ·
[waiting](references/reading-and-acting.md#wait-for-conditions-never-sleep) ·
[gotchas](references/connecting.md#gotchas).

## Safety

- Never complete a purchase, booking, payment, sign-up, message or deletion unless the
  user asked for it: `do` refuses controls that commit (Buy, Pay, Place order, Send…)
  unless the step is marked `click!` and names it exactly. A click by ref is deliberate.
- Recipes call a site's internal API from your logged-in tab; use them within the site's terms.
- Writes through recipes need `--confirm` and are never retried.

## References

| Read | For |
| --- | --- |
| [reading-and-acting.md](references/reading-and-acting.md) | the full `do` reference, `read` and `items` output, single actions, waiting, background tabs, what happened (console, network), Jev |
| [sites.md](references/sites.md) | recipes and flow notes, captchas and the jigsaw solver |
| [recording.md](references/recording.md) | `rec` recordings, replay and videos, recording a person's play, annotation |
| [tabs-and-browser.md](references/tabs-and-browser.md) | tabs and claims, sharing with the human, profiles, browser-level control, the extension |
| [connecting.md](references/connecting.md) | the shared connection, picking and launching browsers, Safari, tests, gotchas, diagnostics, repeated approvals |
| [architecture.md](references/architecture.md) | MCP tools, how the daemon works, the Python client |
| [recipes.md](references/recipes.md) · [activity.md](references/activity.md) · [batch.md](references/batch.md) · [workflow.md](references/workflow.md) · [dia-native.md](references/dia-native.md) | recipe format · agent activity · guarded batches · workflows · Dia's native tabs |

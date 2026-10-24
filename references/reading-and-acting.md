# Reading and acting: planning, read, items, do, single actions, waiting, Jev

Part of the [browserctrl skill](../SKILL.md).

## Fastest way through a task

**Before planning on a site, look it up once:** `browserctrl site <site or page URL>`.
It lists the site's recipes first, with the exact `recipe run`
command, then its flow notes: facts earlier agents wrote about how the site works,
with ids, the page's own notes first. Pick your plan from them: a recipe that covers
the data beats any UI route, and a note such as "the filter is in the URL" turns a
`do` plan into one `nav`. `open`, `nav`, `read` and `do` also print a short hint block
(counts, top recipes, top notes, and `all: browserctrl site <site>`), but the lookup is
yours to run; don't wait for a hint.

Every agent turn costs a few seconds of thinking plus the tool's own time, so the fastest
route is the one with the fewest calls. Choose by what the task needs:

| The task needs | Use | Not |
| --- | --- | --- |
| A site's data that a recipe covers | `browserctrl site <url>`, then the `recipe run` it prints: no page at all | |
| A page whose address you know or can build (search, sort, filter, item pages) | `nav` to it, then `items` or `text` | `do` clicking through filters |
| Two or more interactions you can foresee (type, pick, sort, filter, page through) | one `do` call with the whole plan and `--then items` | a read before each click |
| Details from several items of a list | `visit` with their links and `--grep` (parallel) | clicking into each item |
| The first N items of a list your `do` plan produces, in list order | `--open N --grep …` on that `do` call | a second call for the drill-down |
| One click, one fill or one read | the single command | `do` |
| Controls whose names you cannot guess | `read` once, then plan | repeated reads |

- **Address first.** Before driving a filter box, look for the address that does the same:
  `do` and `read` end with `url params` (the parameters this page uses), and each step
  shows how it changed the address (`url: +state=closed`). Filters built from tokens or
  chips take several steps in the UI but one in the URL; in the benchmark that halved the
  time on such tasks.
- **`do` pays off on interaction.** In benchmarks on marketplaces, dashboards and news
  sites, a `do` plan took 30–70% less time than reading and clicking step by step. On
  tasks that were only "open a known page and read it", it added a model call and a wait
  for nothing: use `nav` and `items` there.
- **`visit` for drill-downs:** `browserctrl visit /item/1 /item/2 … --from <tab> --grep
  "<label>|<label>"` opens the pages in parallel background tabs and returns only the
  matching lines (with one line either side) per page; `--then items` returns each page's
  items instead. A dozen pages take about 15 s.
- **`--open N` only for the first N in list order:** `do <tab> '<steps>' --open 5 --grep
  "<label>"` takes the first 5 items of the main list (ads, Sponsored and Spotlight items
  skipped) and opens them in the same call. When you must choose the items first (the 3
  with the most points, the ones matching a condition), read the list, then `visit`.

Fewer, cheaper turns:

- `do` and `read` reports include `url params`: the address parameters this page
  uses (its own query, GET forms, sort/filter/page links), and each step shows how it
  changed the address (`url: +state=closed`). Use them to jump straight to a filtered view
  with a `nav` step instead of clicking through filters again.
- A report whose steps all show ✓ did what it says, and `=> "<expected>"` checks were
  judged on the page: answer from it instead of re-reading the page to confirm.
- `--then items` shows the main list in full and folds the other groups to one line;
  `browserctrl items <tab> --grep "<regex>"` keeps only matching items.
- With `BROWSERCTRL_PREFETCH=1`, a call that ends on a list starts loading its first 3
  item links in background tabs (3 per site, closed after 90 s if unused), and `visit`
  takes them already loaded. Off by default: it opens tabs in the user's browser.
- If you can delegate, let a fast model run the mechanical `do`/`visit` calls of a plan
  you wrote and report back; keep planning and the final answer for yourself.

Plan from names you have seen: the call that reaches the page (`nav … --then items`, or a
stopped plan's `On screen:` list) shows them, so a separate `read` is rarely needed. A guessed
name can ground to the wrong control; keep guesses to the last step.

Lessons from hard live-site tasks (Online-Mind2Web, round 1):

- **Only the last step commits.** Adding to a cart or bag, choosing options and filling a
  form are not commits; the commit is the final pay, place-order, send or book button.
  After an add, check the page confirms it ("Added to bag", the cart count).
- **Filters whose options change after each pick** (chips that reorder, counts that
  update) still fit in one plan: `do` re-reads the page before every step, so each pick is
  found where it is now.
- **"Find one that…":** look for a filter or sort that does it before checking items one
  by one; one task spent 40 calls opening titles a filter would have answered.
- **Fine print decides it:** when you rule a result out over its details, open it so the
  evidence is on screen, and say why in your answer.
- **A site error is not the end:** retry once (reload, or the next store or option).

## Read before you act

`browserctrl read` snapshots the page into `ref_1..ref_N` with roles, accessible names
and test ids, plus the visible text. Act on refs, not on guessed selectors.

```bash
browserctrl tabs --browser dia
browserctrl read a1b2c3d4 --browser dia
# Use --json when another tool should parse the result; --text none skips page text.
browserctrl read a1b2c3d4 --json --max-text 8000
# token: 1791…:ogs5vo   scroll 0/4180 · 0 screens above, 6 below
# stats: 31 interactive · 121 links · 1 iframe (cross-origin: https://ads.example) · 980 elements
# modal open: dialog "Subscribe to our newsletter"; its controls come first, everything else is inert
#  ref_1    e14   button     No thanks
#  ref_2    e15   button     Subscribe
#  ref_3    e1    button     Sign in with Google      [signin-google] (covered by div)
# *ref_9    e22   clickable  Sort By: Best Match
# (88 more elements not listed: 88 below; --all lists the whole page)
```

- By default `read` lists elements within about one screen of the viewport (plus an
  open modal) and counts the rest; `--all` lists the whole page. `(below)`/`(above)`
  marks a listed element outside the visible screen.
- A card that is one big link is one row; real controls inside it (a Like button, an
  input) stay separate. Divs that act as controls (pointer cursor or their own click
  listener, such as a "Sort by" dropdown) appear with role `clickable`.
- `(covered by …)` means another element sits on top, so a click by ref is refused.
  With a modal open, everything outside it is `(inert)` and its controls come first.
- `e17` ids stay the same across reads of one document; `*` marks elements that were
  not there at the previous read (a menu that just opened, a row that loaded).
- `loading:` appears when the document is still loading, shows skeleton or placeholder
  blocks, or has almost no content: wait and read again. Same-origin iframe controls are
  listed `(in frame)` and click correctly; cross-origin frames are listed in `stats`.

Refs are invalidated by navigation and by the next `read`. Using a stale ref
returns "re-run browserctrl read" instead of clicking whatever now sits in that slot.

### Read lists, cards and messages with `items`

To report what a list shows (search results, listings, inbox rows, chat messages),
use `items` rather than page text. It finds repeated items, groups them by page
region and heading, and keeps each item's own text together:

```bash
browserctrl items a1b2c3d4 --browser dia
# g1  main · "190 search results for 'aeron'"  · 48 items, 4 per row, 40 below the fold
#   i1    ezshopcare · 3 months ago · Spotlight · office chair … · S$29 · Brand new  → /p/office-chair-…
#   i3    office.chair.seller · 38 minutes ago · Herman Miller Aeron chair … · S$580  → /p/herman-miller-…
# g4  footer › list · "Top searches"  · 42 items   (page chrome: … --group g4)
```

- Pick the group by its region and heading: a banner of three cards and the results
  grid are different groups. Linked headlines that stand alone (a lead story, a hero
  card) are listed as `headlines outside lists`, one group per page section, so "the
  first N stories" includes them. Links are printed in full; long titles are shortened
  before prices, dates or statuses beside them. Header, nav and footer lists are folded; `--group gN`
  shows one group in full, `--all` every item, `--json` the raw records.
- A badge such as "Spotlight", "Ad" or "Sponsored" appears in the item's own text;
  `{…}` shows class or label hints such as `{D_bump}`. Leave those items out when
  the task asks for organic results.
- In a single-column thread, `[left]` and `[right]` give each message's side: on chat
  sites your own messages are usually on the right. Confirm with the page if unsure.
- Item ids stay the same across reads of the same page, and `*` marks items not seen
  in an earlier read. To collect a lazily loaded list, `wake` the tab, scroll, and read
  again until no new items appear.

## Acting

### Plan several steps in one call with `do`

When you know the next few steps, send them together instead of reading the page
before each click. Name elements as they appear; `do` matches exact names without a
model and asks Jev (about 0.35 s) for the rest, waits for each step's result to
render, and stops at the first step it cannot do with confidence:

```bash
browserctrl do <tab> 'fill "the search box" = "herman miller aeron"' 'key Enter' \
  'click "More filters" => "a maximum price box is shown"' 'fill "maximum price" = 600' \
  'click Apply => "results are under S$600"' --dismiss "cookie banner, app-install prompt" \
  --repeat 'click Next' --until "there is no next page" --max 5 --collect items --browser dia
```

- Steps: `click <element>`, `fill <element> = <value>`, `select <element> = <option>`,
  `hover`, `key Enter`, `type "<text>"` (into whatever has focus), `scroll down|up`,
  `nav <url>`, `wait <ms>`, `expect <what the page shows>`, `date YYYY-MM-DD`, and
  `set <slider> = <value or range>`.
- `date YYYY-MM-DD` picks a calendar day (open the picker first): it matches any day-cell
  label or text format, waits for a picker that is still opening (and opens a collapsed
  When / Check-in / Dates control itself if no calendar shows), and pages months to the
  date. A click that names a whole date ("Oct 17, 2026") does the same.
- `set "<slider>" = <value>` (or `= <min>-<max>` for a range, e.g. `= $300-$900`) sets a
  slider by its name or its group's: native ranges take the value, accessible sliders are
  moved with keys (a drag if they ignore keys). The report shows `now 300–900`; a slider
  that won't move stops with where it is. `fill` on a slider of that exact name does the same.
- A `date` pick must show on the page (the day marked selected, or a date field or summary
  showing it), or the plan stops.
- If a site keeps stalling (pages that never finish, timeouts, challenges), browserctrl says
  so: change connection or pacing, use a recipe, or hand the tab to a person.
- A step can name an element directly: `click ref_25` (from your last read), `click i140`
  (an `items` id, unquoted), or a CSS selector `click "#id"` / `click '[data-value="600"]'`.
  These never go to Jev.
- ⚠ marks a step Jev was unsure about (p < 0.75): check the page before relying on it. A
  pick that lacks a number or date your step names stops instead of guessing. A checkbox
  or radio that didn't change, or a page that shows an error after a step, also stops.
- `!` matters only on click and select (`click! "Place order"`); typing, ticking boxes and
  following links never need it. A click by ref or items id (`click ref_3`) is deliberate
  and never guarded, and "Order Now"-style buttons that only start an order run unless the
  page shows a bag total or payment step.
- Web components: `read`, `text`, `items` and Jev's view of the page include what open
  shadow roots draw (a quiz, a newsletter or region popup). A popup drawn by a component
  over a cookie dialog is the layer on top: its controls are not inert, and a click under it
  names it (`covered by region-picker "Are you in the right place?…"`). An icon button whose
  own markup says close is named `Close`.
- A radio the step names is always clicked (clicking a chosen radio cannot unchoose it). A
  choice the page puts in its address before redrawing the form unticked counts as taken
  (`the page put the choice in its address`); copies of a control drawn twice are judged by
  the one a person can use.
- `fill` with a number prefers a text box over a slider of the same meaning ("Max Price $"
  beside a "Maximum Price" slider); a slider that rounds the value is marked ⚠
  (`set 40, asked 39.99`). A visually hidden checkbox or radio is clicked through its label.
- A ref or pinned element the page redrew (results arriving, a client-side route change) is
  found again: the one copy on screen with the same tag, attributes and text.
- `--then items` scrolls the main list's first item into view when the plan ended with all of
  it out of view (`scrolled the results into view`).
- A name made up from an icon button's row (`… (unnamed button)`) commits only when the button
  sends its form.
- A control under a sticky header or a dialog's footer, or past the edge of a scrolling
  list, is still found by name; the click scrolls it clear. Clicks never scroll a control
  that is already in view.
- Toggle buttons (`aria-pressed`) report now pressed / not pressed like checkboxes. Naming
  a toggle or checkbox that is already on leaves it on; to turn it off, click it by ref.
- When a step finds nothing because a dialog or notice is on top, the stop report names it
  and its harmless close control (`On top: … close it with click "Got it"`); add
  `optional click "Got it"` to a plan for notices that may or may not appear.
- When several controls share a name, Jev sees each one's row, and an unsure pick stops
  listing them (`click ref_7 (near "Start time") or click ref_8 (near "End time")`): pick
  one by ref.
- `fill` types like a person (select the old text, insert the new), so search-as-you-type
  boxes, comboboxes and token filters react. Plan a token filter the way you would click
  it: open the box, type the field name, pick it, pick the operator if one is offered,
  type the value, pick the suggestion, then Enter. Items of an open dropdown or suggestion
  list are listed and clickable even without roles.
- `=> "<expected result>"` after any step: the plan stops right after that step when
  Jev judges it untrue. It is checked in the same request that grounds the next step
  (the last one with the final page checks), so it costs no extra time. Write it about
  visible text, not inferences. Prefer it to a separate `expect` step.
- `optional click "Close"` skips the step (reported with `–`) when nothing matches,
  instead of stopping: for popups that may or may not appear.
- Blocking overlays: whenever a dialog or popup covers the page, `do` asks Jev whether
  it blocks the next step. Without `--dismiss` it stops with the overlay's text and
  controls. `--dismiss "cookie banner, newsletter popup"` closes only those kinds, by a
  harmless control ("Accept cookies", "Close", "No thanks"); it never clicks Subscribe,
  Buy, Install or anything that commits, and stops if that is the only way out. List
  only kinds you would close yourself without reading; let anything else (a login
  wall, an age or region gate, a confirmation) stop the plan so you can decide.
- Notices are never acted on: a new toast, alert or inline message such as "Price
  changed", "Out of stock" or "Did you mean" is reported under `events` with the step
  that caused it, beside the overlays dismissed. Read them before reporting a result.
- `--repeat '<step>' [--until "<page condition>"]` runs after the plan: it repeats the
  step (usually `click Next`) until Jev judges the `--until` condition true, the step
  cannot be done (no Next button), the button the step names is disabled, the page did
  not change after the step (a Next that stays enabled on the last page), or `--max`
  (10) repeats. Without `--until` it simply runs to the last page. `--collect items`
  returns the `items` of every page, merged and de-duplicated by link and text;
  `--collect rows` the rows of the page's main table or grid as objects keyed by the
  column headers (log viewers, admin tables), de-duplicated; `--collect text` the text.
  In the report these are bounded (text 6,000 characters a page and 20,000 in all,
  items 200 a page, rows 500 shown).
- For a bulk export add `--out FILE` (or `--out -` for stdout): each page is written as
  one JSON line the moment it is read, `{"page":3,"url":…,"columns":[…],"rows":[{…}],"duplicates":0}`
  (`"items":[…]` for items, `"text":"…","chars":N` for the page's full text), with no
  total cap. `--max` then defaults to 1000 (up to 5000); `--page-cap N` bounds one page
  (default 1,000,000 characters, 5,000 items or rows); `--no-dedupe` keeps repeated
  rows. The report goes to stderr. Instead of a shell loop of `text`, `find` and `click`:

  ```bash
  browserctrl do <tab> --repeat 'click "Go to next page"' --collect rows --out /tmp/slow-log.jsonl
  jq -c '.rows[]' /tmp/slow-log.jsonl > /tmp/rows.jsonl
  ```
- A plan stopped by a dialog or popup prints the same command with that overlay added to
  `--dismiss`, as a `retry:` line; run it if closing that overlay is harmless.
- `do <tab> -` reads the steps from stdin, one per line (`--file plan.txt` from a file);
  blank lines and `#` comments are skipped. See [scripting.md](scripting.md).
- `--then items` or `--then text` returns the resulting page in the same call.
- Exit 3 means the plan stopped (other codes: [scripting.md](scripting.md)): the report names the step, the reason, Jev's
  candidates with refs, elements with that name that exist but are hidden (often opened
  by another control), and the controls on screen. Re-plan from that report; the steps
  before it already happened.
- A control that can commit something (Buy, Send, Pay, Delete, Submit, Confirm…) is
  clicked only by a step marked `!` that names it exactly: `click! "Submit"`. Jev never
  picks one, and an unmarked step stops. Mark a step only for an action the user
  authorized; messages and payments need their approval first. You supply every typed
  value.
- Every run is traced per tab. `browserctrl trace <tab> [--last N] [--json]` shows
  each step's target, how it was found (exact or Jev p), URL changes, expectations
  with p, dismissed overlays and notices. Review traces after the task, or when a
  result looks wrong, instead of adding read steps to the plan. Traces live in
  the `traces` folder of the data folder (`browserctrl where`; `BROWSERCTRL_TRACES` overrides).
  Tracing is on by default, capped at 2 MB per tab and 50 MB in all; `browserctrl trace off` stops it.
- **Flow notes** are short facts about how a site works, written by agents after
  earlier tasks. Read them all with `browserctrl site <site>` (or `notes <page URL>`,
  that page first) before planning. `open`, `nav`, `read` and each `do` step that lands
  on a new kind of page also print the top ones in the hint block, with ids:
  `hint: 1 recipe (faster than the UI), 3 of 9 notes for airbnb.com (all: browserctrl site airbnb.com)`
  `hint:   3f9a1 Total price with fees is behind the "Display total" toggle (worked 2×, …)`.
  Treat them as advice: if a note says a filter is in the URL, try one `nav` to it
  before driving the filter UI. One rule also writes notes for you: a control that put a
  filter in the URL (task values masked as `…`).
- **Notes act inside `do`.** The current page's notes go to Jev as context with every
  step. A **reveal** note runs its steps when a step's target cannot be found, then
  retries (`✓ 3. fill Maximum = 600 → … (exact, via note 54843)`). An **on** note runs
  its steps when Jev sees its situation, then carries on. A URL note that covers a
  planned click is printed as `note <id>: … nav to it directly`. Notes that ran are
  confirmed when they worked and contradicted when they did not (`notes: 54843
  confirmed`); a note that only informed Jev is not.
- **After finishing a task on a site, reflect:** what would have saved you the most
  time? Add up to 3 one-line facts about how the site works that would help a
  *different* task there, never the answer or this task's values (products, prices,
  dates, names, search terms) or personal data:
  `browserctrl notes add <site or page URL> "<fact>"` (`--path /search` scopes it to a
  kind of page; a URL does that for you). Jev rejects notes that read as task-specific;
  rephrase rather than `--force`. Then `notes confirm <id>` each note you relied on that
  held, and `notes drop <id> --why "…"` each one that was wrong. Good notes name where a
  control hides, which filter lives in the URL, what a site does by default (currency,
  location, sort), and fine print that changes an answer. When the lesson is how to
  reach a hidden control or clear a recurring interruption, write it so `do` runs it:
  `notes add <site> --reveal "Pets" 'click "Guests"' "Pets sits under the Guests picker"`
  or `notes add <site> --on "a cookie banner covers the page" 'click "Accept"' "…"`
  (steps only click, select, hover, press keys, scroll or wait; never commit or type).
  If you spot where a page's
  data comes from (a JSON endpoint in `recipe endpoints <host>` or the network), record
  it: `notes add <site> --api "Order list comes from GET /api/v4/orders?offset="`; `site`
  flags these as recipe candidates. A note can point at a recipe with
  `--recipe <name>` (shown as `→ recipe run <name>`).
  `browserctrl notes [site] [--clear]` lists or clears them; `--no-notes` skips hints
  once. Notes are off by default: `BROWSERCTRL_NOTES=on` turns them on, `=quiet` records
  without hinting (`BROWSERCTRL_NOTES_DIR` moves the store).
- Intent targets, expectations, `--until` and `--dismiss` need `TYPESAFE_API_KEY` (see
  [Jev](#jev)). Exact names work without it; overlay checks are then skipped.

### Compare, rank or check several items

Read this when the task compares list items and the site can't sort or filter by what it asks.
Put the comparison in the plan, after the steps that reach the list:

| The task asks for | Plan form |
| --- | --- |
| The cheapest, newest, highest-rated… when the site cannot sort by it | `'pick "lowest nightly price" top 1 as $h' 'answer "${h.title}"'` |
| Details of the first few results | `'for top 3 { extract "price"; extract "cancellation policy" }'` |
| The first result that meets a condition you can only see on its page | `'try pick "free cancellation" up to 3 => "free cancellation"'` |
| Every result that meets a condition | `'each "nonstop and under 6 hours" up to 10 { extract "price" }'` |
| Something only if the page shows it | `'if "the page lists refurbished models" { pick "largest discount" top 1 as $m } else { answer "none listed" }'` |
| A value compared with a limit | `'extract "total price" as number as $p' 'if $p < 200 { answer "under: ${p}" } else { answer "over: ${p}" }'` |

Each item opens in a background tab and closes after; nothing in a loop commits. A ranked
pick's `${x}` renders the whole item row; `${x.title}`, `${x.link}` and `${x.key}` render its
title, link or sort value, and later steps can use them (`nav ${x.link}`, `click "${x.title}"`)
as literal values. `pick "first" top 2` takes the main list in page order. When the site
already sorts by the criterion, sort there and read the top item instead.

### Whole-task plans: `extract`, `pick`, `if` and alternatives

Each agent turn costs seconds of model time, so the fastest run is the one with the fewest
turns. When you can foresee the task to its answer, write it as one plan:

```bash
browserctrl do <tab> 'fill "Where" = "Manhattan"' 'key Enter' \
  'if "a cookie banner covers the page" then click "Accept all" | "Accept"' \
  'click "Sort by" | "Sort"' 'click "Price: low to high"' \
  'pick "the cheapest hotel rated 4 or more"' \
  'extract "the nightly price"' 'extract "the cancellation policy"'
```

- `extract "<what>"`: Jev chooses the line of the page (all of it, not just the screen) that
  answers `<what>`, and the report copies it verbatim under `extracted:`. Jev never writes an
  answer, so a value is always text the page shows. Below 75% it is marked ⚠ with the other
  likely lines; when no line answers, the step is skipped and says so.
  Lines fit a size budget with page-wide coverage and heading context; values stay verbatim.
  If omitted lines remain and the answer is missing or uncertain, one retry checks them; the report shows coverage and whether it ran.
- `pick "<criterion>"`: Jev chooses the item of the page's main list (ads left out) that fits
  best, judged from each item's own text: prices, ratings, dates, labels. It opens the item's
  link, or clicks it. When none fits, the plan stops with the closest items.
- `if "<condition>" then <step>`: runs `<step>` only when the page shows the condition;
  otherwise the step is skipped (–), and the plan goes on.
- `click "A" | "B"`: alternatives for one control; the first exact name on the page is used
  with no model call, otherwise Jev looks for either.

All four normally ask in the step's one Jev request; extraction may retry as described above. They need a TypeSafe
key. Keep criteria to what the items' text shows: "under $200 with free cancellation" works;
"the best value" asks Jev to weigh things it cannot see.

On Codex, a `do` that runs longer than the shell's 10 s wait comes back empty and costs a turn
to collect: pass a longer wait (`yield_time_ms` 30000) for long plans, then collect the command result.

### Blocks, variables, typed extraction and answer

A plan argument may contain a block. Separate its steps with newlines or `;`.
Quotes protect braces, `;`, `=>`, `|` and `$`. The whole plan is parsed before
any page action; syntax errors report a step path and line/column. Unknown or
possibly undefined variables, duplicate bindings and more than two nested
conditional blocks are rejected before execution.

```bash
browserctrl do <tab> 'if "a size selector is shown" {
  select "Size" = "M";
  extract "availability"
} else {
  extract "available sizes"
}'
```

A page condition is evaluated once when entering the block, in the same Jev
request as the pending `=>` check and blocker questions. A pending check must pass
before the branch runs. The block runs its `then` branch at p >= 0.75 and its
`else` branch at p <= 0.25. Any middle, missing or invalid result stops with
`condition unresolved`. The old `if "condition" then <step>` still uses 0.5.
Only the selected branch runs; a failure never tries the other branch. Reports
name the selected and skipped sides, with child paths such as `3.then.2`.

```bash
browserctrl do <tab> 'extract "nightly price" as number currency SGD as $nightly' \
  'if $nightly < 200 {
    extract "cancellation policy" as $policy;
    answer "Nightly price: ${nightly}. Cancellation: ${policy}"
  } else {
    answer "The nightly price is ${nightly}; it exceeds the budget."
  }'
```

`extract "<what>" as $name` groups agreeing observed candidates before binding.
The winning group's summed p must be >= 0.75, or >= 0.5 with every competing
value group <= 0.15. The chosen line is the group's highest-p member; the
report includes its members and summed p. Untyped groups conservatively
normalize case, whitespace, letter-digit boundaries and punctuation other than
numeric separators/signs, removing only singular/plural Star/Fork/button UI words. Different
answer words, numbers or dates remain distinct. A missing or uncertain binding
stops before dependent input and reports candidate lines/groups, probabilities
and the missed bar. Ordinary extraction without a binding keeps its existing
null/unsure behavior. Bindings are immutable and local to the run. Branches
have child scopes, so a name defined only inside a branch cannot be read after
the block. Outer bindings remain readable inside it.

An unquoted whole value `$name` substitutes into `fill`, `select` or `type`.
For example, `'fill "Maximum price" = $nightly'` sends the numeric value, while
an untyped binding sends its entire chosen line. Substitution never creates
plan syntax or a target ref. Quoted dollar strings are literal, so
`'fill "Search" = "$nightly"'` types `$nightly`. Keep the whole CLI argument
single-quoted so the shell cannot expand it. In `answer` alone, `${name}`
interpolates a binding and `\${name}` renders the literal `${name}`.

Comparisons support `==`, `!=`, `<`, `<=`, `>` and `>=` between variables and
literals. They run locally without a Jev question. Text equality is exact;
ordering requires compatible numbers or dates. A typed date can be compared
with an explicit quoted ISO date, such as `if $arrival < "2026-10-20" { … }`.
Currency and units must agree between bindings, and values
are never implicitly coerced or converted.

```bash
browserctrl do <tab> \
  'extract { price: number currency SGD, cancellation: text } as $offer' \
  'extract "check-in date" as date as $arrival' \
  'answer "Offer: ${offer}. Check-in: ${arrival}."'
```

Typed extraction parses observed text locally and groups by typed value with
currency/unit, or by date, using the same probability rules for every required
field. A record asks one choice question per field in the step's one request.
The report keeps raw text, source line, probability and typed value; failed
bindings also report parse failures. Numbers support localized separators and explicit currency;
compact `k`/`K`, `M`, `B`, `lakh` and `crore` scale the value (for example,
`3.3k` becomes 3300), retaining raw text and a note that the page rounded it;
dates become ISO dates. A single comma or dot followed by three digits is a
thousands separator; mixed separators use the final separator for decimals.
Ranges, several numbers, ambiguous required currencies or dates
such as `03/04`, and missing required currency stop the plan. No year or
exchange rate is inferred.

`answer` renders only bound values into the separate `answer:` report field,
including `--json`; it sends no message and asks no model question. It drains
pending checks first. A later failed final check marks the answer provisional.
The run stops with partial results after 100 executed leaf steps or its
120-second deadline. A limit stop never reports overall success.

```bash
browserctrl do <tab> 'for top 3 {
  extract "price" as number currency SGD as $price;
  extract "cancellation" as $policy
}'
browserctrl do <tab> 'each "rated at least 4 with free cancellation" up to 3 {
  extract "price", "cancellation"
}'
browserctrl do <tab> 'pick "lowest listed price with free cancellation" top 3 as $choices'
```

`for top N` visits the first N organic linked items in the current main list's
page order. `each "<criterion>" up to N` selects matching items from that list
using listing evidence. Bounds must be literals from 1 to 10; loops cannot
nest or contain `click!` or `select!`. The runner freezes the source list once,
excludes ads using the same rules as `--open`, and deduplicates identical links
while preserving query strings. Ambiguous groups or missing detail links stop.
It opens each item in its own background tab, runs the body sequentially and
closes only tabs it opened. The source tab stays unchanged. There is no implicit
pagination or scrolling for more items.

`each` asks one membership question per item in the loop-entry request, with
pending checks and blocker questions. It accepts p >= 0.75, rejects p <= 0.25
and stops when an undecided item affects the selected prefix. Input is capped at
200 items; a selection that requires unseen items stops with truncation reported.
Consecutive extraction steps on the same detail page share one Jev request,
with separate `extract.<name>` choices and any pending check. Each iteration has
a fresh child scope; its bindings appear in its item record and do not escape.
Reports show stable paths such as `2.item[1].3`, an item table and completed/requested
counts. Fewer available items reports `source exhausted`; a body failure preserves
completed rows and the failing item, then stops.

`pick "<criterion>" top K as $choices` returns item records without opening pages.
It asks for each item's eligibility and an observable numeric or date sort key in
one request, then sorts locally. Equal keys keep page order. Vague rankings and
missing keys stop; records include key, evidence, eligibility probability and
shortlist coverage. Ordinary `pick` still opens one item.

`try pick "<criterion>" up to N => "<expected>"` searches at most N candidates
from the first choice distribution. N is a literal from 1 to 3. For example:

```bash
browserctrl do <tab> 'try pick "free cancellation" up to 3 => "cancellation is free"'
browserctrl do <tab> 'try click "Reviews tab" up to 2 => "guest reviews are shown"'
```

Linked details open in owned background tabs, preserving the source page.
Tab-like controls require a captured previous state that can be restored and
verified. Each candidate must meet the normal grounding minimum, with `none`
retained in the original distribution. A settled expectation at p >= 0.75
accepts the candidate; p <= 0.25 permits the next candidate. Uncertainty,
exhaustion, page errors, dialogs, timeouts or failed restoration stop the plan.
After restoration the runner re-grounds and stops if candidate identities changed.
Retries never send commits, direct refs, item-id clicks, form submissions,
messages, cart changes or unknown buttons. Attempt rows retain the candidate,
check probability, restoration and rejection reason in text and JSON reports.

```bash
browserctrl do <tab> 'same page {
  fill "First name" = "Ada";
  fill "Last name" = "Lovelace"
}'
```

`same page` supports independent fills on a stable form. Non-exact targets share
one Jev request under `target.1`, `target.2` and so on, with any pending check and
blocker. Exact targets need no model. Before each input the runner verifies the
pinned identity, role, visibility and form. A redraw, navigation, overlay or new
validation invalidates remaining targets. The runner re-grounds only unfinished
fills on the current page. Completed fills are never replayed. Dependent fields,
chips, commits and checks that depend on an earlier input cannot be batched.

### Single actions

`click`, `fill`, `select`, `hover` and `check` also take the name a person sees, found the
way a `do` step finds it (the exact name, else Jev), so you need no `read | grep` for a ref:

```bash
browserctrl click  <tab> "Trust Policy"
browserctrl fill   <tab> "Search" "aeron"
browserctrl select <tab> "Country" "Singapore"
browserctrl check  <tab> "Remember me"          # ticks it; check <tab> --expect "…" is the page check
browserctrl click  <tab> "Delete user" --commit # a control that commits needs --commit (else exit 5)
```

Each prints one JSON object (`acted`, `target`, `page`). When it cannot pick with
confidence it acts on nothing, exits 3 and lists the candidates and the controls on screen,
as a `do` step does. An empty name (an unset shell variable) is a usage error (exit 2).

Every action also takes a ref or selector, positionally (`click <tab> ref_3`, `click <tab>
"#id"`, `fill <tab> ref_5 "text"`) or as `--ref ref_3` / `--selector <css>`, or `--x/--y`.
Refs keep meaning what your last `read` showed, even after a `do` read the page again. A
click on a ref waits until the element stops moving and lands where it is on top; if
another element covers it, the click is refused with what covers it (its own label or
input doesn't count). `fill` on a label follows it to its field; on anything else it
names the nearest field.

`read`, `text` and `items` wait up to 8 s for a loading page (skeletons, spinners,
`aria-busy`) and say how long they waited; `--no-wait` skips it. If a command says a
JavaScript dialog is open, run `browserctrl dialog <tab> --accept` (or `--dismiss`). If a
page stops responding, `browserctrl reload <tab>` recovers it: it stops the page's script
and reloads, restarts the renderer if needed, and as a last resort reopens the page in a
new tab, printing the id to use from then on (`read`/`text`/`items --recover` do the same).
A ref into a frame that loaded a new page is stale: read again.

```bash
browserctrl click <tab> --ref ref_3 --browser dia
browserctrl click <tab> --ref ref_3 --button right           # or --count 2, --mod cmd,shift
browserctrl hover <tab> --selector ".menu"
browserctrl fill  <tab> --ref ref_2 --value "Ada Lovelace"   # fires input + change
browserctrl select <tab> --ref ref_7 --label "Exporter"
browserctrl type  <tab> "literal text"
browserctrl key   <tab> Enter                                 # cmd+a, shift+Tab, Escape
browserctrl upload <tab> --ref ref_4 --files /abs/a.pdf,/abs/b.png
browserctrl scroll <tab> --dy 600
browserctrl scroll <tab> --in "Policy document" down   # a pane inside the page: down|up|end|top|<px>
browserctrl scroll-to <tab> --ref ref_9
browserctrl drag <tab> --from ref_1 --to ref_2
browserctrl act <tab> --steps '[{"action":"scroll","dy":800},{"action":"key","key":"Enter"}]'
```

`browserctrl act` batches actions and stops at the first failure. Add `--json` for machine-readable results.

## Wait for conditions, never sleep

For Chromium page readiness, use `ready` after navigation or attachment. It waits
for the current page without reloading it or selecting its tab. `focus` selects
the tab and may revive a discarded page; it is not a readiness check. Do not call
`focus` for every link in a review loop.

```bash
browserctrl ready <tab> --browser dia --until domcontentloaded --timeout 15000
browserctrl ready <tab> --browser dia --selector ".results" --text "Results"
```

Condition waits remain available:

```bash
browserctrl nav <tab> https://example.com --until networkidle   # load | domcontentloaded | networkidle | none
browserctrl wait <tab> --selector ".results"
browserctrl wait <tab> --gone ".spinner"
browserctrl wait <tab> --text "Saved"
browserctrl wait <tab> --url /success
browserctrl wait <tab> --network-idle --timeout 30000
```

A file download is a wait of its own; it needs no tab:

```bash
browserctrl click <tab> "Export CSV"
browserctrl wait --download --timeout 60000      # prints the file's path (~/Downloads; or --download DIR)
```

It takes the newest finished file that appeared in the last `--since` seconds (30, so the
click before it counts; `--since 0` for files from now on), and waits while one is still
being written (`.crdownload`). `nav`, `click`, `fill` and `do` steps already wait for the page
to settle and fill in, so no `sleep` is needed after them.

`wait` and `ready` exit 1 when the condition never held within the timeout (`-q` prints
nothing), so `browserctrl wait <tab> --text Saved -q && …` reads as a test.

`--selector` and `--gone` mean *visible*, not merely present in the DOM. A
`display:none` node that is already in the markup would otherwise satisfy the
wait instantly and hand you a page that has not updated. Add `--present` when
existence really is the condition you mean.

`reload` reloads the current URL without activating the tab and waits for the
new document. Choose `--until load`, `domcontentloaded`, `networkidle` or `none`;
the timeout defaults to 30000 milliseconds. `ready` only observes the existing
page. `focus` selects it without reloading. `refresh` aliases `reload`; focus
needs no additional approval flag.

## Background tabs render

A hidden tab runs no `requestAnimationFrame` or IntersectionObserver, so lazy
pages (Shopee search and product pages) stay skeletons, and macOS demotes its
renderer to background priority, where heavy machine load can stall it for tens
of seconds. `wake` makes a background tab render through focus emulation: the
page sees itself visible and focused, but the browser does not select the tab or
take OS focus. Use it when a page stays a skeleton; recipe tabs get it on every
run. It lasts until `wake --off` or a daemon restart, and never selects the tab;
use `focus` for that.

```bash
browserctrl wake <tab> --browser dia          # render without selecting; prints visibilityState
browserctrl wake <tab> --off --browser dia    # let it go hidden again
```

A rendering tab sees focus and visibility events, so chat sites may mark
messages read. `tabs` tags it `rendering` and never reports it as `←you`.

## See what happened

```bash
browserctrl shot <tab> /tmp/out.png            # add --full, or --ref ref_3 / --selector css
browserctrl console <tab>                      # console output + uncaught errors
browserctrl network <tab> --failed             # 4xx/5xx and failed requests
browserctrl cookies <tab>
browserctrl text <tab> --max-text 8000         # bounded visible text (20,000 by default)
browserctrl text <tab> --match '评价|平台'      # only lines matching a case-insensitive regex; exit 1 if none (--count, -q)
browserctrl text <tab> --region "Policy Document"            # a heading and what follows it, or a landmark: main, dialog, nav, aside "Filters"
browserctrl text <tab> --from "Policy Document" --to "Grants" # from the first line containing one text to the next containing the other
browserctrl text <tab> --tail 40                              # the last 40 lines (after the other ranges)
browserctrl table <tab> [--csv|--json|--jsonl]                # the main table or grid as header-keyed rows (TSV by default)
browserctrl find <tab> "Go to next page" --enabled -q   # exit 0 if an enabled control matches, else 1
browserctrl html <tab> [selector]
browserctrl eval <tab> "location.href"
```

Console and network are buffered by the daemon from the moment it attaches to
a tab, so reload after attaching if you need the events from page load.

## Background screenshot frames

Chromium can stop generating frames for background tabs on Windows. If a
background screenshot stalls, use `browserctrl shot <tab> output.png
--emulate-focus`. This temporarily
emulates page focus through CDP, then disables it after capture. It does not
activate a browser tab or an OS window, but the page can observe focus events.
Use it only when overriding that tab's focus emulation is acceptable. On a
[rendering tab](#background-tabs-render) the emulation stays on. A cleanup
failure is reported; inspect the tab before continuing. Focus emulation is not
a guarantee: Windows CI needed an active owned target for reliable capture.
Safari uses Apple's
separate screenshot implementation and does not support this option.

## Jev

Use Jev through `do`, `--intent` and `check`: you plan, Jev only finds elements and
judges page state. On seven real tasks, plans run with `do` were 30-68% faster to a
verified answer on every task with a chain of clicks or fills (chat, search and filter,
cart, order lookup) and tied on tasks that only read a list. Handing a whole task to
Jev (`jev-tool`) was never faster and finished none of 21 runs. Results:
[bench/RESULTS.md](../bench/RESULTS.md).

### Screenshot fallback

When text grounding finds no candidate, Jev chooses none, or its pick is below `--min-p`,
`do` can try one viewport screenshot for `click`, `hover`, `fill`, `select` or `set`.
Refs, items ids and CSS selectors never use it. The capture does not select the tab.
Failed or blank captures and dormant tabs skip it. `BROWSERCTRL_VISION=off` disables it.

This path sends the screenshot to pinned `jev-1.14.0`, even with another `TYPESAFE_MODEL`.
It adds about 3k input tokens, $0.0001 and 0.2-0.4 s only when the fallback runs.
TypeSafe calls images "dreamer-ready". The fallback requires visibility p ≥ 0.75,
box confidence ≥ 0.6 and a box covering less than 15% of the viewport, then applies
the usual visibility, hit and commit checks. A screenshot pick shows ⚠ unless visibility
p ≥ 0.9 and confidence ≥ 0.85. Canvas and unnamed targets allow only click or hover
at the point and always show ⚠. Check those results before relying on them.

### Intent targets and page checks (experimental)

Instead of reading the page to find a ref, name the element and let Jev pick it from
the page's controls in one ~0.4 s request:

```bash
browserctrl click <tab> --intent "the Grey colour option" --browser dia
browserctrl fill <tab> --intent "the search box" --value "aeron" --expect "results for aeron" --browser dia
browserctrl check <tab> [--expect "the price filter is open"] --browser dia
```

- An intent acts only when Jev's top pick has p ≥ 0.6 (`--min-p`). Otherwise it exits 3
  with the top candidates and their refs; pick one and act by ref. `check --expect` exits 1
  when the page does not show what was expected.
- An intent never clicks a control that can commit something (Buy, Send, Pay, Delete,
  Submit, Confirm…), even when the intent names it (exit 5). It returns the ref; if the user
  authorized the action, click it by ref or with `do` and `click! "<exact name>"`.
- After acting it reports yes/no probabilities for a challenge, a login wall, an error,
  a dialog and an empty state, plus `--expect`, from what is on screen. `check` runs the
  same checks alone. `--no-check` skips them. These are judgments; confirm the result
  you report.
- Needs `TYPESAFE_API_KEY` in the environment, or in `jev.env` in the config folder
  (`BROWSERCTRL_JEV_ENV` names another file). Jev (api.typesafe.ai) receives the intent, the page
  address and title, the candidate elements' roles, names and links, and up to 3,000
  characters of on-screen text. Exact names, refs and selectors need no key and send nothing.
  [settings.md](settings.md) lists the Jev settings.

Extraction joins visible block text, includes accessible attributes with their source, and retries a missing or uncertain extract/pick once for up to 3 seconds when the page is under 8 seconds old or still changing.

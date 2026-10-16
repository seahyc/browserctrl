---
name: browserctrl
description: Control explicitly selected Chromium browsers or Safari 27+ from the terminal or MCP. Use for page automation, browser QA, or tab organization; macOS Dia supports dormant tabs. Safari uses Apple's separate automation session.
---

# browserctrl

Project source and issues: [seahyc/browserctrl](https://github.com/seahyc/browserctrl).

Invoke this skill as `$browserctrl`. The primary CLI is `browserctrl`; `cdp`
and `browserctl` remain compatibility commands. Legacy runtime paths under
`skills/chrome-cdp` have no SKILL.md and are not a second skill.

## Safari and platform selection

Select the browser explicitly. Chromium uses the existing CDP commands on macOS,
Linux and Windows. Windows uses named pipes and a PowerShell lock adapter, not
AppleScript. Automatic relaunch and screen video remain macOS-only. See
[compatibility and test evidence](docs/compatibility.md) before promising support.

For Safari 27+ on macOS, use `--browser safari` and the separate Apple MCP adapter.
Check `browserctrl safari tools --browser safari` for supported schemas. Safari
Settings must allow remote automation and external agents; obtain the user's
permission before granting that access. Do not restart Safari to fix an uncertain
operation. Read the returned error and re-observe before retrying an action.

```sh
browserctrl open https://example.com --browser safari
browserctrl tabs --browser safari
browserctrl reload <full-tab-handle> --browser safari --until load
browserctrl read <full-tab-handle> --browser safari
browserctrl safari call page_interactions --tab <full-tab-handle> --args '{"interactions":[{"type":"click","node":"42","purpose":"Open details"}]}' --browser safari
```

Safari calls use full native tab handles and node UIDs from Safari's own content
read, never Chromium `ref_N` values. Every page call needs an explicit handle;
the daemon checks the claim and serializes tab selection plus the call. Supply a
stable `CDP_AGENT_ID` for CLI workflows or `agentId` on every shared MCP call.
Release your claims at handoff. The MCP `browser_safari` tool supports `tools`,
`call`, `status` and `stop`; common browser tools also route supported operations
when `browser="safari"`. Unsupported operations fail explicitly. Python's
`ChromeCDP` client, tab grouping, dormant Dia tabs, recording, uploads and raw CDP
remain Chromium-only. Safari reload schedules `location.reload()` once through native JavaScript
evaluation and observes the new document. It is an adapter helper, not a direct
Apple MCP reload tool. Safari `focus` and `wake` both select the automation
context through `switch_tab`; normal Safari window foregrounding is not
guaranteed. Safari creates an automation session; do not assume access
to the user's existing Safari tabs or signed-in state. Verify background behavior
against a disposable page before offering an unattended workflow.

## Start here: reuse the shared connection

For every browser action, use this skill's CLI, MCP server, or SDK. They share
one daemon connection per browser. Do not create direct WebSocket clients or use
Playwright `connect_over_cdp` against the signed-in browser: those bypass the pool
and can trigger a fresh debugging approval for each connection.

1. Select Dia explicitly with `--browser dia` or MCP `browser: "dia"` when using
   the user's Dia session.
2. Choose one unique identity for this agent and keep it across all calls:
   `CDP_AGENT_ID` for CLI/Python, or `agentId` for MCP. Give sibling agents
   different identities, even when they share one MCP server.
3. Before bulk browsing, describe the work and its progress with `activity describe`.
   Read [activity and background readiness](references/activity.md) for status,
   pause/resume controls, and readiness checks. Open a background tab per agent
   and keep its returned tab ID. For an existing
   user-designated tab, read it first and respect its claim. See
   [Tabs and claims](#tabs-and-claims) for ownership and handoffs.
4. Keep the shared daemon running between actions and at task completion.
   Release your claims when finished. Do not stop the daemon, restart Dia, or
   open a direct connection to recover from a timeout. Observe current state
   through the pooled client before deciding whether to retry an action.
5. If approvals repeat, run `doctor --browser dia --watch-seconds 20` and inspect
   callers before changing the connection. See
   [Repeated debugging approvals](#repeated-debugging-approvals).

For CLI use, set `CDP_AGENT_ID` to your unique task identity on every invocation
(or export it once in a persistent shell), then run:

```sh
node ~/.agents/skills/browserctrl/scripts/browserctrl.mjs tabs --browser dia
```

One initial approval or a new approval after browser reconnection can still be
required. The pool cannot suppress approvals from clients that bypass it.

For a task on a page (search, filter, open, read a list), send the whole plan in one
`browserctrl do` call: see [Fastest way through a task](#fastest-way-through-a-task).
Guarded batches and the workflow runner are for filling the same prepared fields many
times; read the [batch contract](references/batch.md) and
[workflow contract](references/workflow.md) before using them.

Chrome DevTools Protocol control for agents. Two frontends over one core:

- **CLI**: `scripts/browserctrl.mjs <command>` (also `bin/browserctrl.mjs`)
- **MCP server**: `mcp/server.mjs`, exposing `browser_*` tools to Claude Code, Codex, or any MCP client

Prefer the MCP tools when they are available in your session: screenshots come back
inline, and `browser_do` / `browser_items` are the same `do` and `items` as the CLI.
The CLI is the fallback and the debugging surface.

## Pick a browser explicitly

There is no default browser and no sticky session file. A command without
`--browser` or `--port` fails and prints what is available. This is deliberate:
the old shared default is what made agents think they were driving Chrome while
they were driving Dia.

```bash
browserctrl browsers
# ✓ Dia       --browser dia       :9223  7 tabs  daemon up
# • Chrome    running, not debuggable -> open the toggle at chrome://inspect/#remote-debugging
#   Brave     not running
```

If the selected browser is not debuggable, inspect `browserctrl browsers` and use its
reported enablement instructions. Do not restart the user's signed-in Dia merely
to enable debugging. `browserctrl launch <browser>` quits and relaunches that browser's real
profile with its debug port; use it only when the user has authorized that restart. It reports
`"ready": true` only after the debug port answers (reopening once if the first launch was swallowed
by the quitting instance) and fails loudly otherwise; it never claims success on a browser that did
not come back.

`browserctrl launch <browser> --user-data-dir <dir>` instead starts a separate instance on its own
profile and leaves the user's running browser untouched. Chrome 136+ refuses a debug port on the real
profile, so `launch chrome` without `--user-data-dir` refuses before quitting anything and points to
the `chrome://inspect/#remote-debugging` toggle or the separate-profile option.

## Sharing tabs with the human

Three ways to mean the same tab, so a person and an agent can talk about one:

```bash
browserctrl tabs --browser dia         # the human's tab is flagged ←you
browserctrl read active --browser dia  # "the tab I am looking at", no ids involved
browserctrl name <tab> checkout --browser dia   # then --tab checkout works for both
```

**Marks are how the human hands over tabs they are not on.** A mark is not a
claim: a claim is the agents' mutual exclusion, a mark is the human's
instruction. They expire after 8 hours.

```bash
browserctrl mark "review-app" --note "check the empty state" --browser dia   # by URL substring
browserctrl tray --browser dia          # a page listing every tab with a checkbox each
browserctrl marks --browser dia
browserctrl read marked --browser dia   # the agent resolves the handover
```

## Annotation: point at elements for the agent

```bash
browserctrl overlay <tab> --browser dia   # arm it; the human presses option+A in the page
browserctrl annotations                   # what they marked
browserctrl annotations --consume         # once you have acted on them
```

In annotate mode, hovering outlines elements and clicking one opens a note
field. Each annotation carries the note, the element's role, accessible name,
test id and several selectors, a cropped screenshot, and which tab it was.
Annotating a tab marks it too.

Delivery to the agent, in order of portability: the `browser_annotations` MCP
tool works everywhere; every `browser_*` result appends a line when the queue
is non-empty, which needs nothing from the harness; and in Claude Code a
`UserPromptSubmit` hook puts them in front of the agent automatically.

When Dia's ordinary tab list omits a dormant tab, or a task needs exact
native-tab selection and grouping, read the [Dia native tab reference](references/dia-native.md).
It covers adapter capabilities and background-first grouping. Native focus fallback
requires explicit `--allow-focus`; use it only when temporary foreground selection
is within the user's requested scope.

Transport note, because it is not obvious: the overlay hands data back through
a **CDP binding**, not `fetch`. Current Chromium blocks an HTTPS page from
calling loopback (Local Network Access), so an HTTP bridge call from a real
site silently hangs. The extension path uses its background worker instead,
which is exempt.

## Recording a play

```bash
browserctrl record arm --browser dia      # optional: opens the capture device now, so
                                  # `start` is instant and the first ~2s are on film
browserctrl record start --browser dia --video --label "shortlist flow"
# ... drive the browser, and anything else on screen ...
browserctrl record stop
browserctrl recording <id> --steps        # readable steps with element identity
browserctrl annotate <id> --browser dia   # mark moments on the video
browserctrl recording <id>                # marks resolved to real events
```

`record arm` is opt-in on purpose: an armed capture writes video continuously
whether or not you ever record. `browserctrl record status` says whether one is warm,
`browserctrl record disarm` stops it.

Three layers on one clock: browser events with element identity, an optional
screen video, and a frontmost-app sample each second so time spent outside the
browser is still legible. A mark at 0:42 comes back as "click on button
'Confirm and apply' [data-testid=wb-confirm]", not as a frame number.

## Recording a run to watch later

`record` above captures a person's play across the browser. To keep an agent's run
on one tab, small enough to keep every run, use `rec`:

```bash
browserctrl rec start <tab> --browser dia [--out DIR] [--label L]   # until stopped, across navigations
# ... drive the tab with any browserctrl command ...
browserctrl rec stop <tab> --browser dia      # prints the directory and its size
browserctrl replay DIR                        # one self-contained HTML: DOM replay + step timeline
browserctrl replay DIR --video run.mp4 --gif run.gif   # real-time video: plain-words captions, clock, "Thinking…" gaps
browserctrl replay --side-by-side DIR_A DIR_B --labels "Without,With" --video ab.mp4 --gif ab.gif   # one clock, "Done in m:ss"
browserctrl rec om2w DIR --task-id ID --task "…" --answer "…" --root R   # Online-Mind2Web judge input
```

A recording is rrweb DOM events (`rrweb.ndjson.br`, brotli) plus one 1280-px JPEG
still per action (`trajectory/`, listed in `steps.jsonl`). Every acting command (and
`do`, per step) takes a still after waiting (up to 4 s) for the page to stop loading;
`read`, `text` and `items` add one when the page changed since the last still (address,
title or visible text). End a recorded task with one `read` so the final state is
captured. A 13-step
PyPI run came to 0.74 MB: 170 KB of events and 560 KB of stills. Stills show what DOM
replay cannot: canvas and cross-origin iframes. Videos are rendered in a private headless Chrome by seeking the
replay to each frame's time, so they keep the run's real timing however busy the machine
is; frames that did not change cost nothing. Pages load their images from the live site
during rendering: if the run went through a proxy (a geo-blocked site), pass the same one
with `--proxy socks5://…` (or `BROWSERCTRL_VIDEO_PROXY`). The GIF is sped up 4× by
default (`--gif-speed`) and kept under 8 MB; the MP4 stays real-time. Needs ffmpeg. The MCP tool is `browser_rec`. The
bench harness records every run into `bench/runs/<run>/rec/`.

## Use a recipe before driving a site's UI

A recipe calls a site's own API inside a tab on that site and returns structured
items in seconds. For a data task on a site (order history, inbox, search
results), look for one first with `browserctrl site <site or URL>`, which lists recipes
with their run command and then the site's flow notes; `open`, `nav` and `read` also
hint them.

```sh
browserctrl site shopee.sg                              # recipes, then flow notes
browserctrl recipe find "shopee orders"                 # recipes by words, local and tapped
browserctrl recipe run shopee.sg/orders --browser dia   # key=value args override params
```

Shared recipes come from taps, git repos of recipes:
`browserctrl recipe tap add https://github.com/seahyc/browserctrl-recipes`.

The daemon records fetch/XHR traffic from tabs you drive. When no recipe fits
and the task is worth repeating, do it through the UI once, then look at what the
page called and write a recipe from it:

```sh
browserctrl recipe endpoints shopee.sg                  # endpoint templates, counts, last seen
browserctrl recipe inspect shopee.sg get_all_order      # full exemplars: headers, tokens, bodies
```

Before writing or fixing a recipe, read [the recipe format](references/recipes.md).
Save a recipe only after `recipe run` returns the same facts the UI showed, and
record that in its `verified` field. Recipes whose `kind` is `write` change data:
follow the user's approval rules before running one.

Each in-page call has its own deadline (`timeout_ms`, 20 s). A `read` recipe that
stalls (tab, renderer or network did not answer) is retried once and reports
`retried`; a `write` is never retried. A failure names the phase it stopped in,
each phase's time and the machine load.

## Captchas and verification pages

Avoid triggering them. A challenge means the site is watching this browser, and
every reload or retry into it makes the next check harder:

- Prefer a recipe over driving a site's UI, and keep one warm tab per site
  instead of opening fresh ones.
- Never retry, reload or re-open a page into a challenge. Hand it to the human.

When browserctrl sees a challenge (captcha detection after `open`/`nav`, a step in
`do`, a recipe, or Jev's `challenge` flag from `check`/`do`), it starts a
**cool-down** for that site: 20 min, doubling for each further challenge that
day, up to 2 h. During it, `open`, `nav`, `do` with a `nav` step and `recipe run`
refuse the site with when it ends and why; reading tabs already open still
works. A challenge seen cleared ends the cool-down early. `--force` (MCP:
`force: true`) overrides; use it only when the user wants the site now.
`browserctrl cooldown` lists them (also shown by `tabs` and `doctor`);
`browserctrl cooldown clear <site>` ends one by hand.

To clear a challenge on a tab, run `browserctrl captcha <tab> --browser dia`
(MCP: `browser_captcha`). It drags an Alibaba drag-to-end slider once (and a
jigsaw puzzle slider, if the user enabled the solver for that site). Otherwise
it hands the tab to the human: brings it to the front, plays a sound, shows a
notification naming the site, and returns `solvedBy: human` with `waitedMs` as
soon as the challenge is gone (polled every second; `--timeout`, default 5 min).
On timeout, report the blocked tab rather than retrying. `do` and `recipe run`
do the same handoff when they hit a challenge; `--no-handoff` makes them stop
instead, `--handoff-timeout ms` bounds the wait.

Phone ping: if `BROWSERCTRL_NOTIFY_CMD` is set, the handoff also runs it through
the shell with the message as the last argument (`$BROWSERCTRL_NOTIFY_CMD
"<message>"`). browserctrl sends nothing itself. `BROWSERCTRL_NOTIFY=0` silences
the sound and notification; `BROWSERCTRL_NOTIFY_SOUND` picks another sound file.

### Opt-in jigsaw solver

Off by default. Only when the user asks for it for a site:

```sh
browserctrl captcha solver enable shopee.sg      # prints a warning; stored in ~/.config/browserctrl/captcha.json
browserctrl captcha solver status                # enabled sites and pinned selectors
browserctrl captcha solver disable shopee.sg
```

It defeats the site's bot check, may break the site's terms, and can escalate to
stronger checks. It makes one attempt, then hands the tab to the human. It
brings the tab to the front, screenshots the puzzle, finds the gap from the
image (matching the piece's picture, plus edges and shading), and drags the handle there at a human pace (probe, ease-out, overshoot
and settle). Element discovery is generic: a small visible handle (`role=slider`,
or class/id/aria-label containing slider/handle/drag/thumb/knob) on a wider track,
and the largest image/canvas near it as the background with a narrower one as
the piece. If a site's markup defeats that, pin selectors for it in the config
file:

```json
{ "solver": { "hosts": ["shopee.sg"] },
  "selectors": { "shopee.sg": { "handle": ".slider-btn", "track": ".slider-track",
                                "background": ".puzzle img.bg", "piece": ".puzzle img.piece" } } }
```

## Fastest way through a task

**Before planning on a site, look it up once:** `browserctrl site <site or page URL>`
(MCP `browser_site`). It lists the site's recipes first, with the exact `recipe run`
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

- Every `do` and `read` report ends with `url params`: the address parameters this page
  uses (its own query, GET forms, sort/filter/page links), and each step shows how it
  changed the address (`url: +state=closed`). Use them to jump straight to a filtered view
  with a `nav` step instead of clicking through filters again.
- A report whose steps all show ✓ did what it says, and `=> "<expected>"` checks were
  judged on the page: answer from it instead of re-reading the page to confirm.
- `--then items` shows the main list in full and folds the other groups to one line;
  `browserctrl items <tab> --grep "<regex>"` keeps only matching items.
- After a call that ends on a list, the first 3 item links start loading in background
  tabs (3 per site, closed after 90 s if unused); `visit` takes them already loaded.
  `--no-prefetch` or `BROWSERCTRL_PREFETCH=0` turns it off.
- If you can delegate, let a fast model run the mechanical `do`/`visit` calls of a plan
  you wrote and report back; keep planning and the final answer for yourself.

Read the page first only when you cannot guess the controls' names at all.

Lessons from hard live-site tasks (Online-Mind2Web, round 1):

- **Only the last step commits.** Adding to a cart or bag, choosing options and filling a
  form are not commits; the commit is the final pay, place-order, send or book button.
  After an add, check the page confirms it ("Added to bag", the cart count).
- **Filters whose options change after each pick** (chips that reorder, counts that
  update): one pick per `do` call, or the report's next step targets a control that moved.
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
  `nav <url>`, `wait <ms>`, `expect <what the page shows>`, and `date YYYY-MM-DD`.
- `date YYYY-MM-DD` picks a calendar day (open the picker first): it matches any day-cell
  label or text format, waits for a picker that is still opening (and opens a collapsed
  When / Check-in / Dates control itself if no calendar shows), and pages months to the
  date. A click that names a whole date ("Oct 17, 2026") does the same.
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
- `--repeat '<step>' --until "<page condition>"` runs after the plan: it repeats the
  step (usually `click Next`) until Jev judges the condition true, the step cannot be
  done (no Next button), or `--max` (10) repeats. `--collect items` returns the `items`
  of every page, merged and de-duplicated by link and text; `--collect text` the text.
- `--then items` or `--then text` returns the resulting page in the same call.
- Exit 3 means the plan stopped: the report names the step, the reason, Jev's
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
  `~/.local/share/browserctrl/traces/` (`BROWSERCTRL_TRACES` overrides).
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
  once, `BROWSERCTRL_NOTES=quiet` records without hinting, `=off` disables them
  (`BROWSERCTRL_NOTES_DIR` moves the store). MCP: `browser_notes`.
- Intent targets, expectations, `--until` and `--dismiss` need `TYPESAFE_API_KEY` (see
  [Jev](#jev)). Exact names work without it; overlay checks are then skipped.

### Single actions

Every action takes a ref or selector, positionally (`click <tab> ref_3`, `click <tab>
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
browserctrl scroll-to <tab> --ref ref_9
browserctrl drag <tab> --from ref_1 --to ref_2
browserctrl act <tab> --steps '[{"action":"scroll","dy":800},{"action":"key","key":"Enter"}]'
```

`browserctrl act` is the token-efficient batch equivalent of repeated `browser_act`
calls. It stops at the first failure and accepts the same action shapes as the
MCP tool. Add `--json` for machine-readable results.

## Wait for conditions, never sleep

For Chromium page readiness, use `ready` after navigation or attachment. It waits
for the current page without reloading it or selecting its tab. `focus` selects
the tab and may revive a discarded page; it is not a readiness check. Do not call
`focus` for every link in a review loop.

```bash
browserctrl ready <tab> --browser dia --until domcontentloaded --timeout 15000
browserctrl ready <tab> --browser dia --selector ".results" --text "Results"
```

MCP `browser_wait` accepts `readyState: "load"` or `"domcontentloaded"`. Existing
condition waits remain available:

```bash
browserctrl nav <tab> https://example.com --until networkidle   # load | domcontentloaded | networkidle | none
browserctrl wait <tab> --selector ".results"
browserctrl wait <tab> --gone ".spinner"
browserctrl wait <tab> --text "Saved"
browserctrl wait <tab> --url /success
browserctrl wait <tab> --network-idle --timeout 30000
```

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
browserctrl text <tab> --match '评价|平台'      # only lines matching a case-insensitive regex
browserctrl html <tab> [selector]
browserctrl eval <tab> "location.href"
```

Console and network are buffered by the daemon from the moment it attaches to
a tab, so reload after attaching if you need the events from page load.

## Browser-level control the protocol does not have

CDP drives pages. It cannot touch tab groups, bookmarks, history, downloads,
the reading list, sessions, or half of `chrome.tabs` (pin, mute, duplicate,
move, discard, zoom) — those exist only as extension APIs.

So the extension doubles as a permission carrier. There is no RPC protocol:
`browserctrl ext` attaches CDP to the extension's own service worker and evaluates
there, which means anything the manifest grants is callable without teaching
this CLI about it first.

```bash
browserctrl ext --browser dia                      # is it loaded, and what does it grant
browserctrl ext outline --browser dia              # every tab, annotated with its group
browserctrl ext group --url /merge_requests/42,/merge_requests/71 --title "Review" --color blue
browserctrl ext undo-close --browser dia           # restore the last closed tab
browserctrl ext apis --browser dia                 # every chrome.* function actually reachable
browserctrl ext api tabs.update '[123,{"pinned":true}]'    # generic invoker: any granted API
browserctrl ext api bookmarks.search '[{"query":"gitlab"}]'
browserctrl ext api downloads.search '[{"limit":5}]'
browserctrl ext eval "chrome.tabs.query({})" --browser dia # raw expression escape hatch

# Shortcuts for the extension-backed native tab-group API:
browserctrl group --url taobao.com,shopee.sg --title Shopping --color blue
browserctrl ungroup --url taobao.com,shopee.sg
```

The grouping helper includes every matching tab, not just the first match for
each pattern. Native grouping still requires the handoff extension; CDP alone
cannot access tab groups. For task-scoped research, group the tabs immediately
after opening them, keep a ledger of the tabs opened by the task, and close
those tabs before handoff; then ungroup the now-empty group. Never use a broad
URL pattern that could match the user's pre-existing tabs. If a tab is claimed
or protected, leave it open and report it rather than force-closing it.

`browserctrl ext api` is the one that keeps this honest: it dots into the `chrome`
namespace at runtime, so a permission added to the manifest is immediately
callable without touching the CLI. `browserctrl ext apis` lists what is genuinely
reachable, which turns "did I typo it or is the permission missing?" into a
question you can answer.

`browserctrl ext eval` takes any expression; a promise is awaited and the result comes
back as JSON. That is the escape hatch — reach for the named subcommands when
they fit and `eval` when they do not.

This needs the extension loaded (`chrome://extensions` -> Developer mode ->
Load unpacked -> `extension/`). Without it you get a message saying so rather
than a confusing failure. MV3 terminates idle service workers, so the
extension keeps a 30s alarm heartbeat and `browserctrl ext` retries a few times before
declaring it absent.

**The extension stays loopback-only on purpose.** `host_permissions` is pinned
to `127.0.0.1` and `localhost`, and `debugger` is refused; a test enforces
both. None of the APIs above need host access, so broad host permissions would
buy nothing and cost a great deal of trust.

## Tabs and claims

Up to ten agents have been tested concurrently, both as separate client processes
and through one MCP server. Give each agent a unique, stable identity: set
`CDP_AGENT_ID` for CLI/Python, or pass `agentId` on MCP browser calls. Keep that
identity across the agent's calls. Sibling agents must not inherit the same ID.
Without an override, the client uses its chat/session ID, then its process ID.

Open a separate tab for each agent and keep using its returned tab ID. New tabs
open in the background. Target commands, including reads that create snapshot
refs, acquire or renew a 15-minute lease. The daemon rejects other owners before
sending commands. Claims update under a process-safe file lock; another agent
cannot release your lease. Explicit `--steal` transfers an idle tab, but cannot
interrupt an in-flight action. Use handoff or release when sharing a tab deliberately.

Input requests serialize within a tab and briefly emulate focus without selecting
it in the browser UI. Background scrolling uses the page's scrollable element
instead of a wheel event; foreground scrolling retains wheel events.

Structured extension inspection (`ext outline`, `tabs.query`, `tabGroups.query`,
and `tabGroups.get`) can run alongside other agents. Exact `tabs.group`,
`tabs.remove`, `tabGroups.update`, and `native-group` operations check claims
for every selected tab and destination group member. They refuse changes that
affect another owner, including ambiguous duplicate URLs. Scoped mutations
serialize with each other while unrelated page actions continue. Arbitrary
extension evaluation and other browser-wide control still require exclusive
access because they can affect tabs outside the caller's ownership.

Agents still share Dia's cookies, account sessions and website storage; tab leases are coordination, not
isolated accounts or a security sandbox.

After upgrading from clients without identity support, reload their MCP servers.
The daemon rejects identity-less target commands with a reload instruction;
a fresh CLI process uses the new protocol immediately.

```bash
browserctrl open https://example.com --browser dia
browserctrl open https://example.com --browser dia --anonymous
browserctrl tabs --browser dia            # shows [claude-code (3m ago)] on claimed tabs
browserctrl claims
browserctrl release <tab> --browser dia   # or: browserctrl release --mine
browserctrl close <tab> --browser dia
browserctrl focus <tab> --browser dia     # select the tab without reloading
browserctrl wake <tab> --browser dia      # render in the background without selecting
browserctrl reload <tab> --browser dia --until load --timeout 30000
browserctrl status --browser dia          # daemon state
browserctrl stop --browser dia            # stop the daemon for that port
```

Use `--anonymous` for signed-out and clean-session testing. It opens a temporary
isolated browser context with none of the profile's cookies or site storage, so
it does not sign the human out or alter their ordinary tabs. `browserctrl tabs` labels
the tab anonymous, and `browserctrl close` disposes the entire temporary context. This
is isolation, not an authentication bypass: complete the site's normal login
and consent flow when required.

On the registered local Dia endpoint, closing an anonymous tab first closes its
native single-tab window, then disposes the Chromium context after its pages are
gone. Dia 1.49.1 can crash if CDP disposes a context while Dia is creating a
replacement tab. Listing/resolving tabs therefore never performs context cleanup.
If the native window cannot be uniquely matched (including internal new-tab URLs,
duplicate URLs, or multiple tabs), cleanup fails safely and retains ownership;
close that private window normally. Local native-window cleanup does not apply
to forwarded/custom endpoints. After updating this code, existing MCP server
processes must be reloaded to pick up operation changes, or use a fresh CLI process.

### Browser profiles

One debug port serves every profile of that browser (Work, Personal, ...).
Profile names come from the browser's `Local State`, found from the running
process, so `--user-data-dir` instances and explicit `--port`s work too.

```bash
browserctrl profiles --browser chrome
# Default      Work                     12 tabs  [default: new tabs land here]
# Profile 1    Personal                 no window
browserctrl tabs --browser chrome                       # profile column per tab
browserctrl tabs --profile work --browser chrome        # only that profile's tabs
browserctrl open https://example.com --profile Personal --browser chrome
```

`--profile` takes the directory, the account email, the display name, or a unique name prefix; an
ambiguous or unknown one fails with the list. MCP: `browser_profiles`, and a
`profile` argument on `browser_tabs` and `browser_open`.

CDP names no profile, so each one is identified once per browser launch by
loading `chrome://version` in a brief background tab inside it and reading its
Profile Path (cached per port). Expect that tab to flash in each profile's tab
strip on the first `tabs`/`profiles` call; single-profile browsers skip it.
`open` in a profile with tabs opens a background tab there; this makes it the
browser's last-used profile. A profile with no window is opened by launching
the browser app with `--profile-directory` (macOS `open -na`), which raises a
new window in it; this needs a local browser process, not a forwarded port.


## MCP tools

Same capabilities, typed. Register once:

```bash
# Claude Code
claude mcp add browser -- node ~/.agents/skills/browserctrl/mcp/server.mjs

# Codex
codex mcp add browser -- node ~/.agents/skills/browserctrl/mcp/server.mjs
```

Tools: `browser_list`, `browser_tabs`, `browser_open`, `browser_close`,
`browser_read`, `browser_navigate`, `browser_wait`, `browser_focus`,
`browser_reload`, `browser_do`, `browser_items`, `browser_visit`, `browser_act`,
`browser_screenshot`, `browser_diagnostics`, `browser_eval`,
`browser_annotations`, `browser_marks`, `browser_annotate_mode`,
`browser_record`, `browser_recording`, `browser_activity`,
`browser_recipe`, `browser_captcha`, `browser_profiles`.

`browser_refresh` remains an alias for `browser_reload`. `browser_wake`
(`off=true` to stop), `ops.wake(conn, tab, {enabled})` and the Chromium Python
client's `client.wake(tab, off=False)` render a tab in the background without
selecting it. The SDK uses `ops.focus` and `ops.reload`, with `ops.refresh` as an
alias. The Python client exposes `client.focus(tab)` and
`client.reload(tab, wait_until='load', timeout=None)`; `client.refresh` is an alias.

`browser_act` takes one action or a `steps` array that runs in order and stops
at the first failure. Screenshots return inline images to clients that render
them and always include the saved path, so Codex can read the PNG itself.

## Architecture

```
lib/discovery.mjs   which browsers are debuggable, and how to enable the rest
lib/daemon.mjs      one master daemon per port: browser WS, sessions, event buffers
lib/claims.mjs      atomic tab ownership leases across agents
lib/anonymous.mjs   contexts created by --anonymous, for safe whole-context cleanup
lib/profiles.mjs    browser profiles: Local State names, context -> profile probes, open in a profile
lib/state.mjs       human-set state: tab aliases and marks
lib/refs.mjs        the page snapshot and ref resolution
lib/ops.mjs         every operation, one function each
lib/overlay/        the annotation overlay, shared verbatim with the extension
lib/annotations.mjs the annotation queue
lib/recorder.mjs    recording lifecycle    lib/recstore.mjs  where recordings live
lib/bridge.mjs      loopback HTTP: tray page, video annotator, extension endpoint
lib/pages/          tray and video-annotator pages
bin/browserctrl.mjs         CLI frontend        mcp/server.mjs   MCP frontend
hooks/              Claude Code UserPromptSubmit hook
extension/          wraps the same overlay; adds a popup and browser shortcuts
```

A daemon per port holds one browser WebSocket, so Chrome's "Allow remote
debugging?" prompt fires once per session rather than per command, and console
and network events survive between invocations. It reconnects across a browser
restart and exits after 300 days idle. A new browser connection can still require approval.

All of this skill's CLI, MCP, and Python clients for one port reuse this daemon and browser
WebSocket. A kernel-held file lock gives one daemon ownership of each port and
is released automatically on process exit, including crashes. Startup reserves
the local socket before connecting to the browser;
concurrent clients wait for that connection, including its approval dialog.
Lock acquisition uses macOS `/usr/bin/lockf`, or `/usr/bin/flock` on Linux. The
small `.lock` file remains on disk; its existence does not mean a daemon is alive.
Tab attachments and domain initialization are shared across clients. Tab claims
still govern which agent may act; sharing a connection does not share ownership.

Recovery is demand-driven, with no periodic browser health checks. New clients
allow up to 30 seconds for daemon IPC liveness and 5 seconds for browser HTTP
discovery, avoiding replacement merely because the host is busy. They check
local status instead of sending a browser health command on every
connection. Older clients get a fast, explicitly unchecked transport status from
their legacy health handshake, so their shorter deadlines cannot retire a live
daemon. Updated `health()` and `doctor` wait for the full browser probe.
A command timeout triggers one shared browser-level probe, allowing
30 seconds for a response. Other browser replies during that window also prove
the transport is alive, so a slow health command does not force reapproval.
Commands default to a 30-second protocol timeout; explicit action timeouts still
apply. Target IPC deadlines include a separate 60-second initialization allowance for
attachment and domain setup. The requested action keeps its own protocol timeout;
initialization does not consume that action's timeout or trigger a replay.
For MCP integrations, allow at least 120 seconds for the enclosing tool call
when a tab needs initialization; a 60-second client deadline can expire first.
Keep action timeouts separate, and observe state after any uncertain timeout.
The Python sidecar's outer deadline includes the same initialization allowance
and the pending approval window, so it does not close a reusable connection
before the daemon can answer.
The daemon retires only when that window ends with no response or other request
progress. An approval handshake waits up to five minutes on the same connection
before failing; concurrent clients share that pending handshake.
Recordings carry the recorder process PID and start identity. A dead owner,
reused PID, or legacy recording without an owner is inactive; the daemon leaves
its saved recording intact and skips automatic tab instrumentation. Reload old
recording clients before starting a new recording.

A subsequent connection creates a replacement. If the daemon itself stops answering,
connection setup verifies its recorded PID, process start time, and socket ownership
before terminating it. Unverifiable ownership fails without killing a process.
Timed-out or interrupted actions are never replayed. Use `reconnect()` and make a
fresh observation before deciding whether an action needs repeating.

## Background screenshot frames

Chromium can stop generating frames for background tabs on Windows. If a
background screenshot stalls, use `browserctrl shot <tab> output.png
--emulate-focus` or MCP `browser_screenshot emulateFocus=true`. This temporarily
emulates page focus through CDP, then disables it after capture. It does not
activate a browser tab or an OS window, but the page can observe focus events.
Use it only when overriding that tab's focus emulation is acceptable. On a
[rendering tab](#background-tabs-render) the emulation stays on. A cleanup
failure is reported; inspect the tab before continuing. Focus emulation is not
a guarantee: Windows CI needed an active owned target for reliable capture.
Safari uses Apple's
separate screenshot implementation and does not support this option.

## Tests

```bash
cd ~/.agents/skills/browserctrl && npm test
```

The suite drives a throwaway headless browser on port 9333 with its own
user-data-dir, so it never touches a real profile. It also checks that every
command documented here exists in the CLI: v1 shipped docs for `net`, `loadall`
and `snap --compact`, none of which existed.

## The extension

`extension/` is loaded unpacked from `chrome://extensions` (Developer mode).
Its toolbar click is the primary path: it immediately enters annotation mode.
It also provides browser-level shortcuts (option+A annotate, option+M hand over
this tab), and a right-click toolbar menu for the less-common whole-tab and
multi-tab handoffs. After saving a note, send “review my browser handoff” in
the agent task. If the bridge is temporarily unavailable, the extension retains
the note and retries it rather than falsely confirming it.
It carries no annotation logic: `extension/annotate.js` is a verbatim copy of
`lib/overlay/annotate.js`, refreshed with `npm run sync-extension`, and a test
fails if the two drift.

## Gotchas

- Only loaded tabs appear in `browserctrl tabs`. A tab discarded by memory saver needs
  `browserctrl focus` (or a click in the browser) before it responds.
- Screenshots are native resolution: CSS px = image px / DPR, and `shot` prints
  the DPR.
- `browserctrl type` inserts text at the current focus and works inside cross-origin
  iframes, where `eval` cannot reach.
- Element refs come from one snapshot. If the page re-renders (a modal opens, a
  list reorders), read again before acting.
- The overlay and the recorder refuse to install twice, so after changing
  either, use `browserctrl overlay <tab> --force` or start a fresh recording rather
  than expecting a silent upgrade.
- A daemon started before a code change keeps running the old logic. Clients
  compare a code version on connect and restart a stale daemon, which is why
  you may see "restarting the daemon" after editing `lib/`.
- Screen recording needs the macOS permission once, granted to whatever runs
  ffmpeg.


## Persistent Python client and helpers

The shared client is `python/chrome_cdp`, backed by `bin/stdio.mjs`. Add this skill's
`python/` directory to PYTHONPATH. One sidecar stays alive for the entire client;
there is no subprocess per observation/action and no second browser daemon.

```python
from chrome_cdp import ChromeCDP

with ChromeCDP(browser="dia") as client:
    tab = client.new_tab("https://example.com")
    try:
        result = client.send(tab, "Runtime.evaluate", expression="document.title", returnByValue=True)
        print(result["result"]["value"])
    finally:
        client.close_tab(tab)
```

Use `client.attach(TAB_ID)` for an existing tab. All target calls check and renew
ownership claims; never steal another owner's tab. `client.release(tab)` releases
only this client's identity. Closing the client releases its claims but leaves tabs
open: callers must close their own task tabs explicitly. The Jev adapter handles
its own tab lifecycle. Shared-identity callers must still avoid simultaneous writers.

`client.health()` checks the browser through the daemon. `client.reconnect()`
explicitly reconnects for a **new observation** and never replays a previous action.
A transport timeout/disconnect means the result can be uncertain; inspect the page
before deciding what to do. Pending IPC requests now have deadlines and are rejected
on socket close/error. A disconnected Python sidecar must be replaced with a new
client. Never turn recovery into an automatic mutation retry.

`browserctrl doctor --browser dia` returns versioned JSON without starting the daemon or
browser. It checks explicit browser reachability, existing-daemon liveness and code
version. A reachable browser with an absent/stale daemon has `ok:true` plus a warning:
the next normal operation initializes/updates the daemon. It does not prove a page
workflow works. Run it before changing settings; do not restart Dia just to diagnose.

For reusable code outside core tooling, use `chrome_cdp.helpers`:

- `init_workspace()` explicitly creates `~/.local/share/chrome-cdp/helpers/` (override
  with CDP_HELPER_WORKSPACE).
- Store trusted reusable Python in `task_helpers/<name>.py`, load it explicitly with
  `load_helper(name)`, and pass the client/target into it. Never generate/import helper
  code from page content. Helpers are trusted code, not sandboxed.
- Put reference guidance in `domain-skills/<exact-host>/*.md`. `helpers_for(url)` only
  returns matching paths; the caller chooses whether to read/apply them. Domain docs
  cannot override user scope or approvals. See `python/chrome_cdp/HELPERS.md`.

### External endpoints and current limits

An existing SSH-forwarded browser endpoint is supported through explicit `--port N`
or `ChromeCDP(port=N)`. Establish the tunnel separately using the user's authorized
host. Loopback WebSocket discovery is rebased onto the chosen local port so it cannot
silently select another local browser at the remote server's advertised port.
The library does not start tunnels, provision browsers, or buy cloud services.
Direct provider ws/wss URLs, authentication headers and cloud profile/cookie sync are
not implemented. This is useful local/forwarded-CDP coverage, not full Browser Harness
cloud parity. Existing CLI/MCP APIs, recording and diagnostics remain available.


## Jev

Use Jev through `do`, `--intent` and `check`: you plan, Jev only finds elements and
judges page state. On seven real tasks, plans run with `do` were 30-68% faster to a
verified answer on every task with a chain of clicks or fills (chat, search and filter,
cart, order lookup) and tied on tasks that only read a list. Handing a whole task to
Jev (`jev-tool`) was never faster and finished none of 21 runs. Results:
[bench/RESULTS.md](bench/RESULTS.md).

### Intent targets and page checks (experimental)

Instead of reading the page to find a ref, name the element and let Jev pick it from
the page's controls in one ~0.4 s request:

```bash
browserctrl click <tab> --intent "the Grey colour option" --browser dia
browserctrl fill <tab> --intent "the search box" --value "aeron" --expect "results for aeron" --browser dia
browserctrl check <tab> [--expect "the price filter is open"] --browser dia
```

- An intent acts only when Jev's top pick has p ≥ 0.6 (`--min-p`). Otherwise it exits 3
  with the top candidates and their refs; pick one and act by ref.
- An intent never clicks a control that can commit something (Buy, Send, Pay, Delete,
  Submit, Confirm…), even when the intent names it. It returns the ref; if the user
  authorized the action, click it by ref or with `do` and `click! "<exact name>"`.
- After acting it reports yes/no probabilities for a challenge, a login wall, an error,
  a dialog and an empty state, plus `--expect`, from what is on screen. `check` runs the
  same checks alone. `--no-check` skips them. These are judgments; confirm the result
  you report.
- Needs `TYPESAFE_API_KEY` in the environment or in `BROWSERCTRL_JEV_ENV`
  (default `~/Code/jev-ultrafast/.env`). Jev receives the intent, the candidate
  elements' roles, names and links, and up to 3,000 characters of on-screen text.

## Opt-in lifecycle diagnostics

Set `CDP_DIAGNOSTIC_LOG=/absolute/local/path.jsonl` when starting a fresh daemon.
The diagnostic writer records command names, lifecycle IDs, replies and disconnects;
it excludes URLs, page content, scripts, headers, cookies and error messages.
The log stops growing at 10 MiB. Existing daemons retain their startup environment.
This is diagnostic evidence, not proof that a browser workflow is healthy.

### Repeated debugging approvals

First verify the caller follows [Start here](#start-here-reuse-the-shared-connection).
A skill update does not change a running agent's loaded instructions; have it
reload this file before continuing. An old MCP server must also be reloaded to
pick up code changes, or use a fresh CLI process.

`doctor` now reports existing TCP clients and executable ancestry using passive
OS inspection. TCP observation alone cannot distinguish HTTP discovery from a
debugging WebSocket or count approval dialogs. Doctor excludes its own HTTP
discovery connection. `browserctrl doctor --browser dia --watch-seconds 20` saves a bounded
incident capture (maximum 60 seconds). It does not open a debugging connection,
start a daemon, or install a recurring check. Very short connections can be
missed; an empty capture does not prove there were no prompts. The normal doctor
health check uses an existing daemon connection when available.

Daemon lifecycle logs are enabled by default under
`~/.local/share/chrome-cdp/telemetry/`; override with `CDP_TELEMETRY_DIR`, or disable
lifecycle logging with `CDP_TELEMETRY=0`. Logs contain connection lifecycle,
request timing and protocol method metadata, with hashed agent identities; no
page content, URLs, JavaScript, parameters, cookies, or full process arguments.
Logs rotate and incident captures retain the latest 20 files, at most 1 MiB each.
Capture is explicit and still works when lifecycle logging is disabled. Existing
daemons pick up logging on their next replacement; historical connections are
not reconstructed. A missing stop record may indicate an abrupt exit, but does
not by itself prove a crash. Keep a capture when reporting repeated prompts.

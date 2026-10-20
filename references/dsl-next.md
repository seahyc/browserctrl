# Next additions to `do`

Phase A is implemented: plan blocks, `if` / `else`, variables and local
comparisons, typed extraction, and `answer`. Existing one-step and inline `if`
plans remain supported. Phase B, part 1 implements item loops, ranked top-k
reads and batching of consecutive detail-page extractions in loop bodies. Candidate retries and
same-page action batching remain proposals, not supported syntax.

## Aim

In the 19 measured benchmark runs, the median task took 138 s and 17 agent turns.
Model time was 43% of wall time, about 2.7 s per turn; Codex exec overhead was 24%.
Jev was about 2.6%. Settling took 47% of the time inside `do`.
Tool-side speedups cap near 2.7x. A 10x task speedup needs about 3–4 agent turns.

Remove decisions the agent now makes between calls. Keep the language small enough
to write correctly on the first try. A wrong ten-step plan costs more than two
correct turns. These estimates are hypotheses for tasks that use the addition,
not measured gains or savings on every task. They overlap; do not add them up.

| Order | Addition | Agent turns saved per applicable task | Main risk |
| --- | --- | --- | --- |
| 1 | Loop over items and extract | 4–10 for three detail pages | Wrong list or repeated item |
| 2 | Variables and comparisons | 2–4 | Reusing a whole line as a field value |
| 3 | Block `if` / `else` | 1–3 | Treating uncertainty as false |
| 4 | Try next safe candidate | 1–3 per failed choice | An action cannot really be undone |
| 5 | Typed extraction | 1–2 | Ambiguous units or dates |
| 6 | Ranked top-k read | 1–2 | Choice probability mistaken for item quality |
| 7 | `answer` template | 0–1 | An unsupported answer looks final |
| 8 | Several same-page groundings | Usually 0; sometimes 1 | Stale targets after an earlier action |

Use a recipe or a known address first. Existing `visit` and `--open N` already
handle plain linked detail pages. Loops earn their place when selecting items or
interacting inside each page would otherwise return control to the agent.

## Execution contract

The plan parser sits above `parseStep`, which parses individual steps.
`runSteps` traverses blocks and runs leaf steps through `runOne`. `perform` uses `askJev` to bundle the target, `prev_expect`, blocker,
notes and judgment questions. `judgments.mjs` builds `extract`, `pick` and `if`;
`judge.mjs` maps choices back to observed lines and items. `systemOne` accepts a
map of questions. Keep this boundary: Jev chooses evidence; the runner controls
execution. It never asks Jev to write a program or invent a value.

One argument may contain a complete block. Newlines or semicolons separate
steps inside braces. Quotes protect braces,
semicolons, `=>`, `|` and `$`. Keep old one-step arguments and inline `if` syntax.
Parse the entire plan before touching the page. Report syntax errors with a step
path and line/column. Reject unknown variables, invalid bounds and unsupported
nesting before execution where possible.

Phase A allows at most two nested conditional blocks. It caps executed leaf
steps at 100 and gives the run a 120-second deadline. Reaching a cap returns
partial results and a stop, never success. Existing per-step recovery limits
still apply. Item loops allow one level and at most 10 items; proposed
candidate retries allow at most 3 attempts. Their bounds must be literal.

Questions about the current snapshot go in the existing `askJev` request under
distinct keys, beside `target`, `prev_expect` and `blocker`. A request cannot check
an action it has not seen. Settle after an action; check its `=>` in the next
request, before consuming that request's other answers or acting. Keep
`lastCheck` for a final pending expectation and page flags. Block, loop and retry
boundaries must also drain pending checks before declaring success or restoring
the page. Extra questions do not mean extra requests on the same snapshot.

Keep the commit guard unchanged, including its current exact-name, `!` and direct
ref rules. New features must not manufacture deliberate refs to bypass it.
Reject commits inside item loops and candidate retries in the first version.
An explicit commit outside them still uses the normal guard. Do not replay an
action after a timeout or uncertain delivery. Challenges, login walls, errors,
unhandled dialogs and failed checks stop the plan. Never guess a missing value,
target, unit, branch or recovery path.

## 1. Loop over items with extraction (implemented)

```text
for top 3 {
  extract "price", "cancellation"
}

each "rated at least 4 with free cancellation" up to 3 {
  click "Room details" => "room details are shown"
  extract "price", "cancellation"
}
```

`for top N` takes the first N organic items of the current main list in page
order. It does not mean the N best items. `each` takes up to N matching items in
page order, judged only from the listing evidence. It does not search further
pages. Ambiguous main groups stop with the groups to choose from. Use the same
ad exclusion rule as `mainLinks`, including Spotlight and item hints.

Freeze the source list once. Record item text, absolute link and source URL;
deduplicate identical links, preserving query strings. Do not reuse item ids
across navigation. Initially require detail links. Stop for unlinked cards rather
than inventing a route or trusting a reused DOM node.

Open each detail link in an owned background tab and run the body sequentially.
Keep the source tab unchanged. Close only tabs this loop opened, after saving
their results. No implicit pagination, scrolling for more items or tab takeover.
If fewer than N exist, report the count and `source exhausted`. A body failure
stops the loop with completed rows and the failing item; it does not silently
skip a bad page. A missing optional extraction remains a reported null.

For `each`, put one membership `noul` question per shortlisted item in the loop
entry request, beside the pending expectation and blocker. Accept membership at
p >= 0.75, reject at p <= 0.25, and stop on an undecided item that would affect
the selected prefix. Bound the input at 200 items; report truncation and stop
if the requested selection would require unseen items. `for top` needs no Jev
selection question. On each detail page, put all requested extraction choices
in one request as `extract.price`, `extract.cancellation`, using separate span
shortlists. Report the copied lines, probabilities and source item together.

Test list order, ad hints, duplicate links, query-distinct links, ambiguous groups,
zero/fewer items, truncation, SPA redraws, source-tab preservation, tab cleanup,
missing fields, uncertain membership and failure on item two. Assert one request
contains both extractions and the pending check; no result leaks between items.

## 2. Variables and comparisons (implemented)

```text
extract "price" as $p
fill "Max" = $p
extract "nightly price" as number currency SGD as $nightly
if $nightly < 200 {
  extract "cancellation"
}
```

An untyped binding holds the exact selected line, not a guessed substring.
`fill "Max" = $p` sends that whole string. If the page says `SGD 180 per night`,
use typed extraction to obtain `180` for a numeric field. Do not strip words just
because a field looks numeric.

Bindings are immutable and local to this run. Loop bodies get fresh child scopes;
their bindings appear in item records but do not escape into the next iteration.
An `if` branch also has a child scope. A later read of a possibly undefined
binding is a parse error. No environment variables, shell expansion, JavaScript,
implicit interpolation or cross-run storage. Quote the CLI plan so the shell
does not expand `$p`. Only an unquoted whole `$name` substitutes as a
`fill`, `select` or `type` value. Quoted dollar strings remain literal.
In `answer` templates, `${name}` interpolates and `\${name}` is literal.

Binding adds no question: attach its name to the existing extraction answer.
Require a valid observed choice with p >= 0.75 before binding; null, malformed or
unsure values stop before a dependent action. Keep ordinary unbound extraction's
current null/unsure report behavior. Substitution produces a value, never new
plan syntax or a target ref.

Support `==`, `!=`, `<`, `<=`, `>`, `>=` between variables and literals.
Text equality is exact. Ordering requires compatible typed numbers or dates;
currency and units must agree. Reject implicit coercion. Comparisons run locally,
without a Jev question. Report operands, types and result with evidence links.

Test scope, duplicate bindings, branch-only bindings, literal dollar signs, quoted
values, injection text, null and low-confidence extraction, exact fill payloads,
numeric order, incompatible currencies and date order. Verify no dependent input
occurs after a failed binding.

## 3. `if` / `else` blocks (implemented)

```text
if "a size selector is shown" {
  select "Size" = "M"
  extract "availability"
} else {
  extract "available sizes"
}
```

Evaluate once on entry. Run one branch, then continue after the block. A page
condition uses `conditionQuestion` in the entry step's existing request, with
`prev_expect` and blocker checks. Ground the selected branch's first action on
the page it will actually use. Do not ground both branches speculatively.
Variable comparisons use the local rules above.

For the new block form, true needs p >= 0.75, false p <= 0.25; the middle stops
with `condition unresolved`. Missing or invalid answers also stop. This is
stricter than today's inline `if`, which uses 0.5; keep its behavior for
compatibility and document the distinction. `optional` cannot turn an unresolved
condition into false. A branch failure never enters the other branch.

Report the condition, probability, selected branch and skipped branch. Number
children by path, such as `3.then.2`. Test true, false, middle probabilities,
missing answers, nested blocks, quoted braces, inline compatibility and failed
pending expectations. Assert no branch action runs before the previous check.

## 4. Try the next safe candidate (proposed)

```text
try pick "a hotel under SGD 200 with free cancellation" up to 3
  => "the nightly price is under SGD 200 and cancellation is free"

try click "Reviews tab" up to 2 => "guest reviews are shown"
```

This is bounded candidate search, not generic error recovery. It requires `=>`.
Start with linked item navigation. Add tab switches and filters only where the
runner can capture, restore and verify their exact previous state. A history
back is not proof that a filter, form or SPA state was restored.

Use the initial `pick` or `target` question's distribution to record distinct
candidates. Keep `none`; never renormalize it away. The candidates must pass
the existing minimum grounding rules and all required literal checks. A warning
between the allowed minimum and 0.75 may be tried only because the action is
independently safe and its explicit result will be checked. A probability below
the existing minimum still stops. A lower-ranked candidate is not permission to
click an unrelated control.

Check the settled result through `prev_expect` in the next request, before any
continuation. A clear failure at p <= 0.25 may try the next candidate; p >= 0.75
accepts it. An uncertain check stops. For detail links, use an owned temporary
tab so failure leaves the source unchanged. For tabs or filters, restore the
captured state and verify it with a restore question in that state's next request
before trying another candidate. Re-ground against the restored page; discard
stale refs and stop if candidate identities changed. Report exhaustion as a stop.

Never retry commits, `click!`, `select!`, direct refs, item-id clicks, form submits,
messages, cart changes or unknown buttons. A ref bypass in today's guard does
not qualify an action for search. Check safety before every attempt. An error,
challenge, dialog, timeout, uncertain delivery or failed restoration stops rather
than selecting the next candidate. Bound all attempts together, including
per-step recovery, by the run deadline.

Test a wrong detail followed by a correct one, exhaustion, `none`, low probability,
an uncertain check, stale candidates, changed filter counts, restore failure,
new-tab cleanup and nested pending checks. Assert zero retries for each forbidden
action, including a commit-looking candidate ranked below a safe link. Verify a
lost response never sends the action twice.

## Smaller additions

### Typed extraction (implemented)

```text
extract "price" as number currency SGD as $p
extract "check-in" as date as $arrival
extract { price: number currency SGD, cancellation: text } as $offer
```

First choose observed spans through the existing extraction choices in one
request. Parse selected text locally into a number, ISO date or fixed record.
Keep raw text, span ids, URL and normalization rules beside each value. Records
use one question per field; they are not free-form generated JSON. Require an
unambiguous value and p >= 0.75 for every required field. Stop on ranges, multiple
prices, ambiguous `03/04`, missing currency or unsupported units. Do not infer
a year or exchange rate. Test localized separators, negative numbers, ranges,
currency symbols, leap days, ambiguous dates and partly missing records.

### Return ranked top-k from `pick` (implemented)

```text
pick "lowest listed price with free cancellation" top 3 as $choices
```

This form returns item records without opening one. Keep ordinary `pick` opening
one item. The existing single Choice distribution and `runnersUp` rank confidence
in one best answer, not the next-best items. For the new form, bundle per-item
eligibility and extraction choices for an explicit sort key in one request, then
sort locally. Initially support criteria with an observable numeric/date key;
stop for vague quality rankings or missing keys. Preserve ties in page order and
report that order. Include evidence, key, eligibility probability and shortlist
coverage. Test ties, fewer than k matches, ads, missing prices and a distribution
whose runner-up is not the second-cheapest item.

### `answer` template (implemented)

```text
answer "The nightly price is ${p}; cancellation: ${policy}."
```

Render only bound values into a report field. This is not a message send or a
Jev-generated answer. It needs no question; drain the pending check first and
keep `lastCheck`. Missing bindings stop. Escape values as data and attach their
sources. A later final-check failure marks the answer provisional, not complete.
Test unresolved bindings, template escapes, hostile page text and a failed final
check. The agent still delivers the user's answer.

### Ground several same-page steps in one request (proposed)

```text
same page {
  fill "First name" = "Ada"
  fill "Last name" = "Lovelace"
}
```

Batching consecutive detail-page extraction choices in loop bodies is implemented. The action
block above remains proposed. Keep it explicit and last in priority. For actions,
initially allow only independent fills on a stable form.
Add `target.1`, `target.2` to one request, with the pending check and blocker.
Exact targets still need no model. Before each input, verify its pinned identity,
role, visibility and form context. A redraw, navigation, overlay, new validation
or dependency invalidates remaining groundings. Re-ground on the current page;
never replay completed fills. Do not batch commits, dynamic chips or checks that
depend on earlier inputs. Preserve normal settling and outcome checks. Test a
stable form, a redraw after the first fill, dependent fields and a new dialog.
This mainly saves tool time; it rarely removes an agent turn by itself.

## Report and implementation checks

Keep the existing step marks, `extracted:`, page changes, flags and final URL.
Add stable paths such as `2.item[1].3` and `4.attempt[2]`. Every extraction records
the source URL, item identity, raw line, probability and optional typed value.
Show a compact item table plus partial rows when stopped. Branch rows show which
side ran. Attempt rows show candidate, check, restoration and rejection reason.
`answer:` is separate from copied evidence. JSON exposes the same fields, not a
second interpretation of the text report.

Report planned and executed leaf counts, items completed/requested, candidate
attempts, stop path, current tab/URL, owned tabs left for inspection, Jev calls,
settle time and total time. A skipped branch is not a failed step; an exhausted
retry or an unresolved required value is. No green overall result while a required
check remains pending. Preserve partial evidence without presenting it as a
complete comparison.

Phase A and item loops use the plan parser and recursive block runner without an
opt-in flag. Candidate retries and same-page action batching remain proposals.
Extend `runSteps` recursively rather than flattening loops before the page exists. Traverse blocks for cooldown checks and ref validation. Keep `runOne`
responsible for leaf actions. Put question builders/readers in `judge.mjs`,
judgment dispatch in `judgments.mjs`, and bindings/frames in run context.
Give pending expectations an owning frame so a candidate failure cannot consume
an enclosing check or accidentally run the next leaf.

Use parser tables and deterministic Jev responses for the cases above. Browser
fixtures must exercise real navigation, rerenders, filters, overlays and delayed
checks. Assert request contents and input counts, not only formatted reports.
Run existing `do` tests unchanged to catch grammar and commit-guard regressions.

Then rerun the same 19 tasks with the same model, browser conditions and task
success checks. Compare paired task completion, agent turns, first-plan validity,
repair turns, wrong actions, Jev calls, settle time and wall time. Count shell
yield/collection turns too. Separate applicable tasks from the whole set. Ship
an addition only when it removes turns without reducing completion or increasing
unsafe actions. Do not claim 10x from tool timing alone.

## Not doing

- Arbitrary JavaScript, shell evaluation, recursive plans or unbounded loops.
- A general planner inside Jev, free-form extraction, or invented missing facts.
- Implicit pagination, hidden retries, automatic commits or automatic sending.
- Persisted variables, currency conversion or natural-language arithmetic.
- Removing settle/check barriers to make a long plan appear faster.

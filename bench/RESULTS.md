# Jev benchmark results, 2026-10-15

## Round 6: six new sites and task types, three arms

Sites never used before: Hacker News, Wikipedia, Stack Overflow, PyPI, YouTube, IMDb. Each
task finds a list and drills into a few items. Arms: A plain browserctrl (no `do`/Jev),
D `do` + `visit` on Sonnet, H the same method on Haiku. Runs 61-63; medians of passing runs.
Every agent read its prompt from a file and wrote its answer to a file (two tool calls in
every arm). Truth from public APIs (HN, Stack Exchange, PyPI) or by re-reading the pages.

| Task | A | D | H | D vs A |
| --- | --- | --- | --- | --- |
| Wikipedia: tallest 3, infobox facts | 100 s, 14 calls | 40 s, 8 calls | 72 s, 12 calls | −60% |
| PyPI: search, open 3 packages | 84 s, 15 calls | 47 s, 7 calls | 55 s, 11 calls | −44% |
| IMDb: top 3 of the chart | 98 s, 9 calls | 72 s, 8 calls | 98 s, 11 calls | −27% |
| YouTube: channel → Popular → 5 + 2 dates | 144 s, 12 calls | 152 s, 9 calls | 161 s, 14 calls | +6% |
| Hacker News: top 3 by points, comments | 38 s, 7 calls | 50 s, 9 calls | 56 s, 11 calls | +32% |
| Stack Overflow: top 3 voted, accepted answers | 63 s (1/3 passed) | 90 s (3/3) | 102 s (1/3) | slower, more accurate |

Passes: D 18/18, A 16/18, H 16/18. Failures were wrong facts: A named an accepted-answer
author where there is none (twice); H took an answer's editor for its author (twice).

**Reading:** `do` + `visit` wins where the plain route needs many reads (a table plus
articles, search plus package pages) and is never less accurate. It loses on pages reached
by a guessable address (HN items, SO tag pages), where the plain agent goes straight there
and `do` adds a model call and a wait. Haiku running the same method passes most tasks at
about the plain arm's speed, so the fast-executor idea holds for mechanical steps but not
for judging which name is which. No agent used `--open`; they went to a URL, then `visit`.

Run 63 used the new decision table in SKILL.md ("when to use nav, do, visit or --open"),
but the machine's load average was about 100 during it (A's HN time doubled), so its
before/after effect cannot be read from these times.

Checker fixes during the round (comment ranking drift, tied heights, relative dates,
`Requires-Python` wording, chart selectors) were applied to all arms and runs regraded with
the same answers. npm was replaced by PyPI after Cloudflare challenged npm's package pages.

## Round 5: harder drill-down tasks, `do` + `visit`

Six tasks that filter or sort and then open several items (runs 41-43). A: plain
browserctrl without `do` or Jev (it may use `visit`). D: `do` + `visit`, prompted to plan
with `do`. Medians of passing runs; tool calls are the agent's.

| Task | A | D | D passed | D vs A |
| --- | --- | --- | --- | --- |
| CNA: open the top 3 Singapore stories, bylines and dates | 159 s, 15 calls | 53 s, 4 calls | 3/3 | −67% |
| Stripe: open 3 failed payments, last 4 and decline reason | 148 s, 19 calls | 97 s, 7 calls | 3/3 | −34% |
| Lazada: search, sort, LG brand filter, 3 stores | 166 s, 17 calls (2/3) | 112 s, 9 calls | 2/3 | −33% |
| Carousell: price cap, sort, skip ads, 3 sellers | 158 s, 28 calls | 107 s, 7 calls | 3/3 | −32% |
| GitLab: 12 closed MRs, author and branches | 99 s, 7 calls | 160 s, 10 calls | 3/3 | +62% |
| GitLab: yjwong's top 5 merged MRs, commits | 59 s, 6 calls | 164 s, 16 calls | 3/3 | +178% |

34 of 36 runs passed. The two failures are run 43's Lazada runs: both arms on Lazada at once
drew a challenge, and the cool-down then blocked the store pages.

**Verdict:** `do` + `visit` wins the four tasks on marketplaces, Stripe and CNA (−32% to
−67%, with a third to a quarter of the tool calls) and loses both GitLab tasks. On GitLab
the A agents type the filter into the URL (`?state=closed`, `author_username=yjwong`) and
open MR pages directly; D agents, told to plan with `do`, drive GitLab's token filter box,
which costs retries. The skill already ranks "a URL that carries the filter" above `do`,
but the D prompt overrides it. In run 43, with the settle fixes below, D's `do` calls took
1.7-7 s each and its GitLab-author time fell to 86 s (A: 29 s).

**After the round:** with "if the site keeps filters in its URL, nav to that URL" added to the
skill and the D prompt, one confirmation run of each GitLab task (run 44, passing) took 50 s
(closed MRs; A median 99 s, −49%) and 31 s (author commits; A median 59 s, −47%). One run
each, so indicative only.

Fixes made during the round, from traces:

- Settle polled with in-page timers, which Chrome throttles in background tabs (steps waited
  7-19 s). It now polls from the CLI; a GitLab 7-step filter plan went from 15-40 s to 9 s.
- Typing waits for 700 ms of quiet so debounced suggestion lists load before the next step.
- `do` no longer waits 1.5 s for text stability on a page that is already loaded.
- `visit`: waits through empty app shells (Stripe), reads the body when `main` is a fragment
  (Lazada), limits tabs per site and stops on a challenge.
- Traces record time per phase (setup, read, Jev, input, settle, then).

Checkers read truth from MR pages, payment pages and articles (glab and gh had lost their
tokens). Several checker fixes were made mid-round (byline names, decline codes, a lost
filter click); affected runs were regraded with the same answers.

## Round 4: `do` v2 on more sites

Six tasks, three runs per approach (runs 31-33), plain browserctrl (A) re-run
alongside. Medians of passing runs; tool calls are the agent's.

| Task | A: agent drives | D: `do` plans | D passed | D vs A |
| --- | --- | --- | --- | --- |
| Stripe: filter to failed payments | 66 s, 9 calls | 20 s, 6 calls | 3/3 | −70% |
| GitHub merged PRs for a month | 59 s, 8 calls | 22 s, 5 calls | 3/3 | −63% |
| Lazada search, sort by price, pick 5 | 51 s, 13 calls | 22 s, 4 calls | 3/3 | −56% |
| CNA: open Singapore, first 5 headlines | 26 s, 5 calls | 18 s, 3 calls | 3/3 | −30% |
| GitLab closed MRs + one branch | 47 s, 6 calls | 46 s, 5 calls | 3/3 | −2% |
| GitLab merged MRs by one author (3 pages) | 80 s, 10 calls | 120 s, 19 calls | 3/3 | +50% |

All 36 runs passed. **Verdict under the pre-registered rule:** `do` wins four tasks,
including GitHub, a round-3 tie, and ties GitLab closed MRs. It loses GitLab-author:
in all three D runs `do` could not drive GitLab's author filter (a token search box), so
the agent read all 147 merged MRs over 8 pages. Two A runs put
`author_username=yjwong` in the URL and paged 3 pages instead.

Defects seen in passing D runs, to fix before the next round:

- `items` truncated long links (CNA, 2 runs) and dropped one listing's price (Lazada).
- `items` skipped CNA's lead story, which has no list link (1 run).
- On Stripe, `--then items` read the list before the Failed filter applied (1 run).
- `do` has no answer for a filter box it cannot drive; it should report the filter
  URL or the control's state so the agent can re-plan.

Conditions: up to four runs at once, plus three unrelated Codex sessions driving Dia
during runs 32-33. One A run lost time stealing back its own tab claim. The
lazada-cheapest checker was fixed mid-round to reload the sorted search when the run's
tab no longer shows results; A-31 was regraded with it (the answer matched D-31's).

## Round 3: the agent plans, `do` runs the plan with Jev finding elements

Same seven tasks, three runs per approach (runs 21-23), plain browserctrl (A) re-run
alongside. Medians of passing runs; tool calls are the agent's.

| Task | A: agent drives | D: `do` plans | D passed | D vs A |
| --- | --- | --- | --- | --- |
| Carousell chat: price and last messages | 41 s, 11 calls | 13 s, 3 calls | 3/3 | −68% |
| Shopee add a variation to the cart | 26 s, 6 calls | 17 s, 3 calls | 3/3 | −35% |
| Shopee search, sort, compare | 45 s, 8 calls (2/3) | 31 s, 5 calls | 3/3 | −31% |
| Carousell search with price filter | 74 s, 14 calls | 51 s, 8 calls | 3/3 | −31% |
| Shopee latest completed order | 50 s, 12 calls | 35 s, 8 calls | 3/3 | −30% |
| GitLab closed MRs + one branch | 34 s | 32 s | 3/3 | −6% |
| GitHub merged PRs for a month | 31 s | 39 s | 3/3 | +26% |

**Verdict under the same pre-registered rule:** `do` wins five tasks, every one with a
chain of clicks and fills, and ties the two that are mostly reading one list. The gain
is fewer agent turns, not faster clicks: Jev's 0.3 s choices let one call carry a plan
that took the agent a turn per step. Shopee raised its crawler captcha several times
during the round (blocked runs were discarded and re-run one at a time).

## Round 1: Jev drives the whole task

Seven tasks, three runs per approach, 42 runs. A Sonnet subagent drove each run in
the user's Dia; answers were checked against live truth (see [README](README.md)).
Times are medians of passing runs, in seconds.

| Task | A: agent drives | B: Jev first | B passed | B vs A |
| --- | --- | --- | --- | --- |
| GitHub merged PRs for a month | 45 | 46 | 3/3 | +2% |
| GitLab closed MRs + one branch | 28 | 43 | 3/3 | +54% |
| Carousell search with price filter | 61 | 67 | 3/3 | +10% |
| Carousell chat: price and last messages | 85 (2/3) | 106 | 3/3 | +25% |
| Shopee search, sort, compare | 109 | 113 | 2/3 | +4% |
| Shopee add a variation to the cart | 35 | 25 | 3/3 | −29% |
| Shopee latest completed order | 34 | 28 | 3/3 | −18% |

**Verdict under the pre-registered rule** (B at least 30% faster and no less
successful): Jev wins no task, so nothing was built.

## Why

- **Jev finished 0 of 21 runs.** In every run the agent completed the task. Jev
  usually made 1–7 predictions, then stopped.
- **It pauses at the first control outside its policy:** opening a chat, a sort
  menu, a filter, and Add To Cart even when that exact control was passed with
  `--allow-control`. Each pause hands control back to the agent, which then reads
  the page it would have read anyway.
- **It loops on dynamic pages.** On Shopee search it spent 30 predictions on
  `stale_page` retries without acting.
- **The agent's time is mostly reading and extracting**, which Jev does not do.
  Jev's 0.3 s decisions save little when the agent still needs several reads to
  find and verify the answer.
- **Where it helped:** clicking two variation buttons on the cart task (−29%) and
  opening the latest order (−18%) — short, well-labelled click sequences. Both fell
  short of the bar.

Neither approach was always correct: the agent misread chat senders once (A) and
Jev's run once took prices from a promotional banner (B).

## Conditions

Machine load average ranged from 9 to 242 across runs, with up to four runs at
once on different sites, which adds noise to every time. Taobao and a reply-draft
task were dropped before the runs to keep them hands-off and to avoid typing into
a real conversation.

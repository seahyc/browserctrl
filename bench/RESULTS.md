# Jev benchmark results, 2026-10-14

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

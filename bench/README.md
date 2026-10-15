# Jev benchmark

Measures whether Jev's fast action selection makes browserctrl faster on real
tasks, before any Jev integration is built. Recipes are excluded: a task here
must need the site's UI.

## Approaches

- **A, agent drives:** the invoking agent drives browserctrl itself.
- **B, Jev drives:** the agent hands Jev one bounded run (`jev-tool --tab ... --run`),
  then reads the page to extract and verify the answer, finishing the task itself
  if Jev pauses or fails.

Each run is a fresh Sonnet subagent with the prompt `run.mjs start` prints; the
approaches differ only in the Method paragraph. Every run starts from a tab the
harness opened and rendered. A task may instead start from a tab the user opened
(`HANDOFF:` start URL, `--tab ID`); Taobao would need this, since it logs out
pages that automation loads, but it was left out to keep runs hands-off.

Every run's start tab is recorded from `start` to `finish` into `runs/<run>/rec/`
(`browserctrl replay runs/<run>/rec` plays it; `--no-rec` skips it). A still costs
the acting command about a screenshot's time, the same in every arm.

## Decision rule (fixed before any results)

For each task, Jev wins if approach B's median time to a verified answer is at
least 30% lower than A's, and B passes at least as many of its 3 runs as A.
Only tasks Jev wins are candidates for building Jev into browserctrl (approach C:
the agent drives, browserctrl asks Jev to pick the target when a step is
ambiguous). If Jev wins none, nothing is built and the result is recorded in the
skill.

## Round 2: Jev inside browserctrl (approach C)

Round 1 (runs 1-3) found that handing Jev the task (B) is never faster. Round 2
(runs 11-13) tests Jev as a step inside browserctrl: the agent still drives, but
names elements with `--intent` instead of reading the page for refs, and confirms
page state with `check`. A is re-run in the same round, so both share the code and
machine conditions. The decision rule is unchanged: C wins a task if it is at least
30% faster to a verified answer than A and passes at least as many runs. Agent
tokens and tool calls are reported alongside.

## Round 3: plans with `do` (approach D)

Round 2 (runs 11-13) was stopped after one run per task: single-element intents saved
about 10% of tokens but not time, because the agent still took a turn per action.
Round 3 (runs 21-23) tests approach D: the agent sends the steps it can foresee in one
`browserctrl do` call, which finds each element (exact name, else Jev), waits for each
result and can return `items` in the same call. A is re-run in the same round. The
decision rule is unchanged: D wins a task if it is at least 30% faster to a verified
answer than A and passes at least as many runs.

## Round 4: do v2 and read v2 on more sites

Runs 31-33. Approach D now has expected results per step, popup dismissal, pagination
(`--repeat/--until/--collect items`) and the improved `read`/`items`. Tasks: the two
round-3 ties (github-prs, gitlab-mrs) and four new ones from the user's browsing
history: gitlab-author (a paginated list), lazada-cheapest (search, custom sort, pick),
cna-singapore (navigate a news site), stripe-failed (filter a dashboard). A is re-run in
the same round. Same decision rule. One pilot per task (run 0) runs with --show so the
user can watch; counted runs do not, since --show adds pauses.
Result: `do` won 4 of 6, tied 1, lost GitLab-author (see RESULTS.md).

## Running

```sh
node bench/run.mjs start <task> <A|B|C|D> <n> [--tab ID]   # prints the agent prompt
# run the prompt in a fresh subagent; save its final message to a file
node bench/run.mjs finish <task>-<arm>-<n> answer.txt --ms <agent ms> --tokens <agent tokens> --tools <tool uses>
node bench/run.mjs report [--from 11]
```

`finish` checks the answer against live truth (gh, glab, recipes, or a fresh read
of each reported page), undoes the cart task (removes the item), closes the run's tabs and appends a row to `results.jsonl`. Run 0
is a pilot and is left out of the report. `runs/` and `results.jsonl` hold
personal data and are not committed.

## Tasks

`tasks.json` holds goals and answer shapes; `fixtures.json` the fixed item and chat.
The one write task never checks out: it adds one fixed item to the cart, and
`finish` deletes it. Chat tasks only read, so nothing is ever sent to another
person.

## Flow-note arms

`start ... --notes reflect` and `--notes off` test whether agent-written flow notes help.
`reflect` shows hints, tells the agent to run `browserctrl site <site>` before planning, and
adds a reflection step to the prompt: after the task, the agent
adds up to 3 one-line facts about the site (never the answer) and any API endpoint it
spotted (`--api`), confirms notes it relied on
and drops wrong ones, and reports `notes_added`. `off` runs with `BROWSERCTRL_NOTES=quiet`
and no reflection. Each arm keeps its own store in `runs/notes-<arm>/`, so the user's notes
are untouched and the arms never share notes; the prompt tells the agent to prefix every
browserctrl command with the arm's settings. Protocol: run exploration tasks in the
`reflect` arm to write notes, then run different test tasks on the same sites in both
arms and compare pass rate, time and tool calls. Results rows carry `notes_arm` and
`notes_added`.

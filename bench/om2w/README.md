# Online-Mind2Web runs

Hard live-site tasks from [Online-Mind2Web](https://github.com/OSU-NLP-Group/Online-Mind2Web),
run with browserctrl by Codex agents and graded by a port of the benchmark's own WebJudge.

## Setup

- **Tasks:** the official task file is gated on Hugging Face (`osunlp/Online-Mind2Web`).
  Accept its terms, then download `Online_Mind2Web.json` to `bench/om2w/tasks.json`
  (gitignored). `suggested.txt` lists the task ids we run.
- **The bench browser:** Google Chrome as its own instance: profile
  `~/.local/share/browserctrl-bench/chrome-profile`, CDP port 9240, New York time, and
  browserctrl's extension (branded Chrome ignores `--load-extension`, so the launcher loads it
  over CDP). It never touches your own Chrome profile or port 9222.
  ```sh
  bench/om2w/launch-chrome.sh            # start it unless it answers
  bench/om2w/launch-chrome.sh --fresh    # stop it, wipe its profile, start again
  bench/om2w/launch-chrome.sh stop
  ```
  Set `OM2W_LAUNCH=bench/om2w/launch-chrome.sh` so a run relaunches it if it quit. Since
  2026-10-16 runs use a direct connection from Singapore, no VPN: tasks are drawn only from
  sites `access.json` lists as reachable that way. The Codex-native arm needs the ChatGPT
  extension, which this launcher does not load.
- **Agents and judge:** `codex exec -m gpt-6.1-sol -c model_reasoning_effort="low"` on the
  Codex subscription (`OM2W_MODEL`, `OM2W_EFFORT` override). The agent runs with
  `-s danger-full-access` so it can reach the browser's debugging port.

## Running

```sh
node bench/om2w/run.mjs run <task_id> --arm D [--notes reflect|off]   # start, agent, finish, judge
node bench/om2w/run.mjs batch jobs.txt [--parallel 2]                 # lines: <task_id> <arm> [reflect|off]
node bench/om2w/run.mjs judge <run>                                   # re-grade a run
node bench/om2w/run.mjs report                                        # success, time, tool calls, tokens per task and arm
browserctrl replay bench/om2w/runs/<run>/rec                          # watch a run
node bench/om2w/export.mjs <recording dir> <out dir> --task-id ID --task "..." [--answer "..."]   # judge input from one recording
```

Each run opens a fresh tab on the task's start site, records it (rrweb DOM events plus a
still per action, `runs/<run>/rec/`), runs the agent with the prompt in
`runs/<run>/prompt.txt`, exports the recording to the judge's layout
(`runs/<run>/om2w/<task_id>/`), and appends a row to `results.jsonl`. A task id prefix is
enough. The agent stops before any purchase, booking, payment, sign-in or message;
reaching that step counts, as in the benchmark.

**Same conditions for every arm:** the site's cookies and storage are cleared before each
run; the harness and the agent act as one browserctrl owner; the browser port and notes
settings are set once in the agent's shell, not in each command; every arm gets the same
judge stills (a quiet `text` read every 4 s from outside the agent); and each run keeps its
own captcha cool-downs, so a challenge one arm met does not keep the next arm off the site.

**Notes arms:** `--notes reflect` shows the arm's flow notes and asks the agent to write
notes afterwards; `--notes off` hides them. Each arm keeps its own store in
`runs/notes-<arm>/`, so the user's notes are untouched.

## The judge

`judge` follows `WebJudge_Online_Mind2Web_eval` (`src/methods/webjudge_online_mind2web.py`)
with its prompts verbatim:
1. Extract the task's key points.
2. Score each distinct still 1-5 for relevance to those key points.
3. Judge success from the action history plus the stills scoring 3 or more (at most 50).

Codex has no system role, so each call sends the system message and then the user text,
with images attached via `-i`. Two deviations: the agent's final answer is appended to the
action history as a last line, and the model is gpt-6.1-sol rather than o4-mini.
`runs/<run>/judge.json` keeps every score and response.

## Picking tasks

`make_picker.py` builds `picker.html` (gitignored: it embeds the gated task text), a page
listing all 300 tasks with level, human step count and published agents' pass rates, with
`suggested.txt` pre-ticked:

```sh
python3 bench/om2w/make_picker.py bench/om2w bench/om2w/suggested.txt && open bench/om2w/picker.html
```

## Splits: developing without overfitting

`split.py` (seed 20261016) splits the 300 tasks by site, so no site is in two sets, into
`splits.json`:

- **dev** (102 sites, 195 tasks): every site already used plus leftovers. Study runs and fix
  browserctrl against these freely.
- **rotation-1, -2, -3** (about 10 hard tasks each): held-out rounds. A rotation is run to
  measure whether fixes generalise; once its runs have been studied it is retired into dev and
  the next rotation becomes the held-out test.
- **final** (17 sites, 20 hard tasks): run once at the end. These are the only results reported
  as unseen sites.

Rules: fixes are developed and checked live only on dev sites or synthetic fixtures, never on a
held-out or final site; a held-out failure is studied as a kind of problem, and the fix is
verified elsewhere.

## Quick A/B

Compares two or more browserctrl commits on the 8 short dev tasks in `quick.json` (why each
was picked and its past timings are in the file):

```sh
node bench/om2w/ab.mjs run --arms main my-fix --quick         # preset: 6 fastest tasks x 2 repeats, about 40 min
node bench/om2w/ab.mjs run --arms main my-fix                 # all 8 tasks x 3 repeats, about 80 min
node bench/om2w/ab.mjs run --arms base=2ba3793 new=HEAD --tasks 99daaed9,512fd4de --repeats 3 --gate 30
node bench/om2w/ab.mjs run --arms main my-fix --quick --dry-run   # print the schedule, run nothing
node bench/om2w/ab.mjs run --group <id>                       # resume after a stop or crash
node bench/om2w/ab.mjs status --group <id>
node bench/om2w/ab.mjs judge --group <id>                     # optional: quick-judge every run afterwards
python3 -I bench/om2w/compare.py --group <id> [--base <arm>] [--gate 30] [--json out.json]
```

`--tasks` takes a set name (`quick`, `features`), a `.json` or `.txt` file of ids, or
comma-separated id prefixes for a subset. `--quick` picks the 6 tasks of `quick.json` with the shortest past
median (boardgamegeek, ycombinator, cbp.gov, github, versus.com, stubhub: about 410 s of
agent time per arm per repeat), so 2 arms x 6 tasks x 2 repeats is 24 runs of about 100 s,
about 40 minutes at low load. It is a first look: over 6 tasks only a 6/6 sweep passes a sign
test (p = 0.03; 5/6 gives 0.22), so read the CI, and confirm a promising result on the
full set.

- **Arm options:** `[label=]<ref>[:option,...]`. `dev:jev=off` runs commit dev as a user
  without a TypeSafe key: the arm's agent and daemon see no `TYPESAFE_API_KEY` and an empty
  `BROWSERCTRL_JEV_ENV` file, so exact names, refs and selectors work and nothing calls Jev.
  `env.NAME=value` sets any other variable for that arm. `--arms dev=dev nojev=dev:jev=off`
  names both.
- **Skill in the prompt:** each run's prompt carries the arm's own `SKILL.md` (front matter
  dropped, with the path of its `references/`), so the agent does not spend its first turn on
  `cat SKILL.md`. `--skill-path` restores the old prompt that only names the file. Groups made
  before this keep the old prompt when resumed.
- **Arms** are commits. Each gets a detached worktree at `.worktrees/bench-<sha>` (no
  branches), removed when the group finishes (`--keep-worktrees` keeps them). The harness
  and the agent prompt come from the checkout you run `ab.mjs` from, the same for every
  arm; each arm brings its own CLI, `SKILL.md` and `BROWSERCTRL_HOME`. `--arms dev dev` is an
  A/A check: two arms on one commit should show no difference.
- **Order:** repeat by repeat, task by task; within a task every arm runs back to back, and
  which arm goes first rotates with the task and the repeat. Arms run at different times are
  not comparable, so never merge groups.
- **Same start:** every run gets a freshly wiped Chrome profile, and the arm's daemon is
  stopped after it.
- **Load rule:** a run starts only when the 1-minute load average is under the gate (default 30;
  other work here often pushes it to 20-160, and runs started under heavy load were slower
  in ways that favoured whichever arm ran in a quiet spell).
  The start load is recorded; `compare.py` flags runs at or over the gate. Don't run test
  suites or other benchmarks while it runs.
- **Retries:** a run is retried once only when the harness failed (Codex exited with an
  error or the browser never came up); a wrong answer, a give-up or a 15-minute timeout is
  the agent's result and stands. Each attempt is a row.
- **Results** live outside the worktrees, in `~/.local/share/browserctrl-bench/results/`:
  `<group>.jsonl` (one row per attempt: arm, commit, task, repeat, start load, agent seconds,
  tool calls, tokens), `<group>.meta.json` (arms, tasks, settings), and `<group>/` (run
  folders, log; per-arm homes are in `../homes/`). Codex's own rollouts stay in `~/.codex/sessions`.
- **What `compare.py` measures:** per arm, medians over runs of turns (model responses,
  parallel tool calls counted once, +1 for the final answer), agent wall time, tool calls, do
  calls, steps per do plan and plan forms used; then per task the mean over repeats, arm minus
  base, with a sign test over tasks and a bootstrap 95% CI. With 8 tasks the sign test reaches
  p < 0.05 only when one arm wins all 8 (7/8 gives p = 0.07); read the CI. It flags runs over the gate,
  stalled commands, timeouts and retries.
- **Duration:** past agent time on this set is about 75 s per run. Setup and teardown
  (fresh Chrome, opening the start tab, stopping the recording) added 22-39 s per run in the
  A/A smoke check, which ran at load 110-200, so plan on about 100 s per run: 2 arms x 8 tasks
  x 3 repeats is about 80 minutes at low load. Dropping the slowest task (bhphotovideo) brings
  that to about 70. Waiting for the load gate adds to it.

## Feature tasks

`features/` holds 7 deterministic tasks on local sites, for what the om2w tasks do not
exercise: admin-console tables, paged logs, detail panes, dialogs, downloads and messy price
lists. `features/server.mjs` serves them on 127.0.0.1 (`OM2W_FIXTURE_PORT`, default 9250);
`run.mjs` starts it for each run and stops it after, so no live internet is involved. Each
answer is checked exactly by `features/check.mjs` (a number within a tolerance, or a name
and none of the known wrong ones), with no judge; the row's `success` is that check, and
`compare.py` pairs it like the other metrics and lists wrong answers.

```sh
node bench/om2w/ab.mjs run --arms main dev --tasks features --repeats 2
node bench/om2w/ab.mjs run --arms dev=dev nojev=dev:jev=off --tasks features --repeats 2
node bench/om2w/ab.mjs run --arms main dev --tasks feat-audit,feat-usage --repeats 1   # a subset
node bench/om2w/features/server.mjs --selftest   # expected answers recomputed from the data
```

| task | start | what it exercises | answer |
| --- | --- | --- | --- |
| `feat-audit-export` | console home | count rows over a 30-page SPA log table (Next button, URL unchanged): paged export, `table` | 15 |
| `feat-instance-pane` | instances | a 42-row table, a detail pane that loads late, its Network tab; distractor IPs (public, secondary, a `-canary` twin) | 10.31.112.64 |
| `feat-stays-cheapest` | stays grid | cheapest whole stay over cards in USD/EUR/GBP/SGD, per night vs total, ranges (upper end), a fee, a sold-out card | Alfama Nest |
| `feat-jobs-detail` | job list | first posting that sponsors visas and is fully remote; the list says "Remote" for country-limited roles too, only detail pages tell | JOB-4421 |
| `feat-billing-dialog` | billing | two selects and a button, with a notice dialog that opens 0.9 s after a select changes and covers the page | 9756.01 |
| `feat-settings-resume` | settings | the value sits behind a section that loads late and a collapsed panel that loads on open, so the obvious plan stops; a 30-day decoy on General | 400 |
| `feat-usage-csv` | reports | export a CSV (2 s delay), sum one service from the file; the page only shows rounded figures | 2822.50 |

The prompt for these tasks is shorter than the om2w one: the task, the browser, where
downloads go, no fetching the site directly, and "use browserctrl as its skill describes", so
each arm's own `SKILL.md` decides which commands the agent uses (main lacks the newer ones;
the tasks are all doable with older commands). `launch-chrome.sh` gives each fresh profile
a download folder of its own (`~/.local/share/browserctrl-bench/downloads`, `OM2W_DOWNLOADS`),
emptied before each feature run and copied into the run folder after, so runs never write
to `~/Downloads`.

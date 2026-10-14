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

## Running

```sh
node bench/run.mjs start <task> <A|B|C> <n> [--tab ID]   # prints the agent prompt
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

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
harness opened, except `taobao-sku`, which starts from a tab the user opened
because Taobao logs out pages that automation loads.

## Decision rule (fixed before any results)

For each task, Jev wins if approach B's median time to a verified answer is at
least 30% lower than A's, and B passes at least as many of its 3 runs as A.
Only tasks Jev wins are candidates for building Jev into browserctrl (approach C:
the agent drives, browserctrl asks Jev to pick the target when a step is
ambiguous). If Jev wins none, nothing is built and the result is recorded in the
skill.

## Running

```sh
node bench/run.mjs start <task> <A|B> <n> [--tab ID]   # prints the agent prompt
# run the prompt in a fresh subagent; save its final message to a file
node bench/run.mjs finish <task>-<arm>-<n> answer.txt --ms <agent ms> --tokens <agent tokens> --tools <tool uses>
node bench/run.mjs report
```

`finish` checks the answer against live truth (gh, glab, recipes, or a fresh read
of each reported page), undoes write tasks (removes the cart item, clears the
draft reply), closes the run's tabs and appends a row to `results.jsonl`. Run 0
is a pilot and is left out of the report. `runs/` and `results.jsonl` hold
personal data and are not committed.

## Tasks

`tasks.json` holds goals and answer shapes; `fixtures.json` the fixed item and chat.
The write tasks never check out or send: the cart task adds one fixed item, which
`finish` deletes; the reply task types into the box, and `finish` clears it and
checks that no message was sent.

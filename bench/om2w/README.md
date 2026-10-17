# Online-Mind2Web runs

Hard live-site tasks from [Online-Mind2Web](https://github.com/OSU-NLP-Group/Online-Mind2Web),
run with browserctrl by Codex agents and graded by a port of the benchmark's own WebJudge.

## Setup

- **Tasks:** the official task file is gated on Hugging Face (`osunlp/Online-Mind2Web`).
  Accept its terms, then download `Online_Mind2Web.json` to `bench/om2w/tasks.json`
  (gitignored). `suggested.txt` lists the task ids we run.
- **The bench browser:** a separate Chrome for Testing on CDP port 9230 with its own
  profile, New York time, and both extensions loaded (browserctrl, and a copy of the ChatGPT
  extension for the native arm; branded Chrome ignores `--load-extension`). Since
  2026-10-16 it uses a direct connection from Singapore, no VPN: tasks are drawn only from
  sites `access.json` lists as reachable that way (a Proton VPN exit was tried first, and
  Cloudflare blocked many sites through it).
  ```sh
  CFT="$HOME/.cache/chrome-for-testing/chrome/mac_arm-155.0.8059.84/chrome-mac-arm64/Google Chrome for Testing.app"
  open -n --env TZ=America/New_York -a "$CFT" --args --user-data-dir="$HOME/.local/share/browserctrl/bench-cft-us" \
    --remote-debugging-port=9230 --no-first-run --no-default-browser-check \
    --load-extension="$HOME/Code/browserctrl/extension,$HOME/.local/share/browserctrl/chatgpt-extension" about:blank
  ```
  Put that in a script and set `OM2W_LAUNCH` to it: each run checks the browser answers
  and relaunches it if it quit. Set `OM2W_PORT` for another browser.
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

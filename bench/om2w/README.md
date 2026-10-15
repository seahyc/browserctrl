# Online-Mind2Web runs

Hard live-site tasks from [Online-Mind2Web](https://github.com/OSU-NLP-Group/Online-Mind2Web),
run with browserctrl by Codex agents and graded by a port of the benchmark's own WebJudge.

## Setup

- **Tasks:** the official task file is gated on Hugging Face (`osunlp/Online-Mind2Web`).
  Accept its terms, then download `Online_Mind2Web.json` to `bench/om2w/tasks.json`
  (gitignored). `suggested.txt` lists the task ids we run.
- **A US browser:** the tasks assume a US visitor (zip codes, US-only stores, USD). Runs
  use a separate Chrome on CDP port 9230 whose traffic goes through a US WireGuard exit
  (Proton's free tier, via `wireproxy` as a local SOCKS proxy), so only the benchmark
  browser is routed:
  ```sh
  wireproxy -c ~/.config/wireproxy/proton-us.conf      # [Socks5] BindAddress = 127.0.0.1:25344
  open -n -a "Google Chrome" --args --user-data-dir=$HOME/.local/share/browserctrl/bench-chrome-us \
    --remote-debugging-port=9230 --proxy-server=socks5://127.0.0.1:25344 --load-extension=$HOME/Code/browserctrl/extension
  curl -s --socks5-hostname 127.0.0.1:25344 https://www.cloudflare.com/cdn-cgi/trace | grep loc=   # loc=US
  ```
  Set `OM2W_PORT` for another browser.
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

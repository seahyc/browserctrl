# Usage log

The CLI keeps a small local log of its own calls, so we can measure how many round trips a task takes, how often calls stop or fail, and how long each command takes. It is on by default and never leaves the machine.

## What is recorded

One JSON line per call, with short keys. Absent or empty fields are left out.

| key | meaning |
|---|---|
| `t`, `d` | start time (epoch seconds), duration (ms) |
| `c`, `x` | command name, exit code |
| `f` | flag NAMES only (sorted, at most 16), for example `["then","tab"]` |
| `k` | target kind: `name`, `ref`, `sel`, `xy`, `item`, `none` |
| `tab` | first 8 characters of the tab id |
| `s` | session: first 10 hex characters of a SHA-256 of the agent or session id (`BROWSERCTRL_AGENT_ID`, `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, `CODEX_SESSION_ID`) |
| `h` | harness: `cc`, `cx` or `oc` |
| `pp` | parent process id; consecutive lines with the same `pp` are one shell command chaining several calls |
| `o`, `e` | bytes written to stdout and stderr |
| `host` | hostname the call ended on (http and https only) |
| `br`, `v` | browser kind; browserctrl version (on the first line of each day's file only) |
| `n`, `nd`, `j` | for `do`: steps planned, steps done, Jev calls |
| `st`, `sp` | stop code (see below) and the stop step (at most 8 characters) |
| `ms_settle`, `ms_jev` | time spent settling and in Jev |
| `then`, `ch`, `un` | `--then` mode, number of change lines reported, unsure flag |

Stop codes: `jev_unsure`, `jev_none`, `covered`, `overlay`, `commit`, `timeout`, `no_key`, `expect`, `claim`, `other`.

## What is never recorded

Flag values, positional arguments, typed or filled values, URLs beyond the hostname, page text, element names, and the text of any stop or error reason (only its code is kept).

## Where

One file per UTC day, `usage-YYYYMMDD.jsonl`, in `BROWSERCTRL_USAGE_DIR` or the data folder's `usage/` directory (files `0600`, folder `0700`). Days older than yesterday are gzipped once a day. Files older than 180 days (`BROWSERCTRL_USAGE_DAYS`) are deleted, and the oldest go first if the folder passes 20 MB (`BROWSERCTRL_USAGE_MAX_MB`). A typical line is under 200 bytes. Nothing else in the folder is touched.

## Turn it off

`BROWSERCTRL_USAGE_LOG=0`. Logging never changes output or exit codes; a failure to write is ignored.

## Read it

`browserctrl usage` prints a summary: calls per command with p50/p90 latency and failure rate, chained calls, how often an action is followed by a read, `do` stop rates by code, and the busiest hosts. From code, use `readUsage({ days })` in `lib/usage-log.mjs` and `usageReport` in `lib/usage-report.mjs`. The files are plain JSON lines, so `zcat usage-*.jsonl.gz | jq` also works.

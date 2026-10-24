# Scripting browserctrl: exit codes, streams, JSON, stdin

The CLI works like other Unix tools, so a shell script or another program can test
its answers instead of parsing prose. Prefer one `do` call over a shell loop of single
commands: a 32-page export is one `do --repeat … --collect … --out` call, not 100 calls.

## Exit codes

Every command uses the same codes. They are stable.

| Code | Meaning | Examples |
|---|---|---|
| 0 | success, or found | `find` matched, `wait` saw the text, a `do` plan ran to its end |
| 1 | a negative answer | `find` or `text --match` matched nothing, `wait` / `ready` timed out, `check --expect` is false |
| 2 | usage error | unknown command, missing argument, invalid regex, plan syntax, `do -` with nothing on stdin |
| 3 | a `do` plan stopped before its end | uncertain step, unmet `=>`, blocking overlay, commit guard; `--intent` unsure |
| 4 | no browser or daemon to talk to | nothing debuggable on the port, the daemon did not come up |
| 5 | refused by a guard before acting | another agent's claim (`--steal`), paused agent, site cooling down, vault-tainted tab, `--intent` on a committing control |
| 6 | failed for another reason | navigation timeout, closed tab, page script error |

A `do` plan always exits 3 when it stops, whatever the reason; its report (or `trace`)
says why. Errors print one `Error: …` line on stderr.

Safari (`--browser safari`) uses the same codes: a shared command or flag Safari has no
equivalent for, a missing tab handle or bad `--args` JSON is 2; Safari's daemon or its
automation server not reachable is 4; another agent's claim, a paused agent or a tab private
after credential entry is 5; a tool Safari answers with an error (`isError`), a failed tab
switch or a timeout is 6.

## Streams

- stdout carries the data: the page text, the JSON, a `do` report.
- stderr carries everything else: `hint:` lines, warnings, settle notes, cool-down
  lines, progress, and the "nothing matches" message of a negative answer.
- `do … --out FILE|-` writes the collected pages to the file or stdout and moves the
  report to stderr.
- `-q` / `--quiet` drops the stderr chatter (errors still print). Commands that test
  a condition print nothing at all, as `grep -q`: `find`, `text --match`, `wait`,
  `ready`, `check --expect`. A `do -q` prints no report; when the plan stops it prints
  one `✗ stopped at step …` line, and the `retry:` line if there is one, on stderr.

Do not discard both streams (`>/dev/null 2>&1`): you lose the reason a plan stopped.
Use `-q` and the exit code instead.

## JSON

`--json` prints one JSON object (or array) on stdout: `read`, `text`, `find`, `fields`,
`items`, `table`, `tabs`, `claims`, `browsers`, `marks`, `console`, `network`, `html`, `shot`,
`trace`, `site`, `notes`, `profiles`, `activity`, `cooldown`, `recipe list`, and `do`
(the full report). `check`, `wait`, `ready`, `open`, `nav`, `click`… print JSON already.

`--jsonl` prints one JSON object per line, for `jq -c`, `while read` and streaming:
`tabs`, `find` (one match per line), `items` (one item per line, with its group), `table` (one row per line),
`fields`, `console`, `network`, `claims`, `browsers`. An empty list prints nothing.

`tabs --ids` prints one tab id per line:

```bash
browserctrl tabs --ids | xargs -I{} browserctrl text {} --match 'Order #[0-9]+'
```

## grep-like reads

```bash
browserctrl find <tab> "Go to next page" -q && echo "there is a next page"
browserctrl find <tab> "Go to next page" --enabled -q   # a disabled Next does not count
browserctrl find <tab> "Delete" --count                 # how many controls match
browserctrl text <tab> --match 'error|failed' -q || echo "no error on the page"
browserctrl text <tab> --match 'SELECT' --count         # matching lines
browserctrl wait <tab> --text "Saved" --timeout 5000 -q || echo "not saved"
```

## Reading parts of a page

```bash
browserctrl text <tab> --region main                 # a landmark: main, nav, header, footer, aside, dialog, search, form
browserctrl text <tab> --region "Policy Document"    # a heading and what follows it, up to the next heading of its level
browserctrl text <tab> --from "Policy Document" --to "Grants"   # line range, case-insensitive substrings
browserctrl text <tab> --tail 30                     # the last lines, instead of eval 'document.body.innerText.slice(-N)'
browserctrl table <tab>                              # TSV with a header line
browserctrl table <tab> --csv > users.csv
browserctrl table <tab> --jsonl | jq -r 'select(.Role == "Admin") | .User'
```

The ranges apply in the order `--region`, `--from/--to`, `--match`, `--tail`; one that finds
nothing exits 1 and lists the landmarks and headings there are. `table` finds the largest
shown table or ARIA grid (a header row kept in its own table is matched by column count), else
rows drawn with divs (three or more siblings of one class with the same number of cells);
`--selector css` picks one; it exits 1 when there is none. `do --collect rows` uses the same code.

## Acting by name, ids, downloads, panes

```bash
browserctrl click <tab> "Save"                       # exact name, else Jev; exit 3 if unsure, 5 if it commits (--commit)
browserctrl fill <tab> "Search" "aeron" && browserctrl key <tab> Enter
t=$(browserctrl open https://example.com --id)       # just the id
browserctrl click "$t" "Export" && f=$(browserctrl wait --download) && wc -l "$f"
browserctrl scroll <tab> --in "Log output" end       # a scrollable pane or editor, by name or CSS
```

```bash
browserctrl upload <tab> "Resume" ~/cv.pdf           # a file input's label, aria-label or title
browserctrl upload <tab> "Add photos" a.jpg b.jpg    # a button beside a hidden input: the files go to the input
browserctrl upload <tab> "Browse files" cv.pdf       # a button that makes its own picker: the picker is intercepted
browserctrl upload <tab> --ref ref_2 --files a.pdf,b.png   # refs and CSS selectors still work
```

`upload` finds the control by its exact name, else Jev picks among the page's upload controls
(file inputs, their labels and buttons, and buttons that say upload, attach, browse or choose
file); unsure, it exits 3 and lists them. A file that does not exist, or a folder, exits 2
before anything on the page is touched; relative paths and `~` are resolved here, not by the
browser. A picker button whose name commits ("Upload and submit") needs `--commit` (else 5).

`screenshot`, `navigate` and `list` are aliases of `shot`, `nav` and `tabs`. Every shell call
starts fresh, so name the browser on the same line: `BROWSERCTRL_BROWSER=dia browserctrl …`.

## A current tab

```bash
export BROWSERCTRL_AGENT_ID=report-bot BROWSERCTRL_BROWSER=dia   # or put both on every line
browserctrl open https://example.com/orders     # the new tab becomes this agent's current tab
browserctrl text --match 'Order #'              # the tab left out: the current tab
browserctrl click "Export"
browserctrl do . 'fill "Search" = "aeron"' 'key Enter'   # "." names it explicitly
browserctrl use 1A2B3C4D                        # switch; use alone prints it, use --clear forgets it
```

The current tab is kept per `BROWSERCTRL_AGENT_ID` and per browser, beside the claims file, as
tab ids only. Without an agent id it belongs to the calling shell's pid, so a harness that
starts a fresh shell for every command loses it: set the id. `open` sets it; `close` of it
forgets it; `tabs` tags it `current`. It grants nothing: a tab another agent claimed still
refuses (5), and a current tab that was closed fails with exit 6 naming it.

Leaving the tab out is unambiguous: with a current tab, the first word is the tab only if it
is `.`, a tab id (6 to 32 hex characters with a digit, as `tabs` prints), `active`,
`focused`, `marked` or one of your tab aliases, or if the command has more words than it
takes (`nav <tab> <url>`, `click <tab> "Save"`, `fill <tab> ref_5 "x"`). A URL, a visible
name or a plan step is never read as a tab. A name that looks like a tab id needs `.` in front:
`browserctrl find . "a1b2c3"`. Without a current tab nothing changes.

## One plan on several tabs

```bash
browserctrl do --each-tab 1A2B3C4D,5E6F7A8B 'click "Export"'
browserctrl do --each-tab all-mine 'extract "the order total"' --parallel 3 --json | jq '.[] | {tab, done}'
```

`--each-tab` takes tab ids (or `.`), or `all-mine` for the open tabs this agent has claimed.
Every tab is resolved first, so a mistyped one runs nothing (exit 6). The plan runs on one tab
at a time, or on `--parallel N` at once (at most 4). Each tab's claim is checked as a single
`do` checks it: another agent's tab is refused and the others still run. It prints each tab's
report in the order given, then a summary line per tab; `--json` prints an array of reports
with `tab`, `exit` and `done` added, and `-q` prints only the stopped tabs on stderr. It exits
3 if any plan stopped, else 5 if a tab was refused, else the first failure's code.
`--resume` and `--out` work on one tab at a time only.

## Plans from stdin

`do <tab> -` reads the steps from stdin, one per line; `--file plan.txt` reads a file
(`--file -` is stdin too). Blank lines and lines starting with `#` are skipped. Steps
given as arguments run after the file's.

```bash
generate-steps | browserctrl do <tab> - --then text
printf '%s\n' 'click "Slow Query Log Details"' 'key Escape' | browserctrl do <tab> -
```

## Pagination and bulk export

```bash
browserctrl do <tab> 'click "Slow Query Log Details"' \
  --repeat 'click "Go to next page"' --collect rows --out /tmp/slow-log.jsonl
```

- The loop ends cleanly at the last page: no Next, a disabled Next, or a page that did
  not change after the click. `--until "<page condition>"` (judged by Jev) can end it
  earlier; `--max N` caps the repeats (10 by default, 1000 with `--out`, at most 5000).
- `--collect rows`: the rows of the page's main table or ARIA grid, keyed by its column
  headers (a header row in its own table, as in fixed-header grids, is matched by
  column count). `--collect items`: the repeated items `items` finds. `--collect text`:
  the page's full text.
- `--out FILE` or `--out -` writes one JSON line per page, as soon as it is read:

  ```json
  {"page":1,"url":"https://…","columns":["Time","Duration (ms)","Query"],"rows":[{"Time":"…","Duration (ms)":"812","Query":"SELECT …"}],"duplicates":0}
  {"page":1,"url":"https://…","region":"main","heading":"Results","items":[{"text":"…","link":"…","page":1}],"duplicates":0}
  {"page":1,"url":"https://…","chars":48211,"text":"…"}
  ```

  There is no total cap. One page is capped at `--page-cap N` (1,000,000 characters,
  5,000 items or 5,000 rows by default); a capped page carries `"truncated":true`.
- Items and rows already seen on an earlier page are dropped and counted in
  `duplicates`; `--no-dedupe` keeps them (logs with identical lines).
- Without `--out` the pages go into the report, bounded (text 6,000 characters a page
  and 20,000 in all, items 200 a page, 500 rows shown).
- A stop caused by a dialog or popup prints a `retry:` line: the same command with
  `--dismiss "<that overlay>"` added. Run it when closing that overlay is harmless.

```bash
jq -c '.rows[]' /tmp/slow-log.jsonl                   # every row, one per line
jq -s '[.[].rows | length] | add' /tmp/slow-log.jsonl  # how many rows
```

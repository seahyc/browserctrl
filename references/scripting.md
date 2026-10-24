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

`screenshot`, `navigate` and `list` are aliases of `shot`, `nav` and `tabs`. Every shell call
starts fresh, so name the browser on the same line: `BROWSERCTRL_BROWSER=dia browserctrl …`.

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

# Live extraction evaluation

Run from the repository root with the existing dependencies and Chrome installed:

```sh
env -u BROWSERCTRL_AGENT_ID \
  BROWSERCTRL_JEV_ENV="$HOME/Code/jev-ultrafast/.env" \
  EXTRACT_EVAL_RESULTS=/tmp/codex-bc/extract-eval-results.json \
  /opt/homebrew/bin/node bench/extract-eval/run.mjs
```

By default, the runner launches headless Chrome with a temporary profile and a free loopback port. It sets a private `BROWSERCTRL_HOME` before importing browserctrl. Headless mode never connects to Dia or an existing browser. The maintained test Chrome launcher handles the private process group. Normal completion, errors, SIGINT and SIGTERM stop the private daemon and browser and remove the temporary home. SIGKILL cannot run cleanup handlers.

The 37 cases cover four GitHub repositories, repository statistics, language, license, release tags, Wikipedia population, capital and founding dates, Python downloads, npm package metadata, public pricing, and absent answers. Ten added cases cover German, French, Japanese and Chinese pages, Chinese and Spanish questions, English paraphrases, and a PyPI license. Infobox facts use independently labelled table-row selectors; the PyPI oracle reads the visible license badge. Each step is a single real `runSteps` extraction. No fake model or cached extraction result is used. Authentication comes from the real Jev env file; the key is never logged.

Changing GitHub counts and release/version labels use a separate DOM selector oracle, read before extraction. The oracle waits up to six seconds for lazy content. The expectation is fixed for that case before Jev runs. Numeric values must equal the independently read displayed count, including the displayed precision of `k` abbreviations. Language answers may contain the language and its percentage, but a bare percentage cannot pass. Text and regex expectations are deliberately anchored. A selected fact can include its label only where the case explicitly allows it. Python version answers may include the download label, and release tags may include the adjacent Latest label.

A **correct binding** matches the case expectation. A **false binding** supplies a non-null answer that fails the expectation, or supplies any answer for an absent fact. A **wrong stop** supplies no answer when the oracle expects one. An **honest stop** supplies no answer for an absent fact. Untyped extraction returning `null` counts as a stop even when the report has no `stopped` field. **Unavailable** means setup, navigation, the independent oracle, or execution failed; those rows are retained and never counted as correct or as honest stops. Navigation errors retry at most once. Missing selectors and blocked pages are coverage failures, not extraction failures.

Extraction reports retain the number of offered and total candidate lines. The table reports total wall latency per case, actual Jev HTTP requests, and API-reported input/output tokens. Missing token fields are marked incomplete. `EXTRACT_EVAL_RESULTS` saves full reports and oracle evidence as JSON. Exit status is 1 for any false binding, otherwise 2 for unavailable cases, otherwise 0. Wrong stops remain visible without changing the exit status. Calls depend on extraction retries and verification, so a run may exceed the intended 25–60 request budget; inspect the actual total before repeating.

Public pages change and headless access may be blocked, particularly npm. Review unavailable cases and saved oracle evidence before comparing two runs. These cases measure current rendered page facts, not historical counts or API-only data. The Node release oracle reads the tag from its release link href because the displayed title includes a date and prose. The Playwright release oracle reads its displayed tag. Both use the first release tag link shown on the repository page; it does not infer the highest semantic version from README examples. Set `EXTRACT_EVAL_INSPECT=1` for a page diagnostics pass without Jev calls. `EXTRACT_EVAL_FILTER` accepts a case ID regular expression for focused diagnosis; use the unfiltered run for comparisons.

## Dia mode

`EXTRACT_EVAL_BROWSER=dia` or `--browser dia` selects the installed `browserctrl` on PATH, which must support `do --json`. This measures the installed checkout, not this worktree. For an authorized Dia evaluation:

```sh
EXTRACT_EVAL_BROWSER=dia EXTRACT_EVAL_RESULTS=/tmp/codex-bc/extract-eval-dia.json \
  /opt/homebrew/bin/node bench/extract-eval/run.mjs
```

The adapter sets `BROWSERCTRL_BROWSER=dia` and `BROWSERCTRL_AGENT_ID=extract-eval` on child processes. It opens one background tab per case, waits for load with `ready`, reads the same oracle through `eval`, and runs the extraction with `do --json`. It closes only IDs returned by its own `open` commands, including on errors, SIGINT, and SIGTERM. It never stops or restarts the daemon or navigates existing tabs. SIGKILL cannot run cleanup. A failed close is reported by final cleanup.

Cases with `"dia": false` are skipped and excluded from totals. Mark any case requiring login or involving risky pages this way before running it. The current cases are public read-only pages and require no login. Dia uses the same scoring and table, with the selected browser printed above the header. Jev call counts come from the installed CLI report; token usage is unavailable through that report and is marked incomplete. Inspection in Dia uses only the installed CLI's page reads; headless inspection also includes extraction candidates and shortlisted spans. Dia mode was implemented with mocked child-process tests only; do not run it without authorization.

## Held-out evaluation

Use `--set dev` (the default), `--set heldout`, or `--set all` to select the original 37 cases, the 24 independently specified held-out cases, or both. The held-out set uses different URLs for repository counts, dates in English, French and German, free-plan prices, release tags, package licenses, and three absent facts. Counts and release tags use DOM oracles; dates and zero-price plans have independent fixed expectations.

Freeze the held-out cases and save one baseline table and JSON before changing extraction code. Diagnose changes using dev cases only. After fixing, run dev at most four times and held-out at most twice. Require zero false bindings on every reported run, dev improvement, and held-out correct bindings no lower than baseline minus one. Keep unavailable cases visible.

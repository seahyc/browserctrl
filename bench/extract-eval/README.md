# Live extraction evaluation

Run from the repository root with the existing dependencies and Chrome installed:

```sh
env -u BROWSERCTRL_AGENT_ID \
  BROWSERCTRL_JEV_ENV="$HOME/Code/jev-ultrafast/.env" \
  EXTRACT_EVAL_RESULTS=/tmp/codex-bc/extract-eval-results.json \
  /opt/homebrew/bin/node bench/extract-eval/run.mjs
```

The runner launches headless Chrome with a temporary profile and a free loopback port. It sets a private `BROWSERCTRL_HOME` before importing browserctrl. It never connects to Dia or an existing browser. The maintained test Chrome launcher handles the private process group. Normal completion, errors, SIGINT and SIGTERM stop the private daemon and browser and remove the temporary home. SIGKILL cannot run cleanup handlers.

The 27 cases cover four GitHub repositories, repository statistics, language, license, release tags, Wikipedia population, capital and founding dates, Python downloads, npm package metadata, public pricing, and an absent answer. Each step is a single real `runSteps` extraction. No fake model or cached extraction result is used. Authentication comes from the real Jev env file; the key is never logged.

Changing GitHub counts and release/version labels use a separate DOM selector oracle, read before extraction. The oracle waits up to six seconds for lazy content. The expectation is fixed for that case before Jev runs. Numeric values must equal the independently read displayed count, including the displayed precision of `k` abbreviations. Language answers may contain the language and its percentage, but a bare percentage cannot pass. Text and regex expectations are deliberately anchored. A selected fact can include its label only where the case explicitly allows it. Python version answers may include the download label, and release tags may include the adjacent Latest label.

A **correct binding** matches the case expectation. A **false binding** supplies a non-null answer that fails the expectation, or supplies any answer for an absent fact. A **wrong stop** supplies no answer when the oracle expects one. An **honest stop** supplies no answer for an absent fact. Untyped extraction returning `null` counts as a stop even when the report has no `stopped` field. **Unavailable** means setup, navigation, the independent oracle, or execution failed; those rows are retained and never counted as correct or as honest stops. Navigation errors retry at most once. Missing selectors and blocked pages are coverage failures, not extraction failures.

The table reports total wall latency per case, actual Jev HTTP requests, and API-reported input/output tokens. Missing token fields are marked incomplete. `EXTRACT_EVAL_RESULTS` saves full reports and oracle evidence as JSON. Exit status is 1 for any false binding, otherwise 2 for unavailable cases, otherwise 0. Wrong stops remain visible without changing the exit status. Calls depend on extraction retries and verification, so a run may exceed the intended 25–60 request budget; inspect the actual total before repeating.

Public pages change and headless access may be blocked, particularly npm. Review unavailable cases and saved oracle evidence before comparing two runs. These cases measure current rendered page facts, not historical counts or API-only data. The Node release oracle reads the tag from its release link href because the displayed title includes a date and prose. The Playwright release oracle reads its displayed tag. Both use the first release tag link shown on the repository page; it does not infer the highest semantic version from README examples. Set `EXTRACT_EVAL_INSPECT=1` for a page diagnostics pass without Jev calls. `EXTRACT_EVAL_FILTER` accepts a case ID regular expression for focused diagnosis; use the unfiltered run for comparisons.

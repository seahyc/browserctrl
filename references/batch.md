# Guarded batch contract

The batch harness adds a bounded, zero-model-call execution path to browserctrl.
It does not replace its existing CLI, MCP tools or transport. The parent agent owns
permission, text generation, branch selection and business-outcome verification.

## Start one persistent process

```sh
node ~/.agents/skills/browserctrl/bin/batch.mjs \
  --browser dia --tab EXACT_TAB_ID --origin https://example.com
```

Use `--port PORT` instead of `--browser` for an explicit local/forwarded endpoint.
Use `--url https://example.com/path` instead of `--tab` to open an owned background
tab. Owned tabs close when the process ends unless `--keep-open` is set; existing
tabs remain open. The harness never launches or restarts the browser.

The first JSON line includes `event: ready`, the tab ID and an observation. Send
newline-delimited JSON on the same process stdin. Defaults: 12 actions and 15 seconds
per batch; configure `--max-steps` and `--max-ms` when starting the process.

## Observe and prepare

`{"command":"observe"}` returns a fresh observation with a token and element rows.
Use only refs returned by that observation. Values can come from supplied facts or
be written together by the current agent; no nested LLM request is required.

Example shape (refs and token below are illustrative, never reusable):

```json
{
  "command": "run",
  "token": "EXACT_OBSERVATION_TOKEN",
  "steps": [
    {"kind": "fill", "ref": "ref_1", "value": "London"},
    {"kind": "fill", "ref": "ref_2", "value": "Two adults"},
    {"kind": "select", "ref": "ref_3", "value": "economy"},
    {"kind": "click", "ref": "ref_4", "after": {"textIncludes": "Matching results"}}
  ]
}
```

Supported operations:

| Kind | Required inputs | Verification |
| --- | --- | --- |
| `fill` | observed `ref`, string `value` | resulting field value |
| `select` | observed native-select `ref`, `value` or `label` | selected option value |
| `click` | observed `ref`, `after` | bounded condition polling |

Click postconditions use `{"textIncludes":"specific new outcome"}` or
`{"urlEquals":"https://example.com/exact-result"}`. Choose a condition that cannot
be satisfied by a preexisting navigation label. Clicks end the batch; observe the
resulting screen before preparing its next batch. This permits form-fill + advance
without blind multi-screen action plans. Custom dropdowns need observed option
selection through ordinary browserctrl or a separately bounded step.

No caller JavaScript, arbitrary selectors, uploads, credential fields, or final
send/submit/payment/delete actions are accepted in this path. It is not a sandbox
for hostile callers: the local parent agent already has trusted browser tooling.
Its purpose is to constrain plans and catch stale-state/mis-targeting mistakes.

## Stop and recover

The token is single-use, including failed plans. Request a new observation before
planning again. `completed` means the declared batch postconditions passed; it does
not prove the entire user task is complete. `needs_review` means a policy/state/
postcondition check stopped the batch. `failed` reports execution failure; inspect
`uncertain` and the completed-step ledger before deciding what happened.

Never automatically resubmit the batch after a failure. A mutation may already have
occurred even if its response was lost. Diagnose once using a fresh observation and
ordinary browserctrl network/console/DOM tools. Preserve state for human auth/approval
checkpoints rather than reopening or replaying the flow.

Telemetry records step status and timing without prepared values. Zero model/API
cost fields refer only to the executor: the parent Codex usage and any paid website
operation are outside that accounting. Reports must distinguish local loop latency
from end-to-end user-task latency and all recovery work.

`{"command":"close"}` releases the session. Other browserctrl tooling should not
write to its tab concurrently. The shared tab claim is advisory, not browser-level
exclusive locking.

## Local verification

Offline contracts are part of `node --test test/batch.test.mjs`.
The explicitly opted-in live benchmark is `node test/batch-live.mjs --browser dia`;
it uses temporary local fixture tabs and no model APIs. Consult the browser-workflow
[design](../../browser-workflow/references/design.md) for measurements and limitations.

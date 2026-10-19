# Multi-step flows design

Status: implemented first version with bounded coverage; benchmark results below.
This is a local workflow harness over browserctrl, not a new general-purpose model.

## What the recent tasks indicate

A review of recent agent browser sessions (product QA, registration, research,
admin-console diagnosis and visual QA) showed these recurring patterns:

| Pattern | Useful fast path | Accuracy check | Escalation boundary |
| --- | --- | --- | --- |
| Product QA / multi-step drafts | Prepare values for one observed form; batch independent writes and one advancing click | Exact values, selection state, validation, then real result / request outcome | Missing flag/data/backend, ambiguous widget, changed screen |
| Registration | Copy supplied facts; prepare related text in one parent turn | Selected option plus rendered fields; final confirmation separately | Missing personal data, auth/CAPTCHA, final submission |
| Research / extraction | API/connector when suitable; compact page/table extraction; independent reads across owned tabs | Source content, timestamps, product identity | Unclear relevance, stale content, account wall |
| Admin-console diagnosis | Background tab pinned by ID; read state and request failures | Actual permission/resource state, not a blank or loading panel | Access changes, credential flows, uncertain mutation |
| Visual/product QA | DOM checks first, targeted screenshot when visual properties matter | User-visible behavior plus backend/persistence evidence as needed | Canvas, device/OS UI, unsupported frames/widgets |

In one product-QA trace, nine visible Jev responses across an eight-minute
segment took 6.2 seconds altogether, while parent predict/act handoffs were often
14–17 seconds apart. Those model responses had 32,263 input and 2,263 output tokens.
This motivates fewer parent turns, not simply a faster decision model.

One administrative access trace repeatedly lost the intended
foreground tab; switching to background CDP helped, but stalled request panels still
needed diagnosis. Another, a device-management trace, showed that “command sent”
was not proof of the requested device outcome. These observations motivate explicit
tab ownership and outcome-specific verification. Credentials and personal details
from the traces are deliberately not reproduced here.

## Architecture

```text
User goal + current agent turn
  ├─ exact supported API/connector operation → direct route
  └─ observed browser state
       ├─ known targets + independent values → guarded local batch
       ├─ ambiguous semantic choice → optional bounded Jev decision
       └─ unsupported/uncertain state → focused agent diagnosis

Guarded local batch → persistent browserctrl → explicit tab in Dia/Chromium
  preflight → fresh identity/state check → one action → postcondition
  repeat within budget; stop on first discrepancy; never replay an uncertain action
```

The reasoning model's unit of work is a page/decision boundary, not a single click.
Prepare multiple text fields directly in the current agent turn; there is no nested
agent process for each field. Batch values only when the current goal and observed
context justify them. Dependent future fields wait for a new observation.

The batch is data, not generated JavaScript: observed refs, action kinds, values and
bounded assertions. It cannot emit arbitrary selectors, evaluate code, make requests,
read cookies or provision browsers. Existing browserctrl remains the escape hatch for
operations needing richer trusted code or visual inspection.

## Why this generalizes beyond the studied site

The executor does not recognize a website or prescribe a sequence. It works on the
observed controls of a form and checks identity and state before every operation.
The agent authorizes a concrete, short batch within the user's task, rather than adding
site-specific button-name permissions to an autonomous model loop. New screens,
new values, mismatches and unexpected effects return to the parent.

This trades some open-ended autonomy for less guesswork and lower incremental
cost. A universal label allowlist cannot establish semantic permission. The parent
must still understand account, environment, side effects and the user's scope.
The built-in consequential-label stop is an additional conservative boundary,
not a comprehensive classifier of website behavior.

## Runtime contracts

- Explicit browser/port, tab and exact HTTP(S) origin; preserve the user's profile.
- A persistent process/daemon connection; no start/stop per interaction.
- Fresh observed refs only, bounded independent form writes, one advancing click
  at a batch boundary, no guessed future controls.
- Checks for replaced/changed/disabled/hidden targets and altered field values.
- Fields verify their resulting value; clicks require an explicit outcome predicate.
- Stops retain a completed-step ledger. A transport error during mutation is
  uncertain, not evidence of failure or permission to retry.
- Budgets bound work; no unbounded retries, sleeps or automatic backend repair.
- Compact telemetry excludes prepared field values and raw network payloads.
- Auth/CAPTCHA, credential resets, final sends and high-impact operations use their
  existing user-controlled or explicitly approved workflows.

## Cost and latency accounting

“Zero” means **zero incremental external model/API charges in the batch executor**.
The current agent turn still consumes account usage, and websites may have their
own paid operations. Jev and any separately configured text model remain optional
billable paths. Do not call subscription usage or compute literally free.

Track complete-task wall time, tool/model time, number of parent boundaries, model
calls/tokens, failed assertions, uncertain outcomes and recovery effort. Compare
only independently verified successful outcomes; include abandoned/failed runs in
cost-per-success. Do not discard failures to improve the reported latency.

A short batch cannot guarantee subsecond completion on slow sites. Network/auth
latency and dynamic controls can dominate. Warm local benchmark latency is a
mechanics measurement, not an end-to-end website SLA.

## Coverage and rollout

Use the harness first on local fixtures and low-impact observed forms, retaining
ordinary browserctrl and Jev workflows. It does not replace existing CLI commands.
The multi-step-flows reference routes work; the executor lives in browserctrl
so transport and tab claims stay shared.

No replay of live production/admin workflows is part of this benchmark. The studied
tasks provide requirements; synthetic fixtures verify the executor mechanics.
Future production trials should record verified outcomes and recovery totals for
real authorized tasks, without recording credentials or private form contents.

## Measured first-version results

Final recorded run: ten fresh local-form iterations in the real signed-in Dia
browser, each with three text writes, one native select and one checked click.
The result and all four values were independently read from the DOM, and exactly
one click was required. Every owned fixture tab was closed.

| Measurement | Observed result |
| --- | --- |
| Successful batch execution | median 199 ms; p95 385 ms (10 samples) |
| Reset/navigation plus observation | median 78 ms; p95 192 ms |
| Initial connection / owned tab / first observation | 524 / 1,668 / 9 ms |
| All 10 successes plus 7 negative scenarios | 6,147 ms, excluding initial setup and final cleanup |
| Successful-run model calls / extra model API cost | 0 / $0 |
| Full browserctrl suite | 85 passed |
| Persistent CLI smoke test | Passed; separate DOM read and consumed-token rejection checked |

Negative scenarios: externally changed field, replaced node, disabled fieldset,
overlay, disallowed Send control, unmet postcondition, and synthetic transport
ambiguity. The first five stopped without subsequent mutation; the unmet
postcondition case clicked exactly once and stopped after its condition timeout;
the injected transport error returned uncertain without replay. This is seven
expected-stop checks, not a measured real-world failure rate. The transport failure
was injected; it is not a claim of testing every actual network failure.

The recorded JSON is not published. Previous iterations ranged from 159–169 ms
median and 256–317 ms p95; use the final result rather than the fastest sample. The
final run overlapped the isolated full test suite and a separate owned-tab CLI test.
Its setup included a normal daemon code refresh, not a browser restart. No production
workflow was replayed or modified.

The first test exposed cleanup hangs from an open input stream and HTTP keep-alive;
cleanup was fixed and both CLI and benchmark were rerun to successful process exit.
All measurements are local loop mechanics with prepared fixture values. Parent
reasoning/text preparation, a real site's network latency, cross-screen handoffs,
auth and human approvals are not included in the per-batch percentiles.

Remaining coverage limits: closed shadow roots, cross-origin frames, canvas,
rich-text editors, virtualized/replaced controls and unobserved future screens use
ordinary browserctrl/visual tooling or a new observation. Text fills support native
text/email/url/tel/number/search inputs and textareas. Time budgets are checked
between protocol operations and during condition polling; one in-flight CDP call
can finish or time out after the batch deadline. Click guards and input are separate
protocol calls, so a page can still change in that interval. This is not an atomic
transaction or a guarantee of arbitrary-site accuracy.

# Protected vault entry

Read this when a browser task needs a vault password or authenticator code.
Use the agent-vault skill to request credential-use permission and invoke the
approved task. The broker supplies credentials directly to this driver. Do not
retrieve values into agent context or pass them to `fill`, `type`, `do`, JavaScript
arguments, environment variables, screenshots or recordings.

## Agent workflow

1. Select the browser explicitly and keep one stable `BROWSERCTRL_AGENT_ID` for
   browser control and the broker's protected-entry invocation. This owner must
   match any claim on the chosen tab. Claims coordinate clients; they do not
   approve vault access.
2. Open a fresh dedicated background authentication tab. It must have one current
   navigation entry and no earlier history, and be claimed by that same owner.
   Existing browsing tabs are refused before input. Before credential resolution,
   inspect the target page and select its full
   Chromium target ID, exact HTTPS origin and unique CSS field and submit
   selectors. Bind those references into the proposed vault permission. A page
   title or a shortened tab ID is not a destination binding.
3. Request or reuse the matching agent-vault lease. Let the broker resolve the
   approved fields and call `browserctrl-vault` through its private stdin channel.
   The browser daemon must already be running and support protected entry.
4. Check the receipt. `completed` with `verification: submitted` means the form
   was submitted and cleanup was verified. It does not prove the account accepted
   the login. After the protected phase finishes, use ordinary browser reads to
   check the authenticated page without exposing credentials.

A cancelled caller or lost response does not undo a submitted login. Do not
replace an uncertain request with a new ID and retry automatically. Inspect the
outcome when observation is available, or follow owner recovery below.

## Trusted driver contract

The installed command is `browserctrl-vault`. Maintainers can invoke the same
entrypoint with `node /absolute/path/to/bin/browserctrl-vault.mjs`. Only the
trusted credential executor should construct its stdin request.

It accepts one bounded JSON object with these fields:

| Field | Meaning |
| --- | --- |
| `version` | `1` |
| `request_id` | Stable unique action ID, persisted as a hash to prevent replay |
| `deadline` | Unix seconds, in the future and at most 300 seconds away; bound it to the lease and any TOTP expiry |
| `destination.browser` | A configured Chromium browser name, including `dia` |
| `destination.tab_id` | Exact full Chromium target ID |
| `destination.origin` | Exact HTTPS origin, without a path, credentials or trailing slash |
| `destination.fields` | Unique CSS selectors keyed by `username`, `password` or `totp` |
| `destination.submit` | Unique CSS selector for a focusable submit control |
| `fields` | Privately supplied values with exactly the same keys as `destination.fields` |

At least a password or TOTP field is required. Password inputs must have
`type=password`; TOTP may use a visible input. Values travel over stdin and the
private daemon channel. The driver returns only status, verification and action
flags, plus an optional fixed error code. It does not return values, DOM text or
raw browser errors. See [the implementation](../lib/vault-entry.mjs) for exact
validation limits.

The broker checks vault permissions. This driver checks browser execution
constraints; invoking it directly does not create or validate a vault lease.
It connects to the existing daemon without starting or replacing it. An old
installation must complete a coordinated daemon upgrade first. See
[daemon lifecycle](connecting.md#start-here-reuse-the-shared-connection).

## What the driver protects

The daemon rejects entry while capture, recording or another request is active.
During entry, it blocks ordinary browserctrl commands, including evaluation,
page reads, screenshots, network inspection and recording setup. It performs the
origin, frame, selector, focus and deadline checks in an isolated JavaScript
world immediately before entry and submission.

Automatic release requires a full same-origin document replacement that removes
its original JavaScript context. The replacement must finish loading and pass a
scan of its URL, DOM text, attributes and input values for the password and TOTP.
A displayed username is allowed. The driver then clears only the navigation
history created by that authentication and verifies that only the current page
remains. This prevents Back from restoring a code through Chromium form history.
If history reset is unsupported, protection stays blocked. Clearing input values on the same page cannot
clear React or other JavaScript state, so an SPA submission stays blocked even
when the known inputs are empty. The driver still clears those inputs as a best
effort without sending more input events. Diagnostic page, network and recorder events stay
suppressed for the touched target for the daemon's lifetime. Other ordinary
operations become available after verified cleanup.

A request covers one form submission with a full page navigation. SPA login does
not release observation automatically. Automatic multi-page login, frames,
shadow DOM and Safari are unsupported. A password and TOTP can be entered
together if that form exposes both fields. This does not provide an automated
multi-step authentication workflow.

The approved site receives the credentials and must be trusted. Protection covers
browserctrl's mediated observation channels, not direct CDP, another automation
framework, OS screenshots or other same-user programs. It is not an OS sandbox.
The vault lease controls credential use; its expiry does not log out the website
or restrict later actions in the resulting authenticated session.

## Owner recovery after uncertain cleanup

Unverified cleanup or transport loss leaves a durable protected phase. Ordinary
browserctrl access remains blocked, including closing tabs through browserctrl.
Do not delete its marker, restart the browser or disable protection to retry.

Ask the owner to close only the affected tab using the browser UI. Preserve the
other tabs. The trusted recovery command is:

```sh
browserctrl-vault --recover
```

Run it with the same stable `BROWSERCTRL_AGENT_ID` used for entry. Send this
metadata-only object on stdin:

```json
{"version":1,"destination":{"browser":"dia","tab_id":"EXACT_TARGET_ID","origin":"https://example.com"}}
```

The driver closes nothing. The daemon matches the saved owner, browser, target
and origin, then queries Chromium itself to prove the target is absent. An
active entry, present target, missing marker, mismatch or failed query keeps the
block. `code: closed_target_recovered` confirms release. The marker retains only
coordination metadata and selectors, never passwords or TOTP values.

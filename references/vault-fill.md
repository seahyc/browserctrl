# Protected field fill (v2)

Read this when a browser task needs a vault username, password or authenticator
code. This is the recommended path; [v1 vault entry](vault-entry.md) still works
for one-page forms. Use the agent-vault skill to request the lease. The broker
resolves values and passes them to `browserctrl-vault` over private stdin. Never
fetch values into agent context or enter them with `fill`, `type`, `do` or
JavaScript.

## What the owner approves

The owner approves **which vault item may reach which origins**: 1 to 8 exact
HTTPS origins (no path, credentials or trailing slash) and the fields
(`username`, `password`, `totp`) the item supplies. The approval does not name
a tab or selectors. The lease allows repeated calls until it expires. Each call
fills exactly one field, and the broker resolves only that field. A TOTP code is
generated fresh for each call.

## Agent workflow

1. Select the browser explicitly. Keep one stable `BROWSERCTRL_AGENT_ID` for both
   your browserctrl commands and the broker's invocation. The target tab must be
   claimed by that id or unclaimed.
2. Open a new tab for the login (`open <url>`) and navigate it to the sign-in
   page. The first fill refuses a tab that has earlier history and was not
   opened through browserctrl (`tab_not_dedicated`), because lifting the taint
   resets the tab's history. Read the page (`read`) to
   get a ref for the input, or choose a CSS selector that matches exactly one
   element.
3. Call the approved lease with `tab_id` (the full target ID, not a prefix),
   `element` (`@e12`, `e12`, `ref_3`, or CSS) and `field`.
4. Check the receipt. Then click Next or Sign in yourself with an ordinary
   `click`; a fill never submits. Repeat for the next step: username, Next,
   password, Next, TOTP.

A multi-step login is just this sequence. Because the tab is tainted after the
first fill (see below), use `read`, `text`, `click` and `do` between steps,
not `eval` or `shot`.

## Driver contract

The installed command is `browserctrl-vault` (or
`node /absolute/path/to/bin/browserctrl-vault.mjs`). Only the trusted credential
executor should build its stdin request: one JSON line, at most 32 KiB.

```json
{
  "version": 2,
  "request_id": "stable-unique-id",
  "deadline": 1761200000,
  "destination": {"browser": "dia", "origins": ["https://accounts.example.com"],
                  "tab_id": "FULL_TARGET_ID", "element": "@e12 or CSS selector"},
  "field": "password",
  "value": "..."
}
```

| Field | Rule |
| --- | --- |
| `version` | `2` (`1` selects [v1](vault-entry.md)) |
| `request_id` | 16–128 of `A-Z a-z 0-9 _ -`; single use, journalled as a hash shared with v1 |
| `deadline` | Unix seconds, in the future and at most 120 s away; cap it by TOTP expiry |
| `destination.browser` | A configured Chromium browser name, such as `dia` |
| `destination.origins` | 1–8 distinct exact HTTPS origins |
| `destination.tab_id` | Exact full target ID, 8–128 characters |
| `destination.element` | Ref or CSS selector, at most 512 characters |
| `field` | `username`, `password` or `totp` |
| `value` | The one resolved value, 1–8192 characters |

Every key is required and no other key is accepted. The driver writes one line
to stdout and never includes values, DOM text or raw errors:

```json
{"status": "completed|failed|indeterminate", "verification": "filled|not_verified",
 "input_attempted": true, "action_may_have_run": false, "code": "optional_fixed_code"}
```

`action_may_have_run` is always false; a fill never submits. `completed` with
`filled` means the focused input now holds a value of the expected length. A
reused ID gets `request_already_used`. A daemon that cannot take the request
(an old version, a busy or blocked one) gives `daemon_refused` with no input
attempted. After an uncertain result, look at the page before retrying under a
new ID.

## Checks before input

1. **Trusted daemon.** The driver asks the OS (`lsof -t` on the daemon socket)
   which process listens, then checks that its command line runs this install's
   `lib/daemon-run.mjs` for that port. Anything else fails with
   `daemon_untrusted` before the value is sent. This catches a stray dev-checkout
   daemon; it is not a defence against hostile code running as the same user.
   The driver never starts or replaces a daemon.
2. `tab_id` is an exact page target on that browser, claimed by the caller or
   unclaimed (`tab_not_found`, `tab_not_owned`). The fill claims it for the caller.
   The first fill on an untainted tab also needs a tab whose history is safe to
   reset: one opened through this browserctrl daemon (any number of entries;
   the list is kept values-free on disk across restarts) or one with exactly one
   history entry. Anything else gives `tab_not_dedicated` with no input
   attempted and the request ID unused. Later fills on a tainted tab skip this.
3. `element` resolves to exactly one connected, visible, enabled, writable
   `<input>` in the top document or a same-process frame. Refs may reach into
   open shadow DOM; CSS searches the top document only (`element_not_found`,
   `element_not_visible`, `element_not_editable`).
4. The top-level origin **and** the origin of the element's document are in
   `origins` (`origin_mismatch`).
5. Field kinds: `password` needs `type=password`; `totp` needs text, tel, number
   or password; `username` needs text, email or tel (`element_kind_mismatch`).
6. The daemon focuses the element, repeats checks 4 and 5 in the same turn, then
   inserts the value with CDP `Input.insertText`. That is trusted input, so React
   and other framework-controlled inputs see it.

Checks run in an isolated JavaScript world that never receives the value. The
value is never part of a `Runtime.evaluate` expression, a log, a marker or a
recording. The daemon refuses a fill while capture or a recording is active
(`capture_or_action_active`).

## Taint after a fill

After any fill attempt the tab is **tainted**. The daemon keeps the filled values
in memory, for that tab only.

Refused on a tainted tab with `tab_tainted`:

- `eval`, `wait --fn` and any other caller JavaScript;
- raw CDP passthrough: the Node `connect()` API and `bin/stdio.mjs` `send`
  (only the CLI, batch and workflow frontends send structured commands);
- `shot`, video, recording and annotation screenshots;
- `console`, `network` and response or request bodies.

Allowed: `nav`, `click`, `key`, `type`, `scroll`, `read`, `text`, `items`,
`find`, `fields`, `html`, `do` (grounding and extraction), and closing the tab.
Every string the daemon returns while any tab is tainted passes a redactor that
replaces each filled value, raw, URI-encoded or HTML-entity encoded, with
`[redacted]`. `fields` shows a password input only as `(filled)`. A value truncated by a page script can still leak in part, so do
not read near a field you just filled more than you need to.

The taint lifts when:

- the tab closes; or
- the tab completes a cross-document navigation to a page with no frames whose
  URL, text, attributes, input values and open shadow roots contain no filled
  password or TOTP (the v1 scan). A displayed username is allowed.

On lift the daemon resets the tab's navigation history, so Back cannot restore
the filled form, and wipes the values. Chromium can only reset a tab's whole
history, so entries from before the fill go too; the current page stays. That
is why the first fill needs a browserctrl tab or one with no earlier history. If the
reset fails, the taint stays. A client-side (SPA) submission never lifts the
taint, because page JavaScript may still hold the value.

## After a daemon restart

A restart loses the values, so each taint is also recorded in a values-free
marker (`vault-taint-<port>.json`: tab, browser, owner, origins). After a restart
a marked tab refuses every operation except closing it. Ask the owner to close
the tab, then run the [v1 recovery command](vault-entry.md#owner-recovery-after-uncertain-cleanup)
with the same `BROWSERCTRL_AGENT_ID`, any one of the approved origins, and the
full target ID. The daemon checks that the tab is gone before it clears the mark.
A daemon holding taints refuses a cooperative upgrade or stop.

## Limits

Safari is not supported. Cross-process frames are not reachable. Protection
covers browserctrl's mediated channels, not direct CDP on the debugging port,
another automation tool, OS screenshots or other same-user programs. The
approved site receives the value and must be trusted; lease expiry does not log
out the website.

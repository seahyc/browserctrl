# Security policy

browserctrl can control pages in a user's browser session. Treat browser access, extension permissions, debugging ports, logs, screenshots, and profile data as sensitive.

## Reporting a vulnerability

Please do not publish an unpatched vulnerability, session data, or reproduction steps containing secrets in a public issue. Use GitHub's private vulnerability reporting for this repository if it is enabled. If it is unavailable, contact the repository maintainer privately through GitHub before sharing details. Include the affected version, impact, and a minimal reproduction that does not expose real account data.

## Scope and security boundaries

Tab claims coordinate browserctrl clients; they are not an account boundary or a security sandbox. Clients using direct CDP connections or other automation tools can bypass them. A debugging endpoint grants powerful access to the browser, so keep it bound to loopback and do not expose it to an untrusted network. The optional extension's permissions are also part of the trust boundary; review its manifest and source before loading it.

Avoid attaching browser profiles, cookie stores, raw network logs, or screenshots with personal information to reports. Redact sensitive values while preserving enough detail to reproduce the issue.

Safari access uses Apple's separate automation session and requires its Remote Automation permission. Do not assume that it grants access to the user's ordinary Safari logins or personal tabs.

POSIX log permissions use owner-only mode bits. Windows files inherit the ACLs of their directory; Node's mode bits do not enforce a Windows ACL. Keep logs in your private account directory. Lifecycle logs omit page contents, URLs, cookies, headers and scripts.

## Protected vault entry

`browserctrl-vault` accepts one bounded JSON request over stdin, never credential
arguments. The trusted daemon uses an isolated JavaScript world to verify an exact
HTTPS origin, full target ID, unique CSS selectors, top-level document and field
focus before filling and submitting. Password and visible TOTP fields use the
same protection. It reports submission, not successful account authentication.

The daemon rejects entry during capture, recording or another active request,
blocks other mediated browser commands during entry, and suppresses page/network
and recorder diagnostic events for the touched target for its lifetime. It clears
filled inputs without dispatching more input events, but same-document cleanup
never releases the phase because JavaScript state can retain the credentials.
Navigation, transport loss or unverified cleanup leaves a durable blocked marker.
Close only the affected sensitive tab, then use the trusted recovery command.
It verifies the exact target is absent before it clears the marker. Do not delete
the marker by hand merely to retry. Request IDs are single-use
and persisted as hashes so uncertain actions are never replayed automatically.
Closing the calling process does not undo an already-dispatched submit.

Entry requires a fresh dedicated tab claimed by the same coordination owner,
with one current navigation entry and no earlier history. Other tabs are refused
before input. After verified document replacement, the daemon resets that fresh
tab's authentication history and verifies only its current entry remains. This
prevents browser history from restoring TOTP form values. Unsupported reset or
verification failure leaves the gate blocked; no existing user history is erased.

The adapter connects only to an existing daemon. It never starts, replaces or
restarts a user's daemon. An old daemon rejects this operation; upgrade it at an
owner-coordinated boundary. Frames, shadow DOM selectors, multi-page sign-ins and
non-HTTPS destinations are not supported by this first contract. Navigation
cleanup is accepted only after a full document replacement at the approved
origin. Its loaded URL, DOM text, attributes and input values must pass a scan
for the submitted password and TOTP before observation resumes. Usernames may
appear in the authenticated page.
Other redirects require owner recovery if cleanup cannot be verified.

This protects the browserctrl observation channels, not direct CDP, unrelated
screen recorders, the browser UI, malicious same-user processes, or the destination
site itself. The approved site receives the credential and must be trusted.
It does not constrain subsequent authenticated website actions or log out the site
when the credential-use lease expires.

Daemon status reports active request and CDP counts, recording/capture state and
whether protected entry is blocked. Cooperative upgrades and stop requests refuse
while those are active. An idle upgrade closes only the daemon connection, keeps
tabs and stored claims, and starts the replacement on the next connection. Clients
refuse automatic replacement of a legacy daemon that lacks this handshake. Its
first upgrade needs an owner-coordinated idle window and exact-daemon shutdown.

For the trusted stdin contract, agent workflow and exact recovery procedure,
see [protected vault entry](references/vault-entry.md). Recovery requires the
original owner identity and trusted proof that the exact affected tab is gone.

## Protected field fill (v2)

A version 2 request fills one field (`username`, `password` or `totp`) in a tab
and element the agent chooses, limited to 1 to 8 approved HTTPS origins. Before
sending the value, the driver asks the OS which process listens on the daemon
socket and requires it to run this install's `lib/daemon-run.mjs`; otherwise it
fails with `daemon_untrusted`. This stops a stray development daemon, not hostile
same-user code. The daemon checks the tab claim, resolves the element to one
visible, enabled, writable input, requires both the top-level and the element's
document origin to be approved, checks the input type against the field, focuses
it, repeats the origin and type checks, and inserts the value with CDP
`Input.insertText`. Checks run in an isolated world without the value. The value
never appears in a `Runtime.evaluate` expression, a log, a marker or a recording.

A filled tab is tainted. It refuses caller JavaScript, raw CDP passthrough,
screenshots, video, recording and console or network capture, and keeps no
console, network or recorder events. Structured reads and actions still work,
and every daemon reply is redacted for each filled value in raw, URI-encoded and
HTML-entity forms. Redaction cannot catch a fragment that a page script cut off.
The taint lifts when the tab closes, or after a cross-document navigation to a
frame-free page that passes the v1 secret scan and a successful history reset.
The reset clears the whole session history of that tab. An SPA submission keeps
the taint. Taints are also recorded in a values-free marker; after a daemon
restart a marked tab allows only closing, then the v1 recovery command. See
[protected field fill](references/vault-fill.md).

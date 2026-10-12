# Security policy

browserctrl can control pages in a user's browser session. Treat browser access, extension permissions, debugging ports, logs, screenshots, and profile data as sensitive.

## Reporting a vulnerability

Please do not publish an unpatched vulnerability, session data, or reproduction steps containing secrets in a public issue. Use GitHub's private vulnerability reporting for this repository if it is enabled. If it is unavailable, contact the repository maintainer privately through GitHub before sharing details. Include the affected version, impact, and a minimal reproduction that does not expose real account data.

## Scope and security boundaries

Tab claims coordinate browserctrl clients; they are not an account boundary or a security sandbox. Clients using direct CDP connections or other automation tools can bypass them. A debugging endpoint grants powerful access to the browser, so keep it bound to loopback and do not expose it to an untrusted network. The optional extension's permissions are also part of the trust boundary; review its manifest and source before loading it.

Avoid attaching browser profiles, cookie stores, raw network logs, or screenshots with personal information to reports. Redact sensitive values while preserving enough detail to reproduce the issue.

Safari access uses Apple's separate automation session and requires its Remote Automation permission. Do not assume that it grants access to the user's ordinary Safari logins or personal tabs.

POSIX log permissions use owner-only mode bits. Windows files inherit the ACLs of their directory; Node's mode bits do not enforce a Windows ACL. Keep logs in your private account directory. Lifecycle logs omit page contents, URLs, cookies, headers and scripts.

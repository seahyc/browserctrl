# Contributing

Thanks for helping improve browserctrl. Please open an issue to discuss a substantial change before investing in it. Keep pull requests focused, explain the behavior they change, and include the commands and actual output used to verify them.

## Development setup

Use Node.js 22 or newer:

```sh
npm ci
node bin/browserctrl.mjs help
```

The CLI, daemon, and MCP server share the implementation in `lib/`. Keep user-facing behavior consistent across those entry points where they expose the same operation. Do not describe an OS or browser as supported based only on code that appears portable; add an observed compatibility result to `docs/compatibility.md` when available.

## Verification

Run the relevant checks and include their real output in the pull request description:

```sh
npm test
```

The hosted Linux CI runner sets `CHROME_TEST_NO_SANDBOX=1` for its disposable
Chrome test profile. This flag belongs only to the test harness. Normal browserctrl
commands do not disable the browser sandbox.

Browser integration checks must use an isolated browser profile and a dedicated debugging port. Do not use a signed-in personal profile or a shared live browser for automated input. Record the browser and OS versions, setup commands, result, and any limitation. A command starting successfully is not proof that the browser workflow works; verify the resulting page state. If you did not run a check, say so.

For changes to claims or browser actions, include evidence that a second client is blocked where appropriate, and that an uncertain in-flight action is observed before any retry. Do not claim that claims isolate cookies or provide a security boundary.

## Documentation and security

Keep setup examples aligned with `node bin/browserctrl.mjs help` and the current package metadata. Separate measured compatibility from possible or intended support, and avoid performance or cross-platform superiority claims without comparative evidence.

Do not include credentials, cookies, private URLs, or browser profile contents in issues, logs, screenshots, or test fixtures. See [SECURITY.md](SECURITY.md) for reporting a vulnerability.

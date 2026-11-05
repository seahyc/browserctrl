# Contributing

Thanks for helping improve browserctrl. Please open an issue to discuss a substantial change before investing in it. Keep pull requests focused, explain the behavior they change, and include the commands and actual output used to verify them.

## Development setup

Use Node.js 22 or newer (browserctrl checks this at start). Python 3.9 or newer is needed only for the Python client and its tests.

```sh
npm ci
node bin/browserctrl.mjs help
npm link        # optional: puts browserctrl on your PATH
```

The package is `@seahyc/browserctrl`; its command is `browserctrl`.

The CLI, daemon, and Python client share the implementation in `lib/`. Keep user-facing behavior consistent across those entry points where they expose the same operation. Do not describe an OS or browser as supported based only on code that appears portable; add an observed compatibility result to `docs/compatibility.md` when available.

## Verification

Run the relevant checks and include their real output in the pull request description:

```sh
npm run test:full
python -m pip install ./python
python -m unittest discover -s test -p 'test_*.py' -v
```

Three tiers (`test/run.mjs`), each running up to eight test files at once, longest first:

| Command | What | Time |
| --- | --- | --- |
| `npm run test:quick` | the files that need no browser | seconds |
| `npm test` | the core: the files that cover the most lines per second, 86% of everything the full suite covers | about a minute |
| `npm run test:full` | every file; run it before a pull request, and CI runs it | about 4-5 minutes |

`npm run test:select` re-chooses the core from a coverage run (V8 coverage of every process a file
starts) and records each file's time in `test/tiers.json`; it lists the files left out, so a new
test file is in the core until the next selection. Files that caught regressions coverage cannot
see can be kept in the core by name (`pinned`). `npm run test:serial` runs every file one at a time.
Each file runs in its own temporary `BROWSERCTRL_HOME` and on its own pair of debugging ports
(locked from 19300 up, or from `BROWSERCTRL_TEST_PORT`), so tests never touch your real notes,
recipes or claims, nor each other. Run one file with
`node --import ./test/helpers.mjs --test test/<name>.test.mjs`. Browser tests start a disposable headless
Chrome; set `CHROME_BIN` to point at one if it is not found. Tests whose pages hang on purpose
shorten the waits that decide a tab is stuck (`BROWSERCTRL_TEST_STUCK_SCALE`, see `test/load.mjs`),
and daemon tests shorten its 30 s health and IPC timeouts (`BROWSERCTRL_HEALTH_TIMEOUT_MS`,
`BROWSERCTRL_IPC_LIVENESS_MS`).

`extension/annotate.js` is a copy of `lib/overlay/annotate.js`. After changing the overlay run
`npm run sync-extension`. `npm run check-extension` (also run by CI and before packing) fails when the two differ.

CI runs the Node and Python tests on Linux, Windows and macOS with Node 22 and 24
([workflow](.github/workflows/test.yml)).

The hosted Linux CI runner sets `CHROME_TEST_NO_SANDBOX=1` for its disposable
Chrome test profile. This flag belongs only to the test harness. Normal browserctrl
commands do not disable the browser sandbox.

Browser integration checks must use an isolated browser profile and a dedicated debugging port. Do not use a signed-in personal profile or a shared live browser for automated input. Record the browser and OS versions, setup commands, result, and any limitation. A command starting successfully is not proof that the browser workflow works; verify the resulting page state. If you did not run a check, say so.

For changes to claims or browser actions, include evidence that a second client is blocked where appropriate, and that an uncertain in-flight action is observed before any retry. Do not claim that claims isolate cookies or provide a security boundary.

## Documentation and security

Keep setup examples aligned with `node bin/browserctrl.mjs help` and the current package metadata. A test checks that every command written as `browserctrl <command>` in SKILL.md and `references/` exists. New settings go in `lib/config.mjs` as `BROWSERCTRL_<NAME>` and in [references/settings.md](references/settings.md). Separate measured compatibility from possible or intended support, and avoid performance or cross-platform superiority claims without comparative evidence.

Do not include credentials, cookies, private URLs, or browser profile contents in issues, logs, screenshots, or test fixtures. See [SECURITY.md](SECURITY.md) for reporting a vulnerability.

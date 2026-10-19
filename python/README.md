# browserctrl (Python)

A small synchronous client for [browserctrl](https://github.com/seahyc/browserctrl).
It starts browserctrl's Node sidecar, so Node 22+ and the npm package must be installed:

    npm install -g @seahyc/browserctrl      # until it is published: npm ci && npm link in a clone
    pip install ./python                    # from a clone of the repository

    from browserctrl import ChromeCDP
    with ChromeCDP(browser="chrome") as c:
        print(c.tabs())

The old `import chrome_cdp` still works and prints a deprecation warning; `BrowserCtrl` is another name
for `ChromeCDP`. The client finds the sidecar through `BROWSERCTRL_STDIO` (path to `bin/stdio.mjs`), the repo it
sits in, the `browserctrl` command on PATH, or `browserctrl where`. Name an agent with `BROWSERCTRL_AGENT_ID`. See `browserctrl/HELPERS.md` for the helper workspace.

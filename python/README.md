# browserctrl (Python)

A small synchronous client for [browserctrl](https://github.com/seahyc/browserctrl).
It starts browserctrl's Node sidecar, so Node 22+ and the npm package must be installed:

    npm install -g browserctrl
    pip install browserctrl

    from browserctrl import ChromeCDP
    with ChromeCDP(browser="chrome") as c:
        print(c.tabs())

It finds the sidecar through `BROWSERCTRL_STDIO` (path to `bin/stdio.mjs`), a source
checkout, or the `browserctrl` command on PATH. See `browserctrl/HELPERS.md` for the helper workspace.

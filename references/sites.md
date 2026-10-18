# Sites: recipes, flow notes and captchas

Part of the [browserctrl skill](../SKILL.md): these sections moved here whole from the skill file.

## Use a recipe before driving a site's UI

A recipe calls a site's own API inside a tab on that site and returns structured
items in seconds. For a data task on a site (order history, inbox, search
results), look for one first with `browserctrl site <site or URL>`, which lists recipes
with their run command and then the site's flow notes; `open`, `nav` and `read` also
hint them.

```sh
browserctrl site shopee.sg                              # recipes, then flow notes
browserctrl recipe find "shopee orders"                 # recipes by words, local and tapped
browserctrl recipe run shopee.sg/orders --browser dia   # key=value args override params
```

Shared recipes come from taps, git repos of recipes:
`browserctrl recipe tap add https://github.com/seahyc/browserctrl-recipes`.

When no recipe fits and the task is worth repeating, switch on capture (off by
default: it keeps request and response bodies, headers and tokens), do the task
through the UI once, then look at what the page called and write a recipe from it:

```sh
browserctrl capture on                                  # the daemon keeps tabs' fetch/XHR traffic
browserctrl recipe endpoints shopee.sg                  # endpoint templates, counts, last seen
browserctrl recipe inspect shopee.sg get_all_order      # full exemplars: headers, tokens, bodies
browserctrl capture off                                 # when the recipe works
```

Before writing or fixing a recipe, read [the recipe format](recipes.md).
Save a recipe only after `recipe run` returns the same facts the UI showed, and
record that in its `verified` field. Recipes whose `kind` is `write` change data:
follow the user's approval rules before running one.

Each in-page call has its own deadline (`timeout_ms`, 20 s). A `read` recipe that
stalls (tab, renderer or network did not answer) is retried once and reports
`retried`; a `write` is never retried. A failure names the phase it stopped in,
each phase's time and the machine load.

## Captchas and verification pages

A managed check page (Cloudflare's "Just a moment…", "Performing security verification") is
detected as an `interstitial`. When a hand-off's wait runs out, `captcha` reloads the tab once
and checks again (`solvedBy: "reload"`), since such checks often pass on a fresh load; one that
is still there after it is reported as before. A navigation that finds the tab's renderer
stuck recovers it onto the new address, and one whose site never answers says so clearly.

Avoid triggering them. A challenge means the site is watching this browser, and
every reload or retry into it makes the next check harder:

- Prefer a recipe over driving a site's UI, and keep one warm tab per site
  instead of opening fresh ones.
- Never retry, reload or re-open a page into a challenge. Hand it to the human.

When browserctrl sees a challenge (captcha detection after `open`/`nav`, a step in
`do`, a recipe, or Jev's `challenge` flag from `check`/`do`), it starts a
**cool-down** for that site: 20 min, doubling for each further challenge that
day, up to 2 h. During it, `open`, `nav`, `do` with a `nav` step and `recipe run`
refuse the site with when it ends and why; reading tabs already open still
works. A challenge seen cleared ends the cool-down early. `--force` (MCP:
`force: true`) overrides; use it only when the user wants the site now.
`browserctrl cooldown` lists them (also shown by `tabs` and `doctor`);
`browserctrl cooldown clear <site>` ends one by hand.

To clear a challenge on a tab, run `browserctrl captcha <tab> --browser dia`
(MCP: `browser_captcha`). It drags an Alibaba drag-to-end slider once (and a
jigsaw puzzle slider, if the user enabled the solver for that site). Otherwise
it hands the tab to the human: brings it to the front, plays a sound, shows a
notification naming the site, and returns `solvedBy: human` with `waitedMs` as
soon as the challenge is gone (polled every second; `--timeout`, default 5 min).
On timeout, report the blocked tab rather than retrying. `do` and `recipe run`
do the same handoff when they hit a challenge; `--no-handoff` makes them stop
instead, `--handoff-timeout ms` bounds the wait.

Phone ping: if `BROWSERCTRL_NOTIFY_CMD` is set, the handoff also runs it through
the shell with the message as the last argument (`$BROWSERCTRL_NOTIFY_CMD
"<message>"`). browserctrl sends nothing itself. `BROWSERCTRL_NOTIFY=0` silences
the sound and notification; `BROWSERCTRL_NOTIFY_SOUND` picks another sound file.

### Opt-in jigsaw solver

Off by default. Only when the user asks for it for a site:

```sh
browserctrl captcha solver enable shopee.sg      # prints a warning; stored in ~/.config/browserctrl/captcha.json
browserctrl captcha solver status                # enabled sites and pinned selectors
browserctrl captcha solver disable shopee.sg
```

It defeats the site's bot check, may break the site's terms, and can escalate to
stronger checks. It makes one attempt, then hands the tab to the human. It
brings the tab to the front, screenshots the puzzle, finds the gap from the
image (matching the piece's picture, plus edges and shading), and drags the handle there at a human pace (probe, ease-out, overshoot
and settle). Element discovery is generic: a small visible handle (`role=slider`,
or class/id/aria-label containing slider/handle/drag/thumb/knob) on a wider track,
and the largest image/canvas near it as the background with a narrower one as
the piece. If a site's markup defeats that, pin selectors for it in the config
file:

```json
{ "solver": { "hosts": ["shopee.sg"] },
  "selectors": { "shopee.sg": { "handle": ".slider-btn", "track": ".slider-track",
                                "background": ".puzzle img.bg", "piece": ".puzzle img.piece" } } }
```

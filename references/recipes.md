# API recipe format

A recipe is one JSON file at `<site>/<name>.json`, either in your own
`~/.config/browserctrl/recipes` (override with `BROWSERCTRL_RECIPES`) or in a tap.
`browserctrl recipe run <site>/<name>` and the MCP `browser_recipe` tool run it. Every request runs inside
a tab on the recipe's origin, so the site's cookies, request signing and
anti-fraud wrappers apply as they do for the page itself.

A tap is a git repo of recipes (at its root or under `recipes/`), cloned with
`browserctrl recipe tap add <git-url>` into `~/.config/browserctrl/taps/<tap>/`
and refreshed with `recipe tap update`. A local recipe overrides a tapped one with
the same name. To share a recipe, copy it into a tap repo and open a pull request.

Recipes hold no secrets. Auth is a source that is read when the recipe runs.
Captured exemplars, which do contain tokens, stay in
`~/.local/share/browserctrl/exemplars` and are never copied into a recipe.

## Fields

| Field | Meaning |
| --- | --- |
| `name`, `description` | `site/name` and one line on what it returns. |
| `kind` | `read` or `write`. A `write` recipe changes data; get the user's approval before each call. |
| `origin` | Site origin. Requests run in a tab on it. |
| `match` | Optional URL regexes for the pages this recipe serves, used by `recipe find <url>` and the `hint:` line. Default: any page on the recipe's site or origin host, including subdomains. |
| `keywords` | Optional words for `recipe find`, e.g. `["orders", "purchases", "history"]`. |
| `warm_path` | Page to open when browserctrl creates the tab. |
| `tab` | Omit for a background tab browserctrl opens and reuses. `handoff` uses a tab the human opened (marked tabs first, matched by `handoff_match`); it is never opened, navigated or reloaded. Use it for sites that drop the session on automation-started page loads. |
| `settle_ms` | Wait after a newly created tab loads (default 1500). Some anti-fraud SDKs sign requests only once they finish starting. |
| `pace_ms` | Delay between paginated calls. |
| `auth` | Named values: `{"from": "html", "path": "/", "regex": "..."}` takes the first capture group from that page's HTML, `{"from": "cookie", "name": "..."}` reads a cookie, `{"from": "ws", "host": "...", "frame": "LOGI", "path": "key", "max_age_s": 3000}` reads a field from the latest captured WebSocket frame of that kind (the recipe's own tab is reloaded when none is fresh). Use them as `{{auth.<name>}}`. |
| `request` | `method`, `url` (relative to the origin, or absolute for another host), `headers`, `body` (object becomes JSON; string is sent as is), `credentials` (`include` by default; `omit` for a third-party API that rejects cookies on cross-origin requests). |
| `params` | Defaults. `key=value` arguments override them and keep the default's type. `{{now_iso}}` is the current time. |
| `paginate` | `{"type": "offset", "param", "step", "items", "stop_when_fewer_than"}` or `{"type": "cursor", "param", "items", "next", "dedupe"}`. `items` is the path to the result list; `max_pages` caps calls (default 100). |
| `js` | Instead of `request`: an async function source `(cursor, params) => ({ items, next })` evaluated in the page. Use it when the page's own client must sign requests or the response is not a plain list. Return `{error}` to fail. `paginate.start` is the first cursor. |
| `output` | `{field: path}` mapping applied to each item; `--raw` skips it. |
| `verified` | When it last returned the same facts as the UI, and what it returned. |

Paths use dots, `[n]`, `[-1]` for the last element and `[*]` to collect every
element. `{{x}}` alone keeps `x`'s type; inside a longer string it is
interpolated, and in a URL it is percent-encoded.

## Writing one from captured traffic

1. Drive the flow once in the UI with browserctrl so the daemon records it.
2. `browserctrl recipe endpoints <host>` lists what the page called. Pick the endpoint
   whose response holds the data; `recipe inspect <host> <match>` shows its full
   request and response.
3. Find where each token comes from: a cookie, a value in the page HTML, or a
   header the page's own client adds. When only the page's client can produce it,
   use a `js` hook that calls that client.
4. Run it with `browserctrl recipe run` and compare the result with what the UI
   showed (counts, totals, oldest item). Then fill in `verified`.

## Example

```json
{
  "name": "carousell.sg/chats",
  "kind": "read",
  "keywords": ["chats", "inbox", "offers", "messages"],
  "origin": "https://www.carousell.sg",
  "warm_path": "/inbox/",
  "pace_ms": 400,
  "auth": { "csrf": { "from": "html", "path": "/inbox/", "regex": "\"csrfToken\":\"([^\"]+)\"" } },
  "request": {
    "method": "GET",
    "url": "/ds/offer/1.0/me/?count={{count}}&type=all&latest_price_created={{cursor}}",
    "headers": { "csrf-token": "{{auth.csrf}}" }
  },
  "params": { "count": 50, "cursor": "{{now_iso}}" },
  "paginate": { "type": "cursor", "param": "cursor", "items": "data.offers", "next": "data.offers[-1].latest_price_created", "dedupe": "id" },
  "output": { "id": "id", "role": "offer_type", "title": "product.title", "at": "latest_price_created" }
}
```

#!/bin/bash
# The om2w bench browser: Google Chrome as its own instance (own profile, own debug port),
# New York time, with browserctrl's extension loaded. Never the user's Chrome or port 9222.
#
#   bench/om2w/launch-chrome.sh           start it unless it already answers
#   bench/om2w/launch-chrome.sh --fresh   stop the one this script started, wipe its profile, start again
#   bench/om2w/launch-chrome.sh stop      stop the one this script started
#
#   OM2W_PORT       debug port (default 9240)
#   OM2W_PROFILE    profile folder (default ~/.local/share/browserctrl-bench/chrome-profile);
#                   it must sit under ~/.local/share/browserctrl-bench/ because --fresh deletes it
#   OM2W_EXTENSION  unpacked extension (default: this checkout's extension/)
#
# Branded Chrome ignores --load-extension, so the extension is loaded over CDP
# (Extensions.loadUnpacked, allowed by --enable-unsafe-extension-debugging).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
PORT=${OM2W_PORT:-9240}
BENCH="$HOME/.local/share/browserctrl-bench"
PROFILE=${OM2W_PROFILE:-$BENCH/chrome-profile}
EXT=${OM2W_EXTENSION:-$here/../../extension}
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PIDFILE="$PROFILE.pid"
NODE=${NODE:-node}

case "$PORT" in 9222|9223) echo "port $PORT belongs to the user's own browser; use another (default 9240)" >&2; exit 2;; esac
case "$PROFILE" in "$BENCH"/*) ;; *) echo "OM2W_PROFILE must be under $BENCH (got $PROFILE)" >&2; exit 2;; esac

up() { curl -sf -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null; }
ours() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null && ps -p "$(cat "$PIDFILE")" -o command= | grep -q -- "--user-data-dir=$PROFILE"; }

stop() {
  if ours; then
    local pid; pid=$(cat "$PIDFILE")
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
}

case "${1:-}" in
  stop) stop; exit 0;;
  --fresh) stop;;
  "") if up; then exit 0; fi;;
  *) echo "usage: launch-chrome.sh [--fresh|stop]" >&2; exit 2;;
esac

if up; then echo "port $PORT is taken by a browser this script did not start; not touching it" >&2; exit 1; fi
if [ "${1:-}" = --fresh ] || [ ! -d "$PROFILE" ]; then rm -rf "$PROFILE"; mkdir -p "$PROFILE"; fi
TZ=America/New_York nohup "$CHROME" --user-data-dir="$PROFILE" --remote-debugging-port="$PORT" \
  --no-first-run --no-default-browser-check --disable-search-engine-choice-screen \
  --enable-unsafe-extension-debugging about:blank >"$PROFILE.log" 2>&1 &
echo $! >"$PIDFILE"
for _ in $(seq 1 100); do up && break; sleep 0.2; done
up || { echo "Chrome did not answer on port $PORT; see $PROFILE.log" >&2; exit 1; }
"$NODE" --input-type=module -e '
const [port, ext] = process.argv.slice(1);
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
const r = await new Promise((ok) => { ws.onmessage = (m) => ok(JSON.parse(m.data)); ws.send(JSON.stringify({ id: 1, method: "Extensions.loadUnpacked", params: { path: ext } })); });
ws.close();
if (r.error) { console.error(`extension not loaded: ${r.error.message}`); process.exit(1); }
' "$PORT" "$(cd "$EXT" && pwd)"

#!/usr/bin/env bash
# Phase 8 smoke — launch fork once per panel with --slayzone-home-panel=<id>
# so SlayzoneBrowserView swaps into home-mode (Phase 8.5). The home WebView
# has RegionData installed, so the per-BrowserView Mojo host resolves and
# the panel receives sidecar data.
#
# Usage:
#   ./scripts/chromium/smoke-phase-8.sh
#   open /tmp/slayzone-phase-8-automations.png   # etc.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="$REPO_ROOT/chromium/src/out/Default/SlayZone.app/Contents/MacOS/SlayZone"
BUNDLE_DIR="$REPO_ROOT/packages/webui"
PANELS=(automations processes test git)
PORT=9666

if [[ ! -x "$APP" ]]; then
  echo "binary not found: $APP — run scripts/chromium/build.sh" >&2
  exit 1
fi

for panel in "${PANELS[@]}"; do
  echo "[smoke] panel=$panel" >&2
  USER_DATA_DIR="$(mktemp -d -t slayzone-smoke)"
  # ROOT anchors the sidecar socket: both the fork's C++ shell and the JS sidecar
  # derive <ROOT>/run/sidecar.sock from SLAYZONE_ROOT — no separate socket var.
  export SLAYZONE_ROOT="$(mktemp -d -t slayzone-root)"
  RUNTIME_DIR="$SLAYZONE_ROOT/run"
  mkdir -p "$RUNTIME_DIR"
  SIDECAR_LOG="$RUNTIME_DIR/sidecar.log"

  # Start sidecar.
  (
    cd "$REPO_ROOT"
    exec "$REPO_ROOT/node_modules/.bin/tsx" "$REPO_ROOT/packages/sidecar/src/bin/main.ts"
  ) >"$SIDECAR_LOG" 2>&1 &
  SIDECAR_PID=$!
  for _ in $(seq 1 80); do
    [[ -S "$RUNTIME_DIR/sidecar.sock" ]] && break
    sleep 0.1
  done

  # Launch fork headless with the home-panel flag set. SlayzoneBrowserView
  # (patch 0027) swaps into home-mode in AddedToWidget and loads the
  # corresponding chrome://slayzone-<panel>/ in home_panel_webview_.
  "$APP" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
    --allow-chrome-scheme-url \
    --remote-allow-origins='*' \
    --slayzone-webui-bundle-dir="$BUNDLE_DIR" \
    --slayzone-home-panel="$panel" \
    --user-data-dir="$USER_DATA_DIR" \
    --remote-debugging-port="$PORT" \
    > "$USER_DATA_DIR/fork.log" 2>&1 &
  FORK_PID=$!

  for _ in $(seq 1 50); do
    curl -fsS "http://localhost:$PORT/json/version" > /dev/null 2>&1 && break
    sleep 0.2
  done

  # Give the home panel time to load + poll once.
  sleep 3

  # Screenshot the home panel. In home-mode the home_panel_webview_'s
  # WebContents is the primary content of the SlayzoneBrowserView, and its
  # CDP target is discoverable at chrome://slayzone-<panel>/.
  out="/tmp/slayzone-phase-8-$panel.png"
  python3 - "$PORT" "$panel" "$out" <<'PY'
import base64, json, sys, urllib.request
from websocket import create_connection
port, panel, out = sys.argv[1], sys.argv[2], sys.argv[3]
targets = json.loads(urllib.request.urlopen(f"http://localhost:{port}/json").read())
want_url = f"chrome://slayzone-{panel}/"
match = next((t for t in targets if t.get("url", "").startswith(want_url)), None)
if not match:
    page = next((t for t in targets if t.get("type") == "page"), None)
    match = page
if not match:
    sys.exit(f"no target found for {panel}; got: {[t.get('url') for t in targets]}")
ws = create_connection(match["webSocketDebuggerUrl"])
ws.send(json.dumps({"id": 1, "method": "Page.captureScreenshot"}))
while True:
    msg = json.loads(ws.recv())
    if msg.get("id") == 1:
        png = base64.b64decode(msg["result"]["data"])
        open(out, "wb").write(png)
        break
ws.close()
print(f"  → {out} ({match.get('url')})", file=sys.stderr)
PY

  kill "$FORK_PID" 2>/dev/null || true
  kill "$SIDECAR_PID" 2>/dev/null || true
  sleep 1
done

echo "[smoke] done. Screenshots:" >&2
ls -la /tmp/slayzone-phase-8-*.png

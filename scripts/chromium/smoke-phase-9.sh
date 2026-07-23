#!/usr/bin/env bash
# Phase 9 smoke — launch fork once per overlay, open overlay URL via CDP
# /json/new, screenshot. Unlike Phase 8 (home-mode swap via
# --slayzone-home-panel), Phase 9 overlays render at their chrome:// URL
# directly because overlay-routing (patch 0038) is held behind Phase 7 R3
# terminal-slot edits. When 0038 lands, this script will switch to a
# --slayzone-overlay=<id> flag mirroring smoke-phase-8.sh.
#
# Usage:
#   ./scripts/chromium/smoke-phase-9.sh
#   open /tmp/slayzone-phase-9-leaderboard.png   # etc.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="$REPO_ROOT/chromium/src/out/Default/SlayZone.app/Contents/MacOS/SlayZone"
BUNDLE_DIR="$REPO_ROOT/packages/webui"
OVERLAYS=(leaderboard usage context)
PORT=9666

if [[ ! -x "$APP" ]]; then
  echo "binary not found: $APP — run scripts/chromium/build.sh" >&2
  exit 1
fi

for overlay in "${OVERLAYS[@]}"; do
  echo "[smoke] overlay=$overlay" >&2
  USER_DATA_DIR="$(mktemp -d -t slayzone-smoke)"
  # ROOT anchors the sidecar socket: both the fork's C++ shell and the JS sidecar
  # derive <ROOT>/run/sidecar.sock from SLAYZONE_ROOT — no separate socket var.
  export SLAYZONE_ROOT="$(mktemp -d -t slayzone-root)"
  RUNTIME_DIR="$SLAYZONE_ROOT/run"
  mkdir -p "$RUNTIME_DIR"
  SIDECAR_LOG="$RUNTIME_DIR/sidecar.log"

  # Start sidecar. Phase 9 overlay methods (leaderboard:get-snapshot,
  # usage:get-snapshot, context:get-snapshot) may not yet be implemented —
  # the per-UI host falls back to an empty snapshot so the overlay still
  # renders its frame + empty-state copy.
  (
    cd "$REPO_ROOT"
    exec "$REPO_ROOT/node_modules/.bin/tsx" "$REPO_ROOT/packages/sidecar/src/bin/main.ts"
  ) >"$SIDECAR_LOG" 2>&1 &
  SIDECAR_PID=$!
  for _ in $(seq 1 80); do
    [[ -S "$RUNTIME_DIR/sidecar.sock" ]] && break
    sleep 0.1
  done

  "$APP" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
    --allow-chrome-scheme-url \
    --remote-allow-origins='*' \
    --slayzone-webui-bundle-dir="$BUNDLE_DIR" \
    --user-data-dir="$USER_DATA_DIR" \
    --remote-debugging-port="$PORT" \
    > "$USER_DATA_DIR/fork.log" 2>&1 &
  FORK_PID=$!

  for _ in $(seq 1 50); do
    curl -fsS "http://localhost:$PORT/json/version" > /dev/null 2>&1 && break
    sleep 0.2
  done

  # Open the overlay URL as a fresh target.
  curl -fsS -X PUT "http://localhost:$PORT/json/new?chrome://slayzone-$overlay/" > /dev/null

  sleep 3

  out="/tmp/slayzone-phase-9-$overlay.png"
  python3 - "$PORT" "$overlay" "$out" <<'PY'
import base64, json, sys, urllib.request
from websocket import create_connection
port, overlay, out = sys.argv[1], sys.argv[2], sys.argv[3]
targets = json.loads(urllib.request.urlopen(f"http://localhost:{port}/json").read())
want_url = f"chrome://slayzone-{overlay}/"
match = next((t for t in targets if t.get("url", "").startswith(want_url)), None)
if not match:
    sys.exit(f"no target found for {overlay}; got: {[t.get('url') for t in targets]}")
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
ls -la /tmp/slayzone-phase-9-*.png

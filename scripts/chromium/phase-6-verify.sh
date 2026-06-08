#!/usr/bin/env bash
# Phase 6 verification orchestrator. Fetches what extensions it can, launches
# the built SlayZone fork headless + with a remote-debugging port, runs the
# Bun-based CDP driver (phase-6-verify.mjs), and writes a JSON report.
#
# Usage: bash scripts/chromium/phase-6-verify.sh [--skip-extensions]
#
# What it automates:
#   - uBlock Origin unpacked download from GitHub releases (falls back to
#     skipping if the network or ZIP is unavailable).
#   - headless SlayZone launch with a throwaway user-data-dir.
#   - every check in phase-6-verify.mjs (SSO URL load, region WebUI inventory,
#     tab-switch benchmark).
#
# What stays manual (listed in the final report under `needs_user`):
#   - React DevTools unpacked build + load.
#   - 1Password install (Web Store only).
#   - The actual sign-in click-through for all 4 SSO flows.

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

SKIP_EXT=0
for arg in "$@"; do
  case "$arg" in
    --skip-extensions) SKIP_EXT=1 ;;
    *) ;;
  esac
done

PORT=9555
RUN_DIR="$(mktemp -d)"
EXT_DIR="$RUN_DIR/extensions"
USER_DATA_DIR="$RUN_DIR/udd"
REPORT="$REPO_ROOT/docs/chromium/phase-6-verification-report.json"
mkdir -p "$EXT_DIR" "$USER_DATA_DIR" "$(dirname "$REPORT")"

echo "[phase-6-verify] run dir: $RUN_DIR"
echo "[phase-6-verify] report : $REPORT"

# -----------------------------------------------------------------------------
# 1) Build a tiny MV3 smoke-test extension. The runbook names (1Password,
#    React DevTools, uBlock Origin) ship on the Web Store or require their
#    own unpacked build pipelines, so we use an inline MV3 extension to
#    prove the pipe end-to-end. Chrome 138+ disables MV2; MV3 is what Phase
#    7 consumers will use anyway.
# -----------------------------------------------------------------------------
SMOKE_EXT_DIR="$EXT_DIR/slayzone-smoke"
mkdir -p "$SMOKE_EXT_DIR"
cat > "$SMOKE_EXT_DIR/manifest.json" <<'JSON'
{
  "manifest_version": 3,
  "name": "SlayZone Phase 6 Smoke",
  "version": "0.0.1",
  "description": "Minimal MV3 extension used by phase-6-verify to prove the extension pipe loads end-to-end.",
  "permissions": ["storage"],
  "background": { "service_worker": "sw.js" },
  "action": { "default_title": "SlayZone Smoke" }
}
JSON
cat > "$SMOKE_EXT_DIR/sw.js" <<'JS'
// Intentionally trivial — phase-6-verify only cares that this registers as
// a chrome-extension://<id>/ service worker target on CDP /json/list.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ slayzone_smoke: { ts: Date.now() } });
});
JS
echo "[phase-6-verify] smoke extension at: $SMOKE_EXT_DIR"
EXT_LOAD="$SMOKE_EXT_DIR"

# -----------------------------------------------------------------------------
# 2) Locate the built binary.
# -----------------------------------------------------------------------------
APP="$CHROMIUM_SRC/out/Default/SlayZone.app/Contents/MacOS/SlayZone"
if [[ ! -x "$APP" ]]; then
  echo "[phase-6-verify] binary not found at $APP — run scripts/chromium/build.sh first" >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# 3) Launch SlayZone headless with CDP port.
# -----------------------------------------------------------------------------
LAUNCH_ARGS=(
  --headless=new
  --disable-gpu
  --no-first-run
  --no-default-browser-check
  --allow-chrome-scheme-url
  --slayzone-layout-shell
  "--user-data-dir=$USER_DATA_DIR"
  "--remote-debugging-port=$PORT"
  "chrome://slayzone-shell/"
)
if [[ -n "$EXT_LOAD" ]]; then
  LAUNCH_ARGS=("--load-extension=$EXT_LOAD" "${LAUNCH_ARGS[@]}")
fi

echo "[phase-6-verify] launching: $APP ${LAUNCH_ARGS[*]}"
"$APP" "${LAUNCH_ARGS[@]}" \
  > "$RUN_DIR/slayzone.stdout.log" \
  2> "$RUN_DIR/slayzone.stderr.log" \
  &
BIN_PID=$!
echo "[phase-6-verify] SlayZone pid: $BIN_PID"

cleanup() {
  if kill -0 "$BIN_PID" 2>/dev/null; then
    echo "[phase-6-verify] stopping SlayZone (pid=$BIN_PID)"
    kill "$BIN_PID" 2>/dev/null || true
    wait "$BIN_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# -----------------------------------------------------------------------------
# 4) Wait for CDP to accept connections.
# -----------------------------------------------------------------------------
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
if ! curl -fsS "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "[phase-6-verify] CDP did not come up on :$PORT within 30s" >&2
  echo "[phase-6-verify] stderr tail:" >&2
  tail -30 "$RUN_DIR/slayzone.stderr.log" >&2 || true
  exit 1
fi
echo "[phase-6-verify] CDP ready on :$PORT"

# -----------------------------------------------------------------------------
# 5) Drive the verification script.
# -----------------------------------------------------------------------------
bun "$REPO_ROOT/scripts/chromium/phase-6-verify.mjs" \
  --port "$PORT" \
  --out "$REPORT"

echo "[phase-6-verify] done. Report at $REPORT"

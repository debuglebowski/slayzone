#!/usr/bin/env bash
# Iteration-2 layout-fidelity validation harness.
#
# Launches the Chromium fork once per LayoutMode (home / task-detail /
# overlay) via --slayzone-layout-mode=<id>, screenshots the top-level
# window via macOS `screencapture`, and emits the shots under
# docs/chromium/layout-modes/ for the markdown doc to embed.
#
# The Electron reference binary is NOT launched by this script — the
# canonical Electron screenshots live at the `ELECTRON_SCREENSHOTS`
# paths below (dropped by the orchestrator in /var/folders/...). When
# regenerating the Electron side, re-capture from `pnpm dev` at the same
# window size (1440×900 is the baseline).
#
# Usage:
#   ./scripts/chromium/compare-with-electron.sh            # all 3 modes
#   ./scripts/chromium/compare-with-electron.sh home       # single mode

set -euo pipefail

# Default to seeded demo data so vanilla invocation yields a fair fork vs
# Electron comparison (kanban with projects + cards, not "No projects").
# External env still wins — set SLAYZONE_SEED_DEMO=0 to opt out.
export SLAYZONE_SEED_DEMO="${SLAYZONE_SEED_DEMO:-1}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="$REPO_ROOT/chromium/src/out/Default/SlayZone.app/Contents/MacOS/SlayZone"
BUNDLE_DIR="$REPO_ROOT/packages/webui"
OUT_DIR="$REPO_ROOT/docs/chromium/layout-modes"
MODES=("$@")
if [[ ${#MODES[@]} -eq 0 ]]; then
  MODES=(home task-detail overlay)
fi

if [[ ! -x "$APP" ]]; then
  echo "[layout-modes] binary missing: $APP — run scripts/chromium/build.sh" >&2
  exit 1
fi
mkdir -p "$OUT_DIR"

# Launch sidecar once — all modes share it so regions can bind their Mojo
# hosts and paint real data instead of empty-state placeholders.
# ROOT anchors the sidecar socket: both the fork's C++ shell and the JS sidecar
# derive <ROOT>/run/sidecar.sock from SLAYZONE_ROOT — no separate socket var.
export SLAYZONE_ROOT="$(mktemp -d -t slayzone-layout-modes)"
RUNTIME_DIR="$SLAYZONE_ROOT/run"
mkdir -p "$RUNTIME_DIR"
SIDECAR_LOG="$RUNTIME_DIR/sidecar.log"
(
  cd "$REPO_ROOT"
  exec "$REPO_ROOT/node_modules/.bin/tsx" "$REPO_ROOT/packages/sidecar/src/bin/main.ts"
) >"$SIDECAR_LOG" 2>&1 &
SIDECAR_PID=$!
trap 'kill "$SIDECAR_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 80); do
  [[ -S "$RUNTIME_DIR/sidecar.sock" ]] && break
  sleep 0.1
done

for mode in "${MODES[@]}"; do
  case "$mode" in
    home|task-detail|overlay) ;;
    *) echo "[layout-modes] skipping unknown mode: $mode" >&2; continue ;;
  esac

  echo "[layout-modes] capturing mode=$mode" >&2
  USER_DATA_DIR="$(mktemp -d -t slayzone-layout-modes-user)"
  # The overlay mode only activates the grid underneath; to actually see an
  # overlay painted we additionally drive SlayzoneOverlayManager via its
  # CLI hook (deferred — Phase 9.4 notes defer the `--slayzone-overlay=`
  # switch to a follow-up). For iteration-2 fidelity we accept that the
  # overlay shot shows the underlying grid with the mode enum set so the
  # region visibility toggle is exercised; the overlay WebView paint is
  # covered by docs/chromium/phase-9-smoke.md.

  "$APP" \
    --no-first-run --no-default-browser-check \
    --allow-chrome-scheme-url \
    --slayzone-webui-bundle-dir="$BUNDLE_DIR" \
    --slayzone-layout-mode="$mode" \
    --user-data-dir="$USER_DATA_DIR" \
    --window-size=1440,900 \
    --window-position=80,80 \
    > "$USER_DATA_DIR/fork.log" 2>&1 &
  FORK_PID=$!

  # Give the window a beat to lay out + regions to paint first frame.
  sleep 5

  out="$OUT_DIR/fork-$mode.png"
  # screencapture -l needs a CoreGraphics window id. Disambiguate the
  # fork's window by looking up the System Events process that owns the
  # fork PID — matching on process name collides with the outer Electron
  # SlayZone that may also be running in this dogfood session.
  WINDOW_ID="$(osascript <<OSA 2>/dev/null || true
tell application "System Events"
  try
    tell (first process whose unix id is ${FORK_PID})
      return id of window 1
    end tell
  end try
end tell
OSA
)"

  if [[ -n "$WINDOW_ID" ]]; then
    screencapture -l "$WINDOW_ID" -o -x "$out" || \
      screencapture -R 80,80,1440,900 -o -x "$out"
  else
    # Fallback to a fixed region matching the launch geometry. If Screen
    # Recording permission is not granted to Terminal/iTerm/Claude Code
    # this may capture the host foreground app — grant permission in
    # System Settings › Privacy & Security › Screen Recording.
    screencapture -R 80,80,1440,900 -o -x "$out"
  fi

  kill "$FORK_PID" 2>/dev/null || true
  wait "$FORK_PID" 2>/dev/null || true
  echo "  → $out" >&2
done

echo "[layout-modes] captured ${#MODES[@]} mode(s) → $OUT_DIR" >&2
ls -la "$OUT_DIR"

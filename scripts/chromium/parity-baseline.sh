#!/usr/bin/env bash
# Phase 7.11 — capture parity baselines for all fork regions.
# Launches the fork + sidecar, iterates tools/parity/regions.json, invokes
# tools/parity/compare.js --baseline for each, then tears down.
#
# Usage:
#   ./scripts/chromium/parity-baseline.sh
#
# Electron baseline is blocked (electron-vite CDP gap confirmed by the
# orchestrator); the harness runs in fork-vs-fork regression mode against
# the PNGs this script writes.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="$REPO_ROOT/chromium/src/out/Default/SlayZone.app/Contents/MacOS/SlayZone"
BUNDLE_DIR="$REPO_ROOT/packages/webui"
PORT=9666

if [[ ! -x "$APP" ]]; then
  echo "binary not found: $APP — run scripts/chromium/build.sh" >&2
  exit 1
fi

USER_DATA_DIR="$(mktemp -d -t slayzone-parity)"
export SLAYZONE_RUNTIME_DIR="$(mktemp -d -t slayzone-parity-rt)"
SIDECAR_LOG="$SLAYZONE_RUNTIME_DIR/sidecar.log"
FORK_LOG="$USER_DATA_DIR/fork.log"

echo "[parity] runtime_dir=$SLAYZONE_RUNTIME_DIR" >&2

(
  cd "$REPO_ROOT"
  exec "$REPO_ROOT/node_modules/.bin/tsx" "$REPO_ROOT/packages/sidecar/src/bin/main.ts"
) >"$SIDECAR_LOG" 2>&1 &
SIDECAR_PID=$!
FORK_PID=""
trap 'kill "$SIDECAR_PID" 2>/dev/null || true; [[ -n "$FORK_PID" ]] && kill "$FORK_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 80); do
  [[ -S "$SLAYZONE_RUNTIME_DIR/sidecar.sock" ]] && break
  sleep 0.1
done

"$APP" \
  --slayzone-webui-bundle-dir="$BUNDLE_DIR" \
  --user-data-dir="$USER_DATA_DIR" \
  --remote-debugging-port="$PORT" \
  --no-first-run \
  >"$FORK_LOG" 2>&1 &
FORK_PID=$!

for _ in $(seq 1 80); do
  curl -fsS "http://localhost:$PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.2
done

REGIONS=$(node -e 'const r = require("'"$REPO_ROOT"'/tools/parity/regions.json"); console.log(Object.keys(r).filter(k => !k.startsWith("$") && r[k] && !r[k]["$deferred"]).join(" "))')

echo "[parity] regions: $REGIONS" >&2

for region in $REGIONS; do
  echo "[parity] baseline $region" >&2
  node "$REPO_ROOT/tools/parity/compare.js" "$region" --baseline --fork-port="$PORT" || {
    echo "[parity] region=$region failed — continuing" >&2
  }
done

echo "[parity] baselines written to tools/parity/baselines/" >&2
ls "$REPO_ROOT/tools/parity/baselines/"

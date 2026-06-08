#!/usr/bin/env bash
# Launch the built Chromium fork.
#   Usage: run.sh [out-dir] [-- chrome-args...]
#
# Phase 7.1 additions: auto-launches the Bun sidecar (so
# chrome://slayzone-statusbar/ and future regions have real data) and
# defaults SLAYZONE_WEBUI_BUNDLE_DIR when unset so the statusbar WebUI can
# find its JS bundle. Opt out via SLAYZONE_NO_SIDECAR=1.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

OUT_DIR="out/Default"
if [[ "${1:-}" == "--" ]]; then
  shift
elif [[ -n "${1:-}" && "${1:0:1}" != "-" ]]; then
  OUT_DIR="$1"
  shift
  [[ "${1:-}" == "--" ]] && shift
fi

cd "$CHROMIUM_SRC"

case "$(uname -s)" in
  Darwin) APP="$OUT_DIR/SlayZone.app/Contents/MacOS/SlayZone" ;;
  Linux)  APP="$OUT_DIR/chrome" ;;
  MINGW*|MSYS*|CYGWIN*) APP="$OUT_DIR/chrome.exe" ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

if [[ ! -x "$APP" ]]; then
  echo "binary not found: $APP" >&2
  echo "build first: scripts/chromium/build.sh" >&2
  exit 1
fi

# Sidecar lifecycle (Phase 7.1 — superseded by Phase 3.7 native lifecycle
# integration when that wires up). Spawns the sidecar so regions have live
# data; kills it on exit.
SIDECAR_PID=""
if [[ "${SLAYZONE_NO_SIDECAR:-0}" != "1" ]]; then
  # Pick a per-run runtime dir so concurrent launches don't fight over the
  # socket. Respect an explicit override.
  if [[ -z "${SLAYZONE_RUNTIME_DIR:-}" ]]; then
    SLAYZONE_RUNTIME_DIR="$(mktemp -d -t slayzone-runtime)"
    export SLAYZONE_RUNTIME_DIR
  fi
  SOCKET_PATH="$SLAYZONE_RUNTIME_DIR/sidecar.sock"
  SIDECAR_LOG="$SLAYZONE_RUNTIME_DIR/sidecar.log"
  echo "[run] starting sidecar (socket=$SOCKET_PATH, log=$SIDECAR_LOG)" >&2
  (
    cd "$REPO_ROOT"
    exec "$REPO_ROOT/node_modules/.bin/tsx" "$REPO_ROOT/packages/sidecar/src/bin/main.ts"
  ) >"$SIDECAR_LOG" 2>&1 &
  SIDECAR_PID=$!
  trap 'kill '"$SIDECAR_PID"' 2>/dev/null || true' EXIT

  # Wait up to 8s for the socket to appear.
  for _ in $(seq 1 80); do
    [[ -S "$SOCKET_PATH" ]] && break
    sleep 0.1
  done
  if [[ ! -S "$SOCKET_PATH" ]]; then
    echo "[run] sidecar failed to bind socket within 8s — see $SIDECAR_LOG" >&2
    cat "$SIDECAR_LOG" >&2 || true
    exit 1
  fi
  echo "[run] sidecar ready (pid=$SIDECAR_PID)" >&2
fi

# Default the webui bundle dir to the repo's webui package root so the fork
# can render chrome://slayzone-<region>/ without extra flags. The C++ WebUI
# controller resolves <region>/dist/ under this root.
if [[ -z "${SLAYZONE_WEBUI_BUNDLE_DIR:-}" ]]; then
  SLAYZONE_WEBUI_BUNDLE_DIR="$REPO_ROOT/packages/webui"
  export SLAYZONE_WEBUI_BUNDLE_DIR
fi

# Default the shell bundle dir so chrome://slayzone-shell/ resolves to the
# Vite-built bundle at packages/apps/chromium-shell/dist/. Override via env or
# pass --slayzone-shell-bundle-dir=… directly.
if [[ -z "${SLAYZONE_SHELL_BUNDLE_DIR:-}" ]]; then
  SLAYZONE_SHELL_BUNDLE_DIR="$REPO_ROOT/packages/apps/chromium-shell"
  export SLAYZONE_SHELL_BUNDLE_DIR
fi

EXTRA_ARGS=(
  "--slayzone-webui-bundle-dir=$SLAYZONE_WEBUI_BUNDLE_DIR"
  "--slayzone-shell-bundle-dir=$SLAYZONE_SHELL_BUNDLE_DIR"
)

exec "$APP" "${EXTRA_ARGS[@]}" "$@"

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

# Sidecar lifecycle. Spawns the standalone tRPC server so chrome://slayzone-*
# regions AND the renderer's tRPC-WS client (Home tab → server-mode) have live
# data; kills it on exit. Opt out via SLAYZONE_NO_SIDECAR=1.
#
# The server (@slayzone/server) binds TCP loopback and serves /trpc + /health.
# It MUST run under Electron-as-node (ELECTRON_RUN_AS_NODE=1 + the electron
# binary), never plain node/tsx — better-sqlite3 / node-pty are compiled against
# Electron's node ABI and fail to load otherwise. We run the built dist/bin.cjs
# (produced by `pnpm build:chromium`). Port defaults to 8766 (dev) so the
# renderer's baked-in default WS URL resolves without extra plumbing; override
# with SLAYZONE_PORT. SLAYZONE_SUPERVISED stays unset → the server does not
# self-terminate on stdin close, so a backgrounded run survives.
SIDECAR_PID=""
if [[ "${SLAYZONE_NO_SIDECAR:-0}" != "1" ]]; then
  # Force the host:port the renderer's baked-in default expects (window-api-shim
  # server-url.ts → ws://127.0.0.1:8766/trpc). We deliberately do NOT honor an
  # inherited SLAYZONE_PORT/SLAYZONE_HOST: the renderer hardcodes the URL and has
  # no override channel yet, so the sidecar MUST match it. A leaked SLAYZONE_PORT
  # — e.g. dogfooding from inside a running SlayZone process, which exports its
  # own sidecar's port — would otherwise make this bind the wrong port (and
  # collide: EADDRINUSE), leaving the renderer with nothing to connect to. Relax
  # once the --slayzone-server-url flag is wired through the C++ shell.
  SLAYZONE_HOST=127.0.0.1
  SLAYZONE_PORT=8766
  export SLAYZONE_HOST SLAYZONE_PORT
  if [[ -z "${SLAYZONE_RUNTIME_DIR:-}" ]]; then
    SLAYZONE_RUNTIME_DIR="$(mktemp -d -t slayzone-runtime)"
    export SLAYZONE_RUNTIME_DIR
  fi
  SIDECAR_LOG="$SLAYZONE_RUNTIME_DIR/sidecar.log"
  ELECTRON_BIN="$REPO_ROOT/node_modules/.bin/electron"
  SERVER_BIN="$REPO_ROOT/packages/apps/server/dist/bin.cjs"
  if [[ ! -f "$SERVER_BIN" ]]; then
    echo "[run] server bundle missing: $SERVER_BIN" >&2
    echo "[run] build it first: pnpm --filter @slayzone/server build" >&2
    exit 1
  fi
  echo "[run] starting sidecar (tRPC ws://$SLAYZONE_HOST:$SLAYZONE_PORT/trpc, log=$SIDECAR_LOG)" >&2
  # -u SLAYZONE_SUPERVISED: this is a standalone run, not a supervised child.
  # The server self-terminates on stdin close ONLY when SLAYZONE_SUPERVISED=1;
  # unset it (it can leak from a parent SlayZone process) and detach stdin so
  # backgrounding never trips that path. The DB is intentionally the default dev
  # store (real tasks) — do NOT run this alongside the Electron dev app against
  # the same DB.
  (
    cd "$REPO_ROOT"
    exec env -u SLAYZONE_SUPERVISED ELECTRON_RUN_AS_NODE=1 "$ELECTRON_BIN" "$SERVER_BIN"
  ) </dev/null >"$SIDECAR_LOG" 2>&1 &
  SIDECAR_PID=$!
  trap 'kill '"$SIDECAR_PID"' 2>/dev/null || true' EXIT

  # Wait up to 8s for the HTTP health endpoint to answer.
  for _ in $(seq 1 80); do
    if curl -sf "http://$SLAYZONE_HOST:$SLAYZONE_PORT/health" >/dev/null 2>&1; then break; fi
    sleep 0.1
  done
  if ! curl -sf "http://$SLAYZONE_HOST:$SLAYZONE_PORT/health" >/dev/null 2>&1; then
    echo "[run] sidecar failed health check within 8s — see $SIDECAR_LOG" >&2
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
  # Suppress the "Chrome didn't shut down correctly / Restore pages?" bubble —
  # SlayZone manages its own task/session state; the crash-restore prompt (esp.
  # after dev kills) is noise. Gates HasPendingUncleanExit (startup_browser_creator).
  "--hide-crash-restore-bubble"
)

# cap-layout-p4 — the ad-hoc-signed dev build deadlocks the browser main thread
# in OSCrypt → KeychainPassword::GetPassword() (synchronous Keychain mutex never
# returns without the right entitlement), so the message loop never starts and
# the window/DevTools never come up ("Terminating after 15s with no
# connection"). Mock keychain sidesteps it. Override with SLAYZONE_REAL_KEYCHAIN=1
# once the build is properly codesigned with keychain-access entitlements.
if [[ "${SLAYZONE_REAL_KEYCHAIN:-0}" != "1" ]]; then
  EXTRA_ARGS+=("--use-mock-keychain")
fi

exec "$APP" "${EXTRA_ARGS[@]}" "$@"

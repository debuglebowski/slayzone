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
# The server (@slayzone/hub) binds TCP loopback and serves /trpc + /health.
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
  SERVER_BIN="$REPO_ROOT/packages/apps/hub/dist/bin.cjs"
  if [[ ! -f "$SERVER_BIN" ]]; then
    echo "[run] server bundle missing: $SERVER_BIN" >&2
    echo "[run] build it first: pnpm --filter @slayzone/hub build" >&2
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

  # Identity check: is the process listening on $SLAYZONE_PORT one WE spawned?
  # The renderer's WS URL is hard-pinned to this port (window-api-shim
  # server-url.ts) and server.ts has NO port fallback — a collision kills our
  # sidecar with EADDRINUSE while a SQUATTER (an orphaned sidecar from a prior
  # run that the EXIT trap missed, or another instance) keeps answering /health.
  # A plain health probe can't tell the two apart, so the fork would silently
  # adopt the wrong DB. Match the port's listener to our spawn instead.
  #
  # node_modules/.bin/electron is a JS shim that spawns the real Electron binary
  # as a CHILD, so the listener is a descendant of $SIDECAR_PID, not == it —
  # walk the parent chain. lsof is on macOS/Linux; where it's absent (Windows
  # MSYS) fall back to a liveness check (our sidecar dead + port answering =
  # squatter).
  port_owner_is_ours() {
    command -v lsof >/dev/null 2>&1 || { kill -0 "$SIDECAR_PID" 2>/dev/null; return; }
    local owner cur
    owner="$(lsof -nP -iTCP:"$SLAYZONE_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
    [[ -z "$owner" ]] && return 1
    cur="$owner"
    for _ in 1 2 3 4 5; do
      [[ "$cur" == "$SIDECAR_PID" ]] && return 0
      cur="$(ps -o ppid= -p "$cur" 2>/dev/null | tr -d ' ')"
      [[ -z "$cur" || "$cur" == "1" || "$cur" == "0" ]] && break
    done
    return 1
  }

  # Wait up to 8s for OUR sidecar to answer health on the port. Stop early if it
  # already exited (EADDRINUSE) — no point waiting on a dead process.
  ready=0
  for _ in $(seq 1 80); do
    if curl -sf "http://$SLAYZONE_HOST:$SLAYZONE_PORT/health" >/dev/null 2>&1 && port_owner_is_ours; then
      ready=1
      break
    fi
    kill -0 "$SIDECAR_PID" 2>/dev/null || break
    sleep 0.1
  done
  if [[ "$ready" != "1" ]]; then
    foreign="$(lsof -nP -iTCP:"$SLAYZONE_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
    if [[ -n "$foreign" ]] && ! port_owner_is_ours; then
      echo "[run] FATAL: port $SLAYZONE_PORT is held by a FOREIGN process (pid=$foreign), not the sidecar we spawned (pid=$SIDECAR_PID)." >&2
      ps -o pid,ppid,command -p "$foreign" >&2 2>/dev/null || true
      echo "[run] The renderer hard-pins ws://localhost:$SLAYZONE_PORT, so it would connect to that process's DB — likely an orphaned sidecar from a prior run or another SlayZone instance." >&2
      echo "[run] Free the port (kill $foreign) or stop the other instance, then retry." >&2
    else
      echo "[run] sidecar failed health check within 8s — see $SIDECAR_LOG" >&2
      cat "$SIDECAR_LOG" >&2 || true
    fi
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

# Opt-in CDP endpoint for local inspection/automation — the dev build binds no
# remote-debugging port by default. Set SLAYZONE_REMOTE_DEBUG=<port>. Env-based
# (not arg passthrough) so it survives `pnpm dev:chromium`/`run:chromium`.
if [[ -n "${SLAYZONE_REMOTE_DEBUG:-}" ]]; then
  EXTRA_ARGS+=("--remote-debugging-port=${SLAYZONE_REMOTE_DEBUG}")
fi

# Opt-in HMR: proxy chrome://slayzone-shell/ to the chromium-shell Vite dev
# server instead of the on-disk bundle. Set SLAYZONE_SHELL_DEV_SERVER to its URL
# — the project-private strict port from chromium-shell/vite.config.ts, i.e.
# http://localhost:51734 (NOT Vite's shared default 5173, which another local
# project can squat and get rendered inside the shell). Env-based so it survives
# `pnpm dev:chromium`/`run:chromium`. When unset, the on-disk shell bundle wins.
if [[ -n "${SLAYZONE_SHELL_DEV_SERVER:-}" ]]; then
  EXTRA_ARGS+=("--slayzone-shell-dev-server=${SLAYZONE_SHELL_DEV_SERVER}")
fi

exec "$APP" "${EXTRA_ARGS[@]}" "$@"

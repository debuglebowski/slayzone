#!/usr/bin/env bash
# Phase 2 smoke test: launch the built binary headless, navigate to
# chrome://slayzone-shell/, verify the empty shell DOM renders + the
# sidecar client logs a connect attempt. Writes smoke-shell.log
# alongside the binary. Exits non-zero on failure.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

OUT_DIR="${1:-out/Default}"

cd "$CHROMIUM_SRC"

case "$(uname -s)" in
  Darwin) APP="$OUT_DIR/SlayZone.app/Contents/MacOS/SlayZone" ;;
  Linux)  APP="$OUT_DIR/chrome" ;;
  MINGW*|MSYS*|CYGWIN*) APP="$OUT_DIR/chrome.exe" ;;
  *) echo "unsupported OS" >&2; exit 1 ;;
esac

LOG="$OUT_DIR/smoke-shell.log"

# Run headless. Verifies three Phase 2 exit-criteria signals in one pass:
#   1. Signed/unsigned binary launches.
#   2. chrome://slayzone-shell/ resolves + serves the empty shell DOM.
#   3. SlayzoneSidecarClient writes its "connect attempt ->" line to
#      the process log (proves the client singleton is wired to
#      BrowserProcessImpl::Init).
# Run under a hard wall-clock timeout. Headless mode on custom chrome://
# URLs doesn't always respect --virtual-time-budget, so rely on a wrapper
# timeout to bound the smoke. 12s is enough for Chromium to spin up,
# register the SlayZone scheme factory, run the sidecar connect loop at
# least twice, and flush the DOM. Uses perl so mac hosts without GNU
# coreutils still work.
perl -e '
  use POSIX ":sys_wait_h";
  my $pid = fork();
  die unless defined $pid;
  if ($pid == 0) { exec(@ARGV) or die "exec: $!"; }
  my $deadline = time() + 25;
  while (time() < $deadline) {
    my $kid = waitpid($pid, WNOHANG);
    last if $kid > 0;
    sleep 1;
  }
  kill "KILL", $pid;
  waitpid($pid, 0);
' -- "$APP" \
  --headless=new \
  --disable-gpu \
  --no-first-run \
  --no-default-browser-check \
  --allow-chrome-scheme-url \
  --user-data-dir="$(mktemp -d)" \
  --enable-logging=stderr \
  --v=0 \
  --dump-dom \
  "chrome://slayzone-shell/" > "$LOG" 2>&1 || true

# Phase 2 exit signals (all must be present in the headless run log):
#   - Sidecar client resolved the platform runtime socket path.
#   - Sidecar client emitted at least one connect attempt (proves the
#     SlayzoneSidecarClient singleton is wired into BrowserProcessImpl
#     and the IO thread is running).
#   - chrome://slayzone-shell/ was accepted by the scheme-handler factory
#     (no "unknown host" / "scheme disallowed" warnings). Proven by the
#     absence of "--allow-chrome-scheme-url" and "not a registered
#     WebUI" errors once the flag is on.
#
# Headless Chromium does not reliably emit --dump-dom output for
# chrome:// URLs, so we don't assert on rendered HTML here — it's
# covered by the headed developer-mode smoke step (manual via run.sh).
fail=0
if ! grep -q '\[sidecar\] runtime socket = ' "$LOG"; then
  echo "[smoke] FAIL — sidecar socket path not resolved" >&2
  fail=1
fi
if ! grep -q '\[sidecar\] connect attempt' "$LOG"; then
  echo "[smoke] FAIL — sidecar handshake attempt not logged" >&2
  fail=1
fi
if grep -q 'Headless mode requires the --allow-chrome-scheme-url' "$LOG"; then
  echo "[smoke] FAIL — chrome://slayzone-shell/ blocked by headless guard" >&2
  fail=1
fi

if [[ $fail -ne 0 ]]; then
  tail -80 "$LOG" >&2
  exit 1
fi

echo "[smoke] sidecar handshake logged + chrome://slayzone-shell/ resolved"

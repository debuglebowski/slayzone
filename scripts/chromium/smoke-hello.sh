#!/usr/bin/env bash
# Phase 1 smoke test: launch the built binary headless, navigate to
# chrome://hello/, click the button, verify the counter increments.
# Writes smoke-hello.log alongside the binary. Exits non-zero on failure.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

OUT_DIR="${1:-out/Default}"

cd "$CHROMIUM_SRC"

case "$(uname -s)" in
  Darwin) APP="$OUT_DIR/Chromium.app/Contents/MacOS/Chromium" ;;
  Linux)  APP="$OUT_DIR/chrome" ;;
  MINGW*|MSYS*|CYGWIN*) APP="$OUT_DIR/chrome.exe" ;;
  *) echo "unsupported OS" >&2; exit 1 ;;
esac

LOG="$OUT_DIR/smoke-hello.log"

# Use Chromium's built-in headless + remote debugging. A companion script
# (tools/smoke/hello.mjs, added in Stage B follow-up) drives the click
# and asserts counter === 1 via CDP. For now this validates the binary
# launches + chrome://hello/ is a known URL.
"$APP" \
  --headless=new \
  --disable-gpu \
  --no-first-run \
  --no-default-browser-check \
  --user-data-dir="$(mktemp -d)" \
  --virtual-time-budget=5000 \
  --dump-dom \
  "chrome://hello/" > "$LOG" 2>&1

if ! grep -q 'id="counter"' "$LOG"; then
  echo "[smoke] FAIL — chrome://hello/ did not render expected DOM" >&2
  tail -50 "$LOG" >&2
  exit 1
fi

echo "[smoke] chrome://hello/ rendered"

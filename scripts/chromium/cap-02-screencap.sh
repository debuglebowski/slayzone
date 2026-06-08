#!/usr/bin/env bash
# Ownership-asserted screenshot of the cap-02 fork window.
#
# Usage: cap-02-screencap.sh <fork_binary_path> <out_png>
#
# Resolves the window that belongs to the given binary path via CoreGraphics
# window list (osascript JXA) and captures ONLY that window. If the binary
# isn't found among visible windows, exits non-zero — never silently falls
# through to a blind front-most capture. Needed because the dogfood host is
# SlayZone too, and screencapture's default would grab the wrong window.

set -euo pipefail

binary_path="${1:?fork binary path required}"
out_png="${2:?out png path required}"

if [[ ! -x "$binary_path" ]]; then
  echo "binary not found or not executable: $binary_path" >&2
  exit 2
fi

# Resolve the PID of the process running that exact binary.
pid="$(pgrep -fx "$binary_path" | head -n 1 || true)"
if [[ -z "$pid" ]]; then
  echo "no running process matches $binary_path" >&2
  exit 3
fi

# Use JXA (JavaScript for Automation) to find the window owned by our PID.
# Returns a window id that `screencapture -l<id>` captures directly.
window_id="$(osascript -l JavaScript <<EOF
  ObjC.import('CoreGraphics')
  ObjC.import('Foundation')
  const options = 0 // kCGWindowListOptionAll
  const windows = ObjC.deepUnwrap(
    \$.CGWindowListCopyWindowInfo(1 /* onScreenOnly */, 0)
  )
  const target = ${pid}
  const match = windows.find(w =>
    w.kCGWindowOwnerPID === target &&
    w.kCGWindowLayer === 0 &&
    typeof w.kCGWindowBounds === 'object' &&
    w.kCGWindowBounds.Height > 100
  )
  if (!match) { throw new Error('no visible window for pid ' + target) }
  match.kCGWindowNumber.toString()
EOF
)"

if [[ -z "$window_id" ]]; then
  echo "no window id resolved for pid $pid" >&2
  exit 4
fi

# Final assertion: window-owner name matches SlayZone.
owner="$(osascript -l JavaScript <<EOF
  ObjC.import('CoreGraphics')
  const windows = ObjC.deepUnwrap(
    \$.CGWindowListCopyWindowInfo(1, 0)
  )
  const w = windows.find(x => x.kCGWindowNumber === ${window_id})
  w ? w.kCGWindowOwnerName : ''
EOF
)"

if [[ "$owner" != "SlayZone" ]]; then
  echo "owner mismatch: expected SlayZone, got '$owner'" >&2
  exit 5
fi

mkdir -p "$(dirname "$out_png")"
screencapture -x -l "$window_id" -t png "$out_png"
echo "captured pid=$pid window=$window_id owner=$owner → $out_png"

#!/usr/bin/env bash
# Build the Chromium fork. Default: release config at out/Default.
#   Usage: build.sh [out-dir] [gn-args-file]
# reclient/RBE integration lands in Stage C; this is local-only.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

# ── Toolchain pin (2026-06-09 lesson — DO NOT build with a drifting toolchain) ─
# The fork's baseline is Xcode 16.x (patches 0006/0007 exist for it; Xcode 26
# needs macOS 15+ and splits the SDK modulemaps, which flips gn's clang-modules
# config and invalidates the entire build). A gn gen under a different
# xcode-select silently poisons the graph → hours-long full rebuild.
# Override deliberately via SLAYZONE_DEVELOPER_DIR when bumping the baseline.
PINNED_XCODE="/Applications/Xcode-16.3.0.app/Contents/Developer"
if [[ -z "${SLAYZONE_DEVELOPER_DIR:-}" && -d "$PINNED_XCODE" ]]; then
  export DEVELOPER_DIR="$PINNED_XCODE"
elif [[ -n "${SLAYZONE_DEVELOPER_DIR:-}" ]]; then
  export DEVELOPER_DIR="$SLAYZONE_DEVELOPER_DIR"
fi

OUT_DIR="${1:-out/Default}"
# Resolve args file against $REPO_ROOT so callers can pass a repo-relative
# path; absolute paths pass through unchanged.
# Default to the platform args file: release.gn alone lacks use_clang_modules=false
# (the Xcode-16.x modulemap guard) — building with it on a mac was the root cause
# of the 2026-06-09 full-rebuild incident.
DEFAULT_ARGS="scripts/chromium/args/release.gn"
if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
  DEFAULT_ARGS="scripts/chromium/args/release-mac-arm64.gn"
fi
ARGS_FILE_IN="${2:-$DEFAULT_ARGS}"
case "$ARGS_FILE_IN" in
  /*) ARGS_FILE="$ARGS_FILE_IN" ;;
  *)  ARGS_FILE="$REPO_ROOT/$ARGS_FILE_IN" ;;
esac

cd "$CHROMIUM_SRC"

mkdir -p "$OUT_DIR"
# Always refresh args.gn from the tracked args file so edits flow through
# on the next build without a manual `gn gen`.
cp "$ARGS_FILE" "$OUT_DIR/args.gn"

# gn gen runs if build.ninja is missing (first build or failed earlier run)
# or stale relative to args.gn. Cheap to re-run; gn compares and no-ops.
if [[ ! -f "$OUT_DIR/build.ninja" ]] || \
   [[ "$OUT_DIR/args.gn" -nt "$OUT_DIR/build.ninja" ]]; then
  gn gen "$OUT_DIR"
fi

autoninja -C "$OUT_DIR" chrome

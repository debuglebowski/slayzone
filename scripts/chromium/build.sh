#!/usr/bin/env bash
# Build the Chromium fork. Default: release config at out/Default.
#   Usage: build.sh [out-dir] [gn-args-file]
# reclient/RBE integration lands in Stage C; this is local-only.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

OUT_DIR="${1:-out/Default}"
# Resolve args file against $REPO_ROOT so callers can pass a repo-relative
# path; absolute paths pass through unchanged.
ARGS_FILE_IN="${2:-scripts/chromium/args/release.gn}"
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

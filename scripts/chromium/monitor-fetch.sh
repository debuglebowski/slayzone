#!/usr/bin/env bash
# Live progress for an in-flight fetch.sh. Safe to run in parallel.
#
# Shows (every 5s):
#   - disk footprint of chromium/src and chromium/.cipd
#   - which git subcommand is active right now
#   - live tail of fetch.log (usually silent — Python/gclient don't flush
#     without a TTY; the process tree is the honest signal)
#
# Ctrl-C to stop watching; the fetch itself keeps running.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

while true; do
  clear
  echo "=== $(date '+%H:%M:%S')  — monitoring chromium fetch ==="
  echo
  echo "-- on-disk --"
  du -sh "$CHROMIUM_DIR/src" "$CHROMIUM_DIR/.cipd" 2>/dev/null | sed 's|'"$REPO_ROOT"'/||'
  echo
  echo "-- active processes --"
  pgrep -fl 'fetch.py|gclient.py|git fetch|git clone|git-remote|git-index-pack|git-fetch-pack|git-cache' \
    2>/dev/null \
    | grep -v monitor-fetch \
    | grep -vE 'Applications|Spark Desktop|Cursor|GitKraken' \
    | awk '{$1=""; print $0}' \
    | sed 's|^ ||' \
    | cut -c1-160 \
    | head -8
  echo
  echo "-- log tail --"
  tail -8 "$REPO_ROOT/logs/chromium/fetch.log" 2>/dev/null || echo "(no log yet)"
  sleep 5
done

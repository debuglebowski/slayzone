#!/usr/bin/env bash
# Server boundary guards:
#  (1) side-car + its transitive deps must never import electron.
#  (2) @slayzone/app must never import @slayzone/server — the side-car is
#      spawned by file path, never bundled into the Electron main process.
set -euo pipefail
fail=0

ELECTRON="from ['\"]electron['\"]|require\(['\"]electron['\"]\)"
for p in packages/apps/server/src packages/shared/transport/src packages/shared/platform/src; do
  hit=$(grep -rnE --include="*.ts" --include="*.tsx" --include="*.mjs" --include="*.js" \
    "$ELECTRON" "$p" 2>/dev/null || true)
  if [ -n "$hit" ]; then
    echo "Side-car must not import electron:"
    echo "$hit"
    fail=1
  fi
done

SERVER_IMPORT="from ['\"]@slayzone/server"
hit=$(grep -rnE --include="*.ts" --include="*.tsx" \
  "$SERVER_IMPORT" packages/apps/app/src 2>/dev/null || true)
if [ -n "$hit" ]; then
  echo "@slayzone/app must not import @slayzone/server (spawn dist/bin.js by path):"
  echo "$hit"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "Server boundary guards passed."
else
  exit 1
fi

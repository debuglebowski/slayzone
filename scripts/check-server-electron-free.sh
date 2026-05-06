#!/bin/bash
# Verify domain server/ code stays Electron-free.
# Phase 1 of server-mode rollout: every packages/domains/<d>/src/server/
# must be runnable from plain Node. Static check on imports.
set -e

violations=$(grep -rn "from 'electron'\|require('electron')\|from \"electron\"" packages/domains/*/src/server/ 2>/dev/null || true)

if [ -n "$violations" ]; then
  echo "FAIL: domain server/ files import electron:" >&2
  echo "$violations" >&2
  exit 1
fi

echo "OK: all domain server/ code is electron-free"

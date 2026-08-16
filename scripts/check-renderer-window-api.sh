#!/usr/bin/env bash
set -euo pipefail

matches="$(
  rg -n \
    --glob '!**/*.test.*' \
    --glob '!**/*.spec.*' \
    --glob '!**/*.d.ts' \
    --glob '!packages/shared/transport/src/client/electron-bootstrap.ts' \
    --glob '!packages/shared/window-api-shim/**' \
    '(window\.api\.|\([^)]*window[^)]*\)\.api\.|\bapi:\s*ElectronAPI\b)' \
    packages/apps/app/src/renderer \
    packages/domains/*/src/client \
    packages/shared/*/src || true
)"

if [[ -n "$matches" ]]; then
  cat >&2 <<'EOF'
renderer/client window.api access is forbidden.
Use tRPC, or add bootstrap-only access to @slayzone/transport/client/electron-bootstrap.

EOF
  printf '%s\n' "$matches" >&2
  exit 1
fi

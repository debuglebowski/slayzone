#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

if command -v rg >/dev/null 2>&1; then
  SEARCH_BIN="rg"
else
  SEARCH_BIN="grep"
fi

require_contains() {
  local file="$1"
  local literal="$2"
  local description="$3"

  if ! "$SEARCH_BIN" -F -q -- "$literal" "$file"; then
    echo "Policy check failed: $description"
    echo "  Missing in $file: $literal"
    exit 1
  fi
}

require_not_contains() {
  local file="$1"
  local literal="$2"
  local description="$3"

  if "$SEARCH_BIN" -F -q -- "$literal" "$file"; then
    echo "Policy check failed: $description"
    echo "  Forbidden in $file: $literal"
    exit 1
  fi
}

require_contains \
  ".github/workflows/release.yml" \
  "uses: ./.github/workflows/release-foundation.yml" \
  "release.yml must call the shared release foundation workflow"

require_contains \
  ".github/workflows/release-pr-dry-run.yml" \
  "uses: ./.github/workflows/release-foundation.yml" \
  "release-pr-dry-run.yml must call the shared release foundation workflow"

require_not_contains \
  ".github/workflows/release.yml" \
  "exec electron-builder" \
  "release.yml must not package directly; packaging belongs in release-foundation.yml"

require_not_contains \
  ".github/workflows/release-pr-dry-run.yml" \
  "exec electron-builder" \
  "release-pr-dry-run.yml must not package directly; packaging belongs in release-foundation.yml"

require_contains \
  ".github/workflows/release-foundation.yml" \
  "generate-release-manifest.mjs" \
  "release-foundation.yml must generate release-manifest.json"

require_contains \
  ".github/workflows/release-foundation.yml" \
  "SHA256SUMS.txt" \
  "release-foundation.yml must produce checksum artifacts"

require_contains \
  ".github/workflows/release-foundation.yml" \
  'Publish (${{ matrix.channel }})' \
  "release-foundation.yml must keep channel publish jobs"

echo "Release workflow policy checks passed."

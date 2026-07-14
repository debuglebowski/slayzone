#!/usr/bin/env bash
set -euo pipefail

LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [ -n "$LAST_TAG" ]; then
  COMMITS=$(git log "$LAST_TAG"..HEAD --oneline | grep -v "^.\{8\} release:" || true)
  if [ -z "$COMMITS" ]; then
    echo "No changes since $LAST_TAG, aborting."
    exit 1
  fi
fi

VERSION=$(node -p "require('./packages/apps/app/package.json').version")

echo "Releasing v$VERSION..."

# Stamp the shared version into every workspace manifest (app is canonical).
node scripts/sync-versions.mjs

# Rebuild changelog cleanly using last tag's changelog as history base
{ echo "# Changelog"; changelogen --hideAuthorEmail --no-fetch 2>/dev/null; git show "$LAST_TAG:CHANGELOG.md" | tail -n +2; } > CHANGELOG.md
git add -A -- '*package.json' CHANGELOG.md
git commit -m "release: v$VERSION"
git tag "v$VERSION"
git push origin main
git push origin "v$VERSION"

echo "Released v$VERSION"

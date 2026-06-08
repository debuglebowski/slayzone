#!/usr/bin/env bash
# Sync chromium/src/ to the pinned version + run DEPS hooks.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

cd "$CHROMIUM_SRC"
git fetch --tags --depth 1 origin "refs/tags/$CHROMIUM_VERSION:refs/tags/$CHROMIUM_VERSION" || true
git checkout -f "tags/$CHROMIUM_VERSION"

cd "$CHROMIUM_DIR"
gclient sync --with_branch_heads --with_tags -D

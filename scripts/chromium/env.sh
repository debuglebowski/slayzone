#!/usr/bin/env bash
# Sourced by every chromium/*.sh script. Sets up depot_tools + paths.
# Idempotent: safe to source multiple times.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

export REPO_ROOT
export DEPOT_TOOLS_DIR="$REPO_ROOT/tools/depot_tools"
export CHROMIUM_DIR="$REPO_ROOT/chromium"
export CHROMIUM_SRC="$CHROMIUM_DIR/src"
export CHROMIUM_VERSION="$(cat "$CHROMIUM_DIR/CHROMIUM_VERSION")"
export PATCHES_DIR="$REPO_ROOT/patches/chromium"

# Persistent git-cache mirror. gclient + depot_tools both honor GIT_CACHE_PATH.
# Crucial for resilience: a `git clone` into src/ becomes a local hardlink
# op from this cache, so interrupted downloads resume from the cache's last
# good state instead of starting over from the remote.
export GIT_CACHE_PATH="$CHROMIUM_DIR/.git_cache"
mkdir -p "$GIT_CACHE_PATH"

if [[ ! -d "$DEPOT_TOOLS_DIR" ]]; then
  echo "depot_tools missing at $DEPOT_TOOLS_DIR" >&2
  echo "Run: git clone --depth 1 https://chromium.googlesource.com/chromium/tools/depot_tools.git \"$DEPOT_TOOLS_DIR\"" >&2
  exit 1
fi

case ":$PATH:" in
  *":$DEPOT_TOOLS_DIR:"*) ;;
  *) export PATH="$DEPOT_TOOLS_DIR:$PATH" ;;
esac

# depot_tools self-update is disabled; we pin by pulling depot_tools manually.
export DEPOT_TOOLS_UPDATE=0
# Google internal metrics collection off.
export DEPOT_TOOLS_METRICS=0

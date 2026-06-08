#!/usr/bin/env bash
# Fetch Chromium source at the pinned version. Idempotent + resumable.
#
# Two phases — the cache phase is the resilience win:
#
#   1. Populate $GIT_CACHE_PATH via depot_tools' `git_cache`. This is a
#      persistent bare-mirror fetch. If interrupted mid-download, the
#      next run resumes from wherever the partial pack left off instead
#      of starting over — the thing plain `git clone` cannot do.
#
#   2. Run `gclient sync`. With GIT_CACHE_PATH set, gclient's internal
#      `git clone` becomes a local hardlink operation from the cache,
#      so this is fast + idempotent from here on.
#
# Disk: ~50 GB in $GIT_CACHE_PATH + ~30 GB in chromium/src/ (hardlinked).

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

cd "$CHROMIUM_DIR"

# Phase 1 — populate the git cache. git_cache populate is designed to be
# interrupted and resumed: re-running picks up from the partial pack file
# it already wrote rather than redownloading.
echo "[fetch] phase 1/2 — populating git cache at $GIT_CACHE_PATH"
"$DEPOT_TOOLS_DIR/git_cache.py" populate \
  --cache-dir "$GIT_CACHE_PATH" \
  --verbose \
  https://chromium.googlesource.com/chromium/src.git

# If a previous `fetch` attempt left a `.gclient` + half-populated
# `_gclient_src_*/` dir behind, scrub it. The cache is the source of truth
# now; the temp dirs carry no resumable state gclient will reuse, and
# they can confuse gclient's next sync.
for stale in _gclient_src_*; do
  [[ -d "$stale" ]] || continue
  echo "[fetch] removing stale temp checkout: $stale"
  rm -rf "$stale"
done

# Ensure .gclient exists. If not, run `fetch` once to create it (this is now
# cheap: `fetch` will use the populated cache under the hood, so the initial
# clone is a local hardlink op, not a 50 GB redownload).
if [[ ! -f .gclient ]]; then
  echo "[fetch] no .gclient — running fetch --nohooks chromium (uses cache)"
  fetch --nohooks chromium
fi

# Phase 2 — gclient sync. Fast now that the cache is primed.
echo "[fetch] phase 2/2 — gclient sync (initial, creates src/ from cache)"
gclient sync --with_branch_heads --with_tags -D

cd "$CHROMIUM_SRC"
echo "[fetch] pinning to $CHROMIUM_VERSION ..."
git fetch --tags origin "refs/tags/$CHROMIUM_VERSION:refs/tags/$CHROMIUM_VERSION" || true
git checkout -f "tags/$CHROMIUM_VERSION"

cd "$CHROMIUM_DIR"
echo "[fetch] gclient sync (aligning DEPS to $CHROMIUM_VERSION)"
gclient sync --with_branch_heads --with_tags -D

echo "[fetch] done."

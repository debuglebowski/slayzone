#!/usr/bin/env bash
# Apply every patches/chromium/*.patch to chromium/src/ in lexicographic order.
# Uses `git am` so authorship + message are preserved.
#
# Idempotency notes:
# - Each patch N's "reverse-apply cleanly" test can fail even when patch N is
#   already applied, because later patches (N+1..) routinely edit the same
#   files and change the context lines that `git apply --reverse` anchors on.
# - Subject matching breaks on patches whose Subject header uses RFC 2047
#   encoded-word (=?UTF-8?q?...?=) because the header's decoded form differs
#   from the commit subject at HEAD.
# - Commit-hash matching (From: <hash>) breaks when patches are re-exported
#   via `format-patch --amend` — the patch file holds a hash that no longer
#   exists in HEAD's history.
#
# Until the merge bot (C1) lands a proper sequenced 3-way rebase pipeline,
# the simplest robust story is: do the cheap subject check first, then let
# `git am --3way` deal with already-applied patches — it no-ops cleanly when
# the content in the tree already matches what the patch wants, only
# surfacing a conflict when real divergence exists.

source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

shopt -s nullglob
PATCH_FILES=("$PATCHES_DIR"/*.patch)
if [[ ${#PATCH_FILES[@]} -eq 0 ]]; then
  echo "[patches] no patches to apply"
  exit 0
fi

cd "$CHROMIUM_SRC"

for patch in "${PATCH_FILES[@]}"; do
  # Subject-based fast skip. Unfolds RFC 2822 continuation lines and strips
  # the leading `[<prefix> N/M]` bracket group (authored with
  # --subject-prefix=slayzone; default is PATCH — match either).
  subject=$(awk '
    /^Subject: / { line = substr($0, 10); in_subj = 1; next }
    in_subj && /^[ \t]/ {
      sub(/^[ \t]+/, " ")
      line = line $0
      next
    }
    in_subj { sub(/^\[[^]]*\] */, "", line); print line; exit }
  ' "$patch")
  if [[ -n "$subject" ]] && \
     git log --format='%s' "tags/$CHROMIUM_VERSION..HEAD" 2>/dev/null \
       | grep -Fxq "$subject"; then
    echo "[patches] skip $(basename "$patch") (already applied)"
    continue
  fi
  echo "[patches] apply $(basename "$patch")"
  git am --3way "$patch"
done

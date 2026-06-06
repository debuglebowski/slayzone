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

# (3) Renderer / client code must not import the legacy conversation-id helpers.
#     They read the mutable provider_config field directly, bypassing the
#     append-only task_conversations ledger + provenance gate. The renderer
#     should consume the computed `currentConversationByMode` field on the
#     task object instead. (Phase 3 of conversation-id-robustness plan; Phase 4
#     deletes the helpers entirely.)
LEGACY_HELPERS="from ['\"]@slayzone/task/shared['\"]|from ['\"]@slayzone/task['\"]"
LEGACY_NAMES="getProviderConversationId|setProviderConversationId|appendProviderConversationId|chatConversationId"
client_hits=""
for p in packages/domains/*/src/client packages/apps/app/src/renderer packages/apps/website/src; do
  [ -d "$p" ] || continue
  # Two greps: first find files that import from the task barrels, then
  # check those files for the legacy symbols. Cheap + lint-clean.
  files=$(grep -rlE --include="*.ts" --include="*.tsx" "$LEGACY_HELPERS" "$p" 2>/dev/null || true)
  for f in $files; do
    hit=$(grep -nE "$LEGACY_NAMES" "$f" 2>/dev/null || true)
    if [ -n "$hit" ]; then
      client_hits+="${f}:${hit}"$'\n'
    fi
  done
done
if [ -n "$client_hits" ]; then
  echo "Renderer/client must not read the legacy provider_config conversation id."
  echo "Use task.currentConversationByMode[mode] instead."
  echo "$client_hits"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "Server boundary guards passed."
else
  exit 1
fi

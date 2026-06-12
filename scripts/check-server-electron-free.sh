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

# Domain server/ entries must stay Electron-free (slice 4 split). Each
# packages/domains/<d>/src/server/ is the pure-Node half that @slayzone/server
# bundles; an electron import there breaks the headless build. electron/ glue
# is exempt — only server/ is guarded.
for d in packages/domains/*/src/server; do
  [ -d "$d" ] || continue
  hit=$(grep -rnE --include="*.ts" --include="*.tsx" --include="*.mjs" --include="*.js" \
    "$ELECTRON" "$d" 2>/dev/null || true)
  if [ -n "$hit" ]; then
    echo "Domain server/ must not import electron ($d):"
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

# (2b) Server-side code must not STATICALLY value-import a domain's /electron
#      entry — it drags the whole electron-coupled cluster (pty-manager, …)
#      into the standalone bundle, which then crashes on the `electron` npm
#      shim at module load (this exact bug shipped via integrations/sync.ts).
#      `import type` (erased) and dynamic `import('…')` (lazy + caught) are
#      allowed, so strip both before searching — perl handles the multiline
#      type-import form a line-based grep can't.
for p in packages/apps/server/src packages/shared/transport/src packages/domains/*/src/server; do
  [ -d "$p" ] || continue
  hit=$(find "$p" -name "*.ts" -not -name "*.test.ts" -print0 2>/dev/null | xargs -0 perl -0777 -ne '
    my $src = $_;
    $src =~ s/import\s+type\s+\{[^}]*\}\s+from\s+'\''[^'\'']*'\''//gs;   # multiline type imports
    $src =~ s/import\s*\(\s*'\''[^'\'']*'\''\s*\)//gs;                    # dynamic imports
    while ($src =~ /from\s+'\''(\@slayzone\/[a-z0-9-]+\/electron)'\''/g) {
      print "$ARGV: static value import of $1\n";
    }
  ' 2>/dev/null || true)
  if [ -n "$hit" ]; then
    echo "Server-side code must not statically import a domain /electron entry ($p):"
    echo "$hit"
    fail=1
  fi
done

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

# (4) Task ops that feed the renderer's task store MUST hydrate the conversation
#     ledger field (currentConversationByMode) via parseAndColorTask(s) — never
#     bare parseTask(s). A bare parse ships tasks with no conversation id, so on
#     boot every auto-respawned terminal reads null and mints a FRESH session
#     that durably shadows the real conversation (the restart-clobber regression).
#     The 4 get-ops already comply; this keeps load-board-data + any future list
#     op honest.
BOARD_OPS="packages/domains/task/src/main/ops/load-board-data.ts \
  packages/domains/task/src/main/ops/get-all.ts \
  packages/domains/task/src/main/ops/get-by-project.ts \
  packages/domains/task/src/main/ops/get-subtasks.ts \
  packages/domains/task/src/main/ops/get.ts"
for f in $BOARD_OPS; do
  [ -f "$f" ] || continue
  if ! grep -q "parseAndColorTask" "$f"; then
    echo "Task op feeds the renderer store but does not hydrate currentConversationByMode:"
    echo "  $f — use parseAndColorTask(s) (see attachCurrentConversationByMode), not bare parseTask(s)."
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "Server boundary guards passed."
else
  exit 1
fi

#!/usr/bin/env bash
# Server boundary guards:
#  (1) side-car + its transitive deps must never import electron.
#  (2) @slayzone/app must never import @slayzone/hub — the side-car is
#      spawned by file path, never bundled into the Electron main process.
set -euo pipefail
fail=0

ELECTRON="from ['\"]electron['\"]|require\(['\"]electron['\"]\)"
# `*.test.ts` is exempt (same carve-out as (2b) below): tests are never bundled
# into the side-car, and some MUST resolve the electron binary path to spawn the
# built bins under Electron's node ABI (install-handshake.test.ts).
for p in packages/apps/hub/src packages/shared/transport/src packages/shared/platform/src; do
  hit=$(grep -rnE --include="*.ts" --include="*.tsx" --include="*.mjs" --include="*.js" \
    --exclude="*.test.ts" --exclude="*.test.tsx" \
    "$ELECTRON" "$p" 2>/dev/null || true)
  if [ -n "$hit" ]; then
    echo "Side-car must not import electron:"
    echo "$hit"
    fail=1
  fi
done

# Domain server/ entries must stay Electron-free (slice 4 split). Each
# packages/domains/<d>/src/server/ is the pure-Node half that @slayzone/hub
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

SERVER_IMPORT="from ['\"]@slayzone/hub"
hit=$(grep -rnE --include="*.ts" --include="*.tsx" \
  "$SERVER_IMPORT" packages/apps/app/src 2>/dev/null || true)
if [ -n "$hit" ]; then
  echo "@slayzone/app must not import @slayzone/hub (spawn dist/bin.js by path):"
  echo "$hit"
  fail=1
fi

# (2b) Server-side code must not value-import a domain's /electron entry — it
#      drags the whole electron-coupled cluster (pty-manager, …) into the
#      standalone bundle, which then crashes on the `electron` npm shim at
#      module load (this exact bug shipped via integrations/sync.ts).
#
#      Dynamic `import('…')` used to be exempt here on the theory that lazy +
#      caught was safe. It is not, and the exemption shipped the bug a second
#      time: artifacts.ts reached the download module that way, the module
#      bundled fine so the "absent" branch never fired, and esbuild's __esm
#      helper zeroes its init thunk *before* running the body — so the throw was
#      swallowed once and every later call got a live module object with
#      undefined bindings. Silent no-op, then a TypeError from deep inside
#      business logic. Route host-only work through AppDeps instead: it is
#      compile-enforced at every wiring site.
#
#      `import type` stays exempt (fully erased). Strip it before searching —
#      perl handles the multiline form a line-based grep can't.
for p in packages/apps/hub/src packages/shared/transport/src packages/domains/*/src/server; do
  [ -d "$p" ] || continue
  hit=$(find "$p" -name "*.ts" -not -name "*.test.ts" -print0 2>/dev/null | xargs -0 perl -0777 -ne '
    my $src = $_;
    $src =~ s/import\s+type\s+\{[^}]*\}\s+from\s+'\''[^'\'']*'\''//gs;   # multiline type imports
    while ($src =~ /from\s+'\''(\@slayzone\/[a-z0-9-]+\/electron[^'\'']*)'\''/g) {
      print "$ARGV: value import of $1\n";
    }
    while ($src =~ /import\s*\(\s*'\''(\@slayzone\/[a-z0-9-]+\/electron[^'\'']*)'\''\s*\)/g) {
      print "$ARGV: dynamic import of $1\n";
    }
  ' 2>/dev/null || true)
  if [ -n "$hit" ]; then
    echo "Server-side code must not import a domain /electron entry ($p) — use AppDeps:"
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

# (5) The `slay` CLI must reach every piece of DOMAIN state over the hub's REST
#     surface — never by opening the SQLite file, and never by deriving the app's
#     on-disk layout. Those two are one guard because they were one bug: the CLI
#     read `settings.server_port` from the database purely to find the app, which
#     forced it to know where storage lives, which broke every command from a plain
#     shell the moment supervised state moved to ~/.slayzone/<channel>/<role>. It
#     now probes a fixed port instead, so neither dependency has any remaining
#     caller — and a reintroduced one would fail silently on a hub-only box (no DB
#     file at all) rather than loudly here.
#
#     `cli-state.ts` is the deliberate carve-out: it owns the CLI's MACHINE-local
#     files (the hub pointer, the service install prefix), which are legitimately
#     on disk. It anchors on $HOME directly and never consults SLAYZONE_ROOT.
CLI_SRC="packages/apps/cli/src"
if [ -d "$CLI_SRC" ]; then
  hit=$(grep -rnE --include="*.ts" --include="*.mts" --exclude="*.test.ts" \
    "from ['\"]node:sqlite['\"]|require\(['\"]node:sqlite['\"]\)" "$CLI_SRC" 2>/dev/null || true)
  if [ -n "$hit" ]; then
    echo "The slay CLI must not open a database — route it through the hub's REST surface:"
    echo "$hit"
    fail=1
  fi

  # Layout derivation. getStorageDir/getSlayzoneHomeDir/getSupervisedRoot all
  # resolve SLAYZONE_ROOT; any of them in the CLI means it is guessing at the
  # app's on-disk layout again.
  hit=$(grep -rnE --include="*.ts" --include="*.mts" --exclude="*.test.ts" \
    --exclude="cli-state.ts" \
    "getStorageDir|getSlayzoneHomeDir|getSupervisedRoot" "$CLI_SRC" 2>/dev/null || true)
  if [ -n "$hit" ]; then
    echo "The slay CLI must not derive the app's storage layout (only cli-state.ts owns paths):"
    echo "$hit"
    fail=1
  fi
fi

if [ "$fail" -eq 0 ]; then
  echo "Server boundary guards passed."
else
  exit 1
fi

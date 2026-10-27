#!/usr/bin/env bash
# Server boundary guards:
#  (1) side-car + its transitive deps must never import electron.
#  (2) @slayzone/app must never import @slayzone/hub — the side-car is
#      spawned by file path, never bundled into the Electron main process.
#
# Every outcome other than a clean "no match" fails: a match is a violation, and a
# search that could not run (unreadable path, bad pattern, a missing search root,
# a perl pass that could not read a file) is an error, never a pass. grep's exit
# status says which: 0 = matches, 1 = none, anything else = the search failed.
set -euo pipefail

cd "$(dirname "$0")/.."

fail_error() {
  echo "check-server-electron-free: $1 — cannot verify, failing." >&2
  exit 2
}

# A search root must exist: a moved directory would otherwise just match nothing.
require_dir() {
  [ -d "$1" ] || fail_error "search root $1 does not exist (moved? repoint it)"
}

# `glob_dirs <glob>` leaves the directories the glob matched in $dirs; at least one
# must exist, for the same reason (an unmatched glob stays literal and fails here).
glob_dirs() {
  local d
  dirs=()
  for d in "$@"; do
    [ -d "$d" ] && dirs+=("$d")
  done
  [ "${#dirs[@]}" -gt 0 ] || fail_error "no $* directories (moved? repoint it)"
}

# `grep_hits ARGS...` runs grep and leaves its matches in $hit (empty = none).
grep_hits() {
  local status=0
  hit=$(grep "$@") || status=$?
  case "$status" in
    0 | 1) ;;
    *) fail_error "grep failed (exit $status) searching ${*: -1}" ;;
  esac
}

fail=0

ELECTRON="from ['\"]electron['\"]|require\(['\"]electron['\"]\)"
# `*.test.ts` is exempt (same carve-out as (2b) below): tests are never bundled
# into the side-car, and some MUST resolve the electron binary path to spawn the
# built bins under Electron's node ABI (install-handshake.test.ts).
for p in packages/apps/hub/src packages/shared/transport/src packages/shared/platform/src; do
  require_dir "$p"
  grep_hits -rnE --include="*.ts" --include="*.tsx" --include="*.mjs" --include="*.js" \
    --exclude="*.test.ts" --exclude="*.test.tsx" \
    "$ELECTRON" "$p"
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
glob_dirs packages/domains/*/src/server
for d in "${dirs[@]}"; do
  grep_hits -rnE --include="*.ts" --include="*.tsx" --include="*.mjs" --include="*.js" \
    "$ELECTRON" "$d"
  if [ -n "$hit" ]; then
    echo "Domain server/ must not import electron ($d):"
    echo "$hit"
    fail=1
  fi
done

SERVER_IMPORT="from ['\"]@slayzone/hub"
require_dir packages/apps/app/src
grep_hits -rnE --include="*.ts" --include="*.tsx" \
  "$SERVER_IMPORT" packages/apps/app/src
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
#      perl handles the multiline form a line-based grep can't. A file perl cannot
#      open is fatal (`-Mwarnings=FATAL,inplace`; by default perl warns, skips it
#      and exits 0), so with pipefail any find/perl failure fails the guard.
glob_dirs packages/domains/*/src/server
for p in packages/apps/hub/src packages/shared/transport/src "${dirs[@]}"; do
  require_dir "$p"
  # shellcheck disable=SC2016 # single-quoted perl source: its $vars are perl's
  hit=$(find "$p" -name "*.ts" -not -name "*.test.ts" -print0 | xargs -0 perl -Mwarnings=FATAL,inplace -0777 -ne '
    my $src = $_;
    $src =~ s/import\s+type\s+\{[^}]*\}\s+from\s+'\''[^'\'']*'\''//gs;   # multiline type imports
    while ($src =~ /from\s+'\''(\@slayzone\/[a-z0-9-]+\/electron[^'\'']*)'\''/g) {
      print "$ARGV: value import of $1\n";
    }
    while ($src =~ /import\s*\(\s*'\''(\@slayzone\/[a-z0-9-]+\/electron[^'\'']*)'\''\s*\)/g) {
      print "$ARGV: dynamic import of $1\n";
    }
  ') || fail_error "the /electron-entry scan of $p failed"
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
glob_dirs packages/domains/*/src/client
for p in "${dirs[@]}" packages/apps/app/src/renderer website/src; do
  require_dir "$p"
  # Two greps: first find files that import from the task barrels, then
  # check those files for the legacy symbols. Cheap + lint-clean.
  grep_hits -rlE --include="*.ts" --include="*.tsx" "$LEGACY_HELPERS" "$p"
  files=$hit
  for f in $files; do
    grep_hits -nE "$LEGACY_NAMES" "$f"
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
BOARD_OPS="packages/domains/task/src/server/ops/load-board-data.ts \
  packages/domains/task/src/server/ops/get-all.ts \
  packages/domains/task/src/server/ops/get-by-project.ts \
  packages/domains/task/src/server/ops/get-subtasks.ts \
  packages/domains/task/src/server/ops/get.ts"
for f in $BOARD_OPS; do
  # A moved file must fail the guard, not pass it: skipping silently is how this
  # check went on running against src/main/ops/ long after the ops moved away.
  if [ ! -f "$f" ]; then
    echo "Board-op guard points at a file that does not exist: $f — repoint BOARD_OPS."
    fail=1
    continue
  fi
  status=0
  grep -q "parseAndColorTask" "$f" || status=$?
  [ "$status" -le 1 ] || fail_error "grep failed (exit $status) reading $f"
  if [ "$status" -eq 1 ]; then
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
require_dir "$CLI_SRC"
grep_hits -rnE --include="*.ts" --include="*.mts" --exclude="*.test.ts" \
  "from ['\"]node:sqlite['\"]|require\(['\"]node:sqlite['\"]\)" "$CLI_SRC"
if [ -n "$hit" ]; then
  echo "The slay CLI must not open a database — route it through the hub's REST surface:"
  echo "$hit"
  fail=1
fi

# Layout derivation. getStorageDir/getSlayzoneHomeDir/getSupervisedRoot all
# resolve SLAYZONE_ROOT; any of them in the CLI means it is guessing at the
# app's on-disk layout again.
grep_hits -rnE --include="*.ts" --include="*.mts" --exclude="*.test.ts" \
  --exclude="cli-state.ts" \
  "getStorageDir|getSlayzoneHomeDir|getSupervisedRoot" "$CLI_SRC"
if [ -n "$hit" ]; then
  echo "The slay CLI must not derive the app's storage layout (only cli-state.ts owns paths):"
  echo "$hit"
  fail=1
fi

# (6) The Electron main process must not open the SHARED database. The hub owns
#     the schema in every mode (supervised included), so a second connection in
#     main is what forced `openServerDatabase({ bootstrapSchema: !supervised })`
#     — one file, two writers, one of them told not to touch the schema. A
#     reintroduced connection would not fail loudly; it would silently re-create
#     that split, and in remote mode it would migrate a local copy of a schema
#     whose data lives on the server.
#
#     `import type` stays exempt (fully erased) — the txn registries legitimately
#     type their worker-side `db` param as better-sqlite3's `Database`. Stripped
#     with the same perl approach as (2b): a line-based grep can't see the
#     multiline form.
#
#     CARVE-OUTS (each names the phase that removes it):
#       client-settings-migration.ts — the LAST read of the shared DB from main:
#                           read-only, one statement, one-shot, sentinel-gated.
#                           Removed when the migration itself is retired (once
#                           every supported upgrade path has run it).
#       db/diag-worker.ts — PERMANENT. The diagnostics DB is a separate,
#                           machine-local file, and main must record boot/crash/
#                           lock events when NO hub exists (remote mode, or
#                           precisely when the sidecar failed).
#     `*.test.ts` is exempt only while the migration tests still live under
#     main/db/; P5 relocates them to transport/src/db-bootstrap/.
MAIN_SRC="packages/apps/app/src/main"
require_dir "$MAIN_SRC"
# shellcheck disable=SC2016 # single-quoted perl source: its $vars are perl's
hit=$(find "$MAIN_SRC" -name "*.ts" -not -name "*.test.ts" \
    ! -path "*/db/diag-worker.ts" \
    ! -path "*/client-settings-migration.ts" -print0 \
  | xargs -0 perl -Mwarnings=FATAL,inplace -0777 -ne '
    my $src = $_;
    $src =~ s/import\s+type\s+\{[^}]*\}\s+from\s+'\''[^'\'']*'\''//gs;  # import type { X } from
    $src =~ s/import\s+type\s+\w+\s+from\s+'\''[^'\'']*'\''//gs;        # import type X from
    while ($src =~ /from\s+'\''(better-sqlite3|node:sqlite)'\''/g) {
      print "$ARGV: value import of $1\n";
    }
    while ($src =~ /require\s*\(\s*'\''(better-sqlite3|node:sqlite)'\''\s*\)/g) {
      print "$ARGV: require of $1\n";
    }
  ') || fail_error "the shared-database scan of $MAIN_SRC failed"
if [ -n "$hit" ]; then
  echo "Electron main must not open the shared database — the hub owns it in every mode:"
  echo "$hit"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "Server boundary guards passed."
else
  exit 1
fi

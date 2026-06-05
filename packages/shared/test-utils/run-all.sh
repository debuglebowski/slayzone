#!/bin/bash
# Run all IPC handler contract tests
# Usage: bash packages/shared/test-utils/run-all.sh

set -e
LOADER="--loader ./packages/shared/test-utils/loader.ts"
TSX="npx tsx"
PASS=0
FAIL=0

run_test() {
  echo ""
  echo "=== $1 ==="
  if ( set -o pipefail; $TSX $LOADER "$1" 2>&1 | grep -v 'npm warn\|Migration\|ExperimentalWarning\|--trace-warnings\|--import' ); then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
}

# Strict + custom loader. pipefail makes a real non-zero test exit propagate
# through the grep filter, so a failure counts as FAIL (the lenient run_test
# above counts PASS as long as any output prints). Uses Electron's node so
# better-sqlite3's native ABI matches. Prefer this for new tests.
run_test_electron_strict_loader() {
  echo ""
  echo "=== $1 (electron+loader, strict) ==="
  if ( set -o pipefail; ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm $LOADER "$1" 2>&1 | grep -v 'npm warn\|Migration\|ExperimentalWarning\|--trace-warnings\|--import' ); then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
}

run_test packages/domains/settings/src/main/handlers.test.ts
run_test packages/domains/tags/src/main/handlers.test.ts
run_test packages/domains/projects/src/main/handlers.test.ts
run_test packages/domains/projects/src/main/task-automation.test.ts
# Project-group ordering — pure named txns (shared top-level sort_order space).
# Strict+electron: better-sqlite3 native ABI matches Electron's node only.
run_test_electron_strict_loader packages/domains/projects/src/main/project-groups-txns.test.ts
run_test_electron_strict_loader packages/domains/task/src/main/ops/conversation-id-heal.test.ts
run_test packages/domains/task-terminals/src/main/handlers.test.ts
run_test packages/domains/task/src/shared/revive-decision.test.ts
run_test packages/domains/task/src/shared/provider-config-history.test.ts
run_test packages/domains/task/src/shared/conversation-heal.test.ts
run_test packages/domains/task/src/main/handlers.test.ts
run_test packages/domains/task/src/main/template-handlers.test.ts
run_test packages/domains/task/src/client/card-water-fill.test.ts
run_test packages/apps/app/src/renderer/src/components/sidebar/views/projectGrouping.test.ts
run_test packages/apps/app/src/renderer/src/components/sidebar/views/projectDrop.test.ts
run_test packages/domains/ai-config/src/main/handlers.items.test.ts
run_test packages/domains/ai-config/src/main/handlers.selections.test.ts
run_test packages/domains/ai-config/src/main/handlers.context.test.ts
run_test packages/domains/file-editor/src/main/handlers.test.ts
run_test packages/domains/diagnostics/src/main/service.test.ts
run_test packages/domains/integrations/src/main/handlers.db.test.ts
run_test packages/domains/worktrees/src/main/handlers.test.ts
# agent-turns suite runs strict: async-DB rot fixed (awaits added; snapshotWorktree
# return adapted to {snapshotSha,headSha}). NOTE: all run_test* helpers are now strict
# (pipefail), so the ~30 still-broken domain suites no longer mask as PASS — they now
# count as FAIL. Two known buckets remain, tracked as a separate per-domain-fix task:
#   1. better-sqlite3 ERR_DLOPEN — DB-handler tests on plain-node `run_test` need the
#      Electron runner (some also need async-DB await fixes once they load).
#   2. rest-api/tasks/* + mcp-tools/* — real assertion failures (async-DB move fallout).
run_test_electron_strict_loader packages/domains/agent-turns/src/main/db.test.ts
run_test_electron_strict_loader packages/domains/agent-turns/src/main/git-snapshot.test.ts
run_test_electron_strict_loader packages/domains/agent-turns/src/main/turn-tracker.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/agent-turns.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/chat.test.ts
run_test packages/domains/integrations/src/main/handlers.api.test.ts
run_test packages/domains/integrations/src/main/handlers.analyze.test.ts
run_test packages/domains/automations/src/shared/templates.test.ts
run_test packages/domains/automations/src/shared/types.test.ts
run_test packages/domains/automations/src/shared/ai.test.ts
run_test_electron_strict_loader packages/domains/automations/src/main/handlers.test.ts
run_test_electron_strict_loader packages/domains/automations/src/main/engine.test.ts

# Terminal — SGR stripping + WebGL renderer lifecycle
run_test packages/domains/terminal/src/main/filter-buffer-data.test.ts
run_test packages/domains/terminal/src/client/webgl-loader.test.ts

# Terminal — state machine + hook-driven input-flip gate (stuck-running-after-/status)
run_test packages/domains/terminal/src/main/state-machine.test.ts
run_test packages/domains/terminal/src/main/session-error-gate.test.ts
run_test packages/domains/terminal/src/main/claude-transcripts.test.ts
run_test packages/domains/terminal/src/main/adapters/claude-adapter.test.ts
run_test packages/domains/terminal/src/main/adapters/antigravity-adapter.test.ts
run_test packages/domains/terminal/src/main/adapters/hook-driven-modes.test.ts

# Terminal — Codex Chat (codex-chat mode) driver + transport + adapter
run_test packages/domains/terminal/src/main/agents/codex/codex-app-server-client.test.ts
run_test packages/domains/terminal/src/main/agents/codex/codex-chat-session.test.ts
run_test packages/domains/terminal/src/main/adapters/codex-adapter.test.ts

# Terminal — chat transport manager (session lifecycle + liveness watchdog)
run_test packages/domains/terminal/src/main/chat-transport-manager.test.ts

# Terminal — warm-process pool (per-project gate + adopt-match). Strict+electron:
# pty-manager pulls in `electron`; a fake spawnShell is injected so no real shells spawn.
run_test_electron_strict_loader packages/domains/terminal/src/main/warm-process-manager.test.ts
# Terminal — createPty warm-shell adoption branch (fake pty/win/db, no real spawn).
run_test_electron_strict_loader packages/domains/terminal/src/main/adopt-pty.test.ts

run_test_no_loader() {
  echo ""
  echo "=== $1 (integration) ==="
  if ( set -o pipefail; ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm "$1" 2>&1 | grep -v 'npm warn\|Migration\|ExperimentalWarning\|--trace-warnings\|--import' ); then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
}

run_test_electron_loader() {
  echo ""
  echo "=== $1 (electron+loader) ==="
  if ( set -o pipefail; ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm $LOADER "$1" 2>&1 | grep -v 'npm warn\|Migration\|ExperimentalWarning\|--trace-warnings\|--import' ); then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
}

# Strict: pipefail makes a non-zero test exit code propagate through the grep
# filter, so a real failure counts as FAIL (the lenient runners above count
# PASS as long as any output is produced).
run_test_electron_strict() {
  echo ""
  echo "=== $1 (electron, strict) ==="
  if ( set -o pipefail; ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm "$1" 2>&1 | grep -v 'npm warn\|Migration\|ExperimentalWarning\|--trace-warnings\|--import' ); then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
}

# Side-car supervisor crash-recovery (slice 2.5.1 HARD GATE).
run_test_electron_strict packages/apps/app/src/main/sidecar-server-supervisor.test.ts

# Wave 5 — taskEvents bus + REST routes + MCP tools + CLI integration
run_test_electron_loader packages/domains/task/src/main/events.test.ts
run_test_electron_loader packages/apps/app/src/main/rest-api/tasks/archive.test.ts
run_test_electron_loader packages/apps/app/src/main/rest-api/tasks/archive-many.test.ts
run_test_electron_loader packages/apps/app/src/main/rest-api/tasks/create.test.ts
run_test_electron_loader packages/apps/app/src/main/rest-api/tasks/delete.test.ts
run_test_electron_loader packages/apps/app/src/main/rest-api/tasks/unarchive.test.ts
run_test_electron_loader packages/apps/app/src/main/rest-api/tasks/update.test.ts
run_test_electron_loader packages/apps/app/src/main/rest-api/agent-hook-attention.test.ts
run_test_electron_loader packages/apps/app/src/main/mcp-tools/archive-task.test.ts
run_test_electron_loader packages/apps/app/src/main/mcp-tools/archive-many-task.test.ts
run_test_electron_loader packages/apps/app/src/main/mcp-tools/create-task.test.ts
run_test_electron_loader packages/apps/app/src/main/mcp-tools/delete-task.test.ts
run_test_electron_loader packages/apps/app/src/main/mcp-tools/unarchive-task.test.ts
run_test_electron_loader packages/apps/app/src/main/mcp-tools/update-task.test.ts
run_test_electron_loader packages/apps/cli/test/tasks-rest.test.ts

# CLI command tests (need Electron Node for better-sqlite3 + ESM interop).
# Use the loader so @dagrejs/dagre (pulled transitively via the ai-config barrel)
# is mocked — the real ESM build trips Node's require(esm)-in-cycle guard.
run_test_electron_loader packages/apps/cli/test/db.test.ts
run_test_electron_loader packages/apps/cli/test/tags.test.ts
run_test_electron_loader packages/apps/cli/test/templates.test.ts
run_test_electron_loader packages/apps/cli/test/automations.test.ts
run_test_electron_loader packages/apps/cli/test/tasks-ext.test.ts
run_test_electron_loader packages/apps/cli/test/projects-update.test.ts

if [ -n "$LINEAR_API_KEY" ]; then
  run_test_no_loader packages/domains/integrations/src/main/handlers.integration.linear.test.ts
fi
if [ -n "$GITHUB_TOKEN" ]; then
  run_test_no_loader packages/domains/integrations/src/main/handlers.integration.github.test.ts
fi

echo ""
echo "=== Summary ==="
echo "Suites: $PASS passed, $FAIL failed"

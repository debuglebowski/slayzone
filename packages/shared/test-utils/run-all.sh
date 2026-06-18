#!/bin/bash
# Run all IPC handler contract tests
# Usage: bash packages/shared/test-utils/run-all.sh

set -e
# Node 24 removed the bare `--loader` flag; `--experimental-loader` is the working
# equivalent (eventual replacement: `--import` + `module.register()`). Registers the
# electron/dep mock loader for both the npx-tsx and Electron runners below.
LOADER="--experimental-loader ./packages/shared/test-utils/loader.ts"
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

# Domain handler contract tests touch the harness better-sqlite3 DB, so they need
# the Electron node ABI (strict+loader) — plain `npx tsx` ERR_DLOPENs. Paths moved
# from src/main/ → src/electron/ in the Wave C2 split; repointed here.
run_test_electron_strict_loader packages/shared/transport/src/server/routers/settings.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/tags.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/projects.test.ts
run_test_electron_strict_loader packages/domains/projects/src/server/task-automation.test.ts
# Project-group ordering — pure named txns (shared top-level sort_order space).
# Strict+electron: better-sqlite3 native ABI matches Electron's node only.
run_test_electron_strict_loader packages/domains/projects/src/server/project-groups-txns.test.ts
run_test_electron_strict_loader packages/domains/task/src/server/ops/conversation-id-heal.test.ts
run_test_electron_strict_loader packages/domains/task/src/server/ops/task-conversations.test.ts
# v147 first-class agent-session entity — new resolver parity vs the v145 ledger.
run_test_electron_strict_loader packages/domains/task/src/server/ops/agent-sessions.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/task-terminals.test.ts
run_test packages/domains/task/src/shared/revive-decision.test.ts
run_test packages/domains/task/src/shared/provider-config-history.test.ts
run_test packages/domains/task/src/shared/conversation-heal.test.ts
run_test_electron_strict_loader packages/domains/task/src/electron/handlers.test.ts
run_test_electron_strict_loader packages/domains/task/src/electron/template-handlers.test.ts
run_test packages/domains/task/src/client/card-water-fill.test.ts
# Tab store — Home-icon nav forces home/kanban tab across project switch.
run_test packages/domains/settings/src/client/useTabStore.test.ts
run_test packages/domains/terminal/src/client/focus-loss-diag.test.ts
run_test packages/domains/sidebar/src/views/projectGrouping.test.ts
run_test packages/domains/sidebar/src/views/projectDrop.test.ts
run_test_electron_strict_loader packages/domains/ai-config/src/electron/handlers.items.test.ts
run_test_electron_strict_loader packages/domains/ai-config/src/electron/handlers.selections.test.ts
run_test_electron_strict_loader packages/domains/ai-config/src/electron/handlers.context.test.ts
run_test_electron_strict_loader packages/domains/file-editor/src/electron/handlers.test.ts
run_test_electron_strict_loader packages/domains/diagnostics/src/electron/service.test.ts
run_test_electron_strict_loader packages/domains/integrations/src/electron/handlers.db.test.ts
run_test_electron_strict_loader packages/domains/worktrees/src/electron/handlers.test.ts
# agent-turns suite runs strict: async-DB rot fixed (awaits added; snapshotWorktree
# return adapted to {snapshotSha,headSha}). NOTE: all run_test* helpers are now strict
# (pipefail), so the ~30 still-broken domain suites no longer mask as PASS — they now
# count as FAIL. Two known buckets remain, tracked as a separate per-domain-fix task:
#   1. better-sqlite3 ERR_DLOPEN — DB-handler tests on plain-node `run_test` need the
#      Electron runner (some also need async-DB await fixes once they load).
#   2. rest-api/tasks/* + mcp-tools/* — real assertion failures (async-DB move fallout).
run_test_electron_strict_loader packages/domains/agent-turns/src/server/db.test.ts
run_test_electron_strict_loader packages/domains/agent-turns/src/server/git-snapshot.test.ts
run_test_electron_strict_loader packages/domains/agent-turns/src/server/turn-tracker.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/agent-turns.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/chat.test.ts
# Transport routers P13 — task + template + artifacts (createCaller contract tests)
run_test_electron_strict_loader packages/shared/transport/src/server/routers/task.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/template.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/artifacts.test.ts
# Browser onEvent snapshot replay (stuck-loading race fix) — no DB, plain tsx
run_test packages/shared/transport/src/server/routers/app.browser-events.test.ts
run_test_electron_strict_loader packages/domains/integrations/src/electron/handlers.api.test.ts
run_test_electron_strict_loader packages/domains/integrations/src/electron/handlers.analyze.test.ts
run_test packages/domains/automations/src/shared/templates.test.ts
run_test packages/domains/automations/src/shared/types.test.ts
run_test packages/domains/automations/src/shared/ai.test.ts
run_test_electron_strict_loader packages/domains/automations/src/electron/handlers.test.ts
run_test_electron_strict_loader packages/domains/automations/src/server/engine.test.ts

# Terminal — SGR stripping + WebGL renderer lifecycle
run_test packages/domains/terminal/src/server/filter-buffer-data.test.ts
run_test packages/domains/terminal/src/client/webgl-loader.test.ts

# Terminal — state machine + hook-driven input-flip gate (stuck-running-after-/status)
run_test packages/domains/terminal/src/server/state-machine.test.ts
# Terminal — idle-close engagement (browser/other-panel interaction keeps agent warm)
run_test packages/domains/terminal/src/server/engagement.test.ts
run_test packages/domains/terminal/src/server/session-error-gate.test.ts
# Terminal — fresh-vs-resume decision (restart-clobber invariant: known id ⇒ resume)
run_test packages/domains/terminal/src/server/spawn-conversation.test.ts
run_test packages/domains/terminal/src/server/claude-transcripts.test.ts
run_test packages/domains/terminal/src/server/adapters/claude-adapter.test.ts
run_test packages/domains/terminal/src/server/adapters/antigravity-adapter.test.ts
run_test packages/domains/terminal/src/server/adapters/hook-driven-modes.test.ts

# Terminal — Codex Chat (codex-chat mode) driver + transport + adapter
run_test packages/domains/terminal/src/server/agents/codex/codex-app-server-client.test.ts
run_test packages/domains/terminal/src/server/agents/codex/codex-chat-session.test.ts
run_test packages/domains/terminal/src/server/adapters/codex-adapter.test.ts

# Terminal — chat transport manager (session lifecycle + liveness watchdog)
run_test packages/domains/terminal/src/server/runtime/chat-transport-manager.test.ts

# Terminal — warm-process pool (per-project gate + adopt-match). Strict+electron:
# pty-manager pulls in `electron`; a fake spawnShell is injected so no real shells spawn.
run_test_electron_strict_loader packages/domains/terminal/src/server/runtime/warm-process-manager.test.ts
# Terminal — createPty warm-shell adoption branch (fake pty/win/db, no real spawn).
run_test_electron_strict_loader packages/domains/terminal/src/server/runtime/adopt-pty.test.ts
# Terminal — createPty main-authoritative resolver wiring (null hint + ledger id ⇒ resume).
run_test_electron_strict_loader packages/domains/terminal/src/server/runtime/createpty-resolver.test.ts

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
run_test_electron_loader packages/domains/task/src/server/events.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tasks/archive.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tasks/archive-many.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tasks/create.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tasks/delete.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tasks/unarchive.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tasks/update.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/agent-hook-attention.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/mcp-tools/archive-task.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/mcp-tools/archive-many-task.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/mcp-tools/create-task.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/mcp-tools/delete-task.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/mcp-tools/unarchive-task.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/mcp-tools/update-task.test.ts
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
  run_test_no_loader packages/domains/integrations/src/electron/handlers.integration.linear.test.ts
fi
if [ -n "$GITHUB_TOKEN" ]; then
  run_test_no_loader packages/domains/integrations/src/electron/handlers.integration.github.test.ts
fi

# jsdom React client suites (vi.mock + JSX + @vitest-environment jsdom) can't run
# under the tsx/electron runners above — they need the vitest runner. The app
# vitest config wires @vitejs/plugin-react. Explicit file paths override vitest's
# default include glob so only these run (no sweep of the tsx-harness *.test.ts).
echo ""
echo "=== vitest (jsdom client suites) ==="
if pnpm exec vitest run --config packages/apps/app/vitest.config.ts --exclude '**/.claude/worktrees/**' \
  packages/apps/app/src/main/boot-config.test.ts \
  packages/apps/app/src/main/renderer-csp.test.ts \
  packages/domains/task/src/client/TaskDetailPage.test.tsx \
  packages/domains/task/src/client/TaskMetadataSidebar.test.tsx \
  packages/domains/task/src/client/TaskHistoryPanel.test.tsx \
  packages/domains/task/src/client/taskDetailCache.test.ts \
  packages/domains/task-browser/src/client/useBrowserViewEvents.test.tsx; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Summary ==="
echo "Suites: $PASS passed, $FAIL failed"

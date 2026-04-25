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
  if $TSX $LOADER "$1" 2>&1 | grep -v 'npm warn\|Migration\|ExperimentalWarning\|--trace-warnings\|--import'; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
}

run_test packages/domains/settings/src/main/handlers.test.ts
run_test packages/domains/tags/src/main/handlers.test.ts
run_test packages/domains/projects/src/main/handlers.test.ts
run_test packages/domains/projects/src/main/task-automation.test.ts
run_test packages/domains/task-terminals/src/main/handlers.test.ts
run_test packages/domains/task/src/main/handlers.test.ts
run_test packages/domains/task/src/main/template-handlers.test.ts
run_test packages/domains/ai-config/src/main/handlers.items.test.ts
run_test packages/domains/ai-config/src/main/handlers.selections.test.ts
run_test packages/domains/ai-config/src/main/handlers.context.test.ts
run_test packages/domains/file-editor/src/main/handlers.test.ts
run_test packages/domains/diagnostics/src/main/service.test.ts
run_test packages/domains/integrations/src/main/handlers.db.test.ts
run_test packages/domains/worktrees/src/main/handlers.test.ts
run_test packages/domains/agent-turns/src/main/db.test.ts
run_test packages/domains/agent-turns/src/main/git-snapshot.test.ts
run_test packages/domains/agent-turns/src/main/turn-tracker.test.ts
run_test packages/domains/integrations/src/main/handlers.api.test.ts
run_test packages/domains/integrations/src/main/handlers.analyze.test.ts
run_test packages/domains/automations/src/shared/templates.test.ts
run_test packages/domains/automations/src/shared/types.test.ts
run_test packages/domains/automations/src/main/handlers.test.ts
run_test packages/domains/automations/src/main/engine.test.ts

run_test_no_loader() {
  echo ""
  echo "=== $1 (integration) ==="
  if ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm "$1" 2>&1 | grep -v 'npm warn\|Migration\|ExperimentalWarning\|--trace-warnings\|--import'; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
}

run_test_electron_loader() {
  echo ""
  echo "=== $1 (electron+loader) ==="
  if ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm $LOADER "$1" 2>&1 | grep -v 'npm warn\|Migration\|ExperimentalWarning\|--trace-warnings\|--import'; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
}

# Wave 5 — taskEvents bus + REST routes + MCP tools + CLI integration
run_test_electron_loader packages/domains/task/src/main/events.test.ts
run_test_electron_loader packages/apps/app/src/main/rest-api/tasks/archive.test.ts
run_test_electron_loader packages/apps/app/src/main/rest-api/tasks/archive-many.test.ts
run_test_electron_loader packages/apps/app/src/main/rest-api/tasks/create.test.ts
run_test_electron_loader packages/apps/app/src/main/rest-api/tasks/delete.test.ts
run_test_electron_loader packages/apps/app/src/main/rest-api/tasks/unarchive.test.ts
run_test_electron_loader packages/apps/app/src/main/rest-api/tasks/update.test.ts
run_test_electron_loader packages/apps/app/src/main/mcp-tools/archive-task.test.ts
run_test_electron_loader packages/apps/app/src/main/mcp-tools/archive-many-task.test.ts
run_test_electron_loader packages/apps/app/src/main/mcp-tools/create-task.test.ts
run_test_electron_loader packages/apps/app/src/main/mcp-tools/delete-task.test.ts
run_test_electron_loader packages/apps/app/src/main/mcp-tools/unarchive-task.test.ts
run_test_electron_loader packages/apps/app/src/main/mcp-tools/update-task.test.ts
run_test_electron_loader packages/apps/cli/test/tasks-rest.test.ts

# CLI command tests (need Electron Node for better-sqlite3 + ESM interop)
run_test_no_loader packages/apps/cli/test/db.test.ts
run_test_no_loader packages/apps/cli/test/tags.test.ts
run_test_no_loader packages/apps/cli/test/templates.test.ts
run_test_no_loader packages/apps/cli/test/automations.test.ts
run_test_no_loader packages/apps/cli/test/tasks-ext.test.ts
run_test_no_loader packages/apps/cli/test/projects-update.test.ts

if [ -n "$LINEAR_API_KEY" ]; then
  run_test_no_loader packages/domains/integrations/src/main/handlers.integration.linear.test.ts
fi
if [ -n "$GITHUB_TOKEN" ]; then
  run_test_no_loader packages/domains/integrations/src/main/handlers.integration.github.test.ts
fi

echo ""
echo "=== Summary ==="
echo "Suites: $PASS passed, $FAIL failed"

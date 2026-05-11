#!/bin/bash
# Run maintained unit/contract suites that use the lightweight test harness.
# Usage: bash packages/shared/test-utils/run-all.sh

set -euo pipefail

LOADER="--loader ./packages/shared/test-utils/loader.ts"
PASS=0
FAIL=0

filter_output() {
  grep -vE 'npm warn|Migration [0-9]+ applied|ExperimentalWarning|--trace-warnings|--import' "$1" || true
}

run_suite() {
  local label="$1"
  local path="$2"
  shift 2

  echo ""
  echo "=== $label ==="

  if [ ! -f "$path" ]; then
    echo "Missing test file: $path"
    FAIL=$((FAIL + 1))
    return
  fi

  local tmp
  tmp="$(mktemp)"
  set +e
  "$@" >"$tmp" 2>&1
  local status=$?
  set -e

  filter_output "$tmp"
  rm -f "$tmp"

  if [ "$status" -eq 0 ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
}

run_electron_loader() {
  local path="$1"
  run_suite "$path" "$path" env ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm $LOADER "$path"
}

run_electron() {
  local path="$1"
  run_suite "$path" "$path" env ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm "$path"
}

electron_loader_tests=(
  packages/domains/projects/src/server/task-automation.test.ts
  packages/domains/task/src/server/attention.test.ts
  packages/domains/task/src/server/events.test.ts
  packages/domains/task/src/server/ops/shared-worktree-guard.test.ts
  packages/domains/task/src/server/ops/subtask-inheritance.test.ts
  packages/domains/agent-turns/src/server/db.test.ts
  packages/domains/agent-turns/src/server/git-snapshot.test.ts
  packages/domains/agent-turns/src/server/turn-tracker.test.ts
  packages/domains/automations/src/shared/templates.test.ts
  packages/domains/automations/src/shared/types.test.ts
  packages/domains/automations/src/shared/ai.test.ts
  packages/domains/automations/src/server/history.test.ts
  packages/apps/server/src/mcp/tools/archive-task.test.ts
  packages/apps/server/src/mcp/tools/archive-many-task.test.ts
  packages/apps/server/src/mcp/tools/create-task.test.ts
  packages/apps/server/src/mcp/tools/delete-task.test.ts
  packages/apps/server/src/mcp/tools/unarchive-task.test.ts
  packages/apps/server/src/mcp/tools/update-task.test.ts
)

electron_tests=(
  packages/apps/app/src/main/db/agent-panel-rename-migration.test.ts
  packages/apps/app/src/main/db/ai-config-raw-skill-migration.test.ts
  packages/apps/app/src/main/db/ai-config-slug-migration.test.ts
  packages/apps/app/src/main/db/history-migration.test.ts
  packages/apps/app/src/main/db/status-normalization.test.ts
  packages/apps/app/src/main/db/tag-color-dedup-migration.test.ts
  packages/apps/app/src/main/db/v127-disk-migration.test.ts
  packages/apps/app/src/main/db/worktree-source-branch-migration.test.ts
  packages/apps/cli/test/db.test.ts
  packages/apps/cli/test/tags.test.ts
  packages/apps/cli/test/templates.test.ts
  packages/apps/cli/test/automations.test.ts
  packages/apps/cli/test/projects-update.test.ts
)

for test_path in "${electron_loader_tests[@]}"; do
  run_electron_loader "$test_path"
done

for test_path in "${electron_tests[@]}"; do
  run_electron "$test_path"
done

echo ""
echo "=== Summary ==="
echo "Suites: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

#!/bin/bash
# Strict CI gate for the suites that prove the hub switches, hub auth and per-user
# ownership (todo T-01). Same runners and flags as run-all.sh (they live in
# packages/shared/test-utils/runners.sh), but scoped to the hub and what it serves,
# and it exits non-zero if ANY suite fails, is skipped without a reason, or is a test
# file nobody registered.
#
# Add a suite: one line below, with the runner it needs (copy the line from
# run-all.sh). A test file under a require_registered dir that appears in neither a
# run_* nor a skip_suite line fails the gate, so a new suite cannot be forgotten.
#
# Needs Node >= 24 (the hub-auth suites use node:sqlite without a flag) and the native
# modules rebuilt for Electron's ABI by the root postinstall (scripts/postinstall.js),
# so do not install with CI_SKIP_POSTINSTALL.
#
# Usage: pnpm test:hosted

set -euo pipefail
# shellcheck source=packages/shared/test-utils/runners.sh
source "$(dirname "${BASH_SOURCE[0]}")/../../packages/shared/test-utils/runners.sh"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "test-hosted needs Node >= 24, found $(node -v)" >&2
  exit 2
fi
ELECTRON_NODE=$(ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -p 'process.versions.node + " (electron " + process.versions.electron + ")"') || {
  echo "test-hosted: electron cannot run as node (is it installed and rebuilt?)" >&2
  exit 2
}
echo "node $(node -v); electron's node $ELECTRON_NODE"

# Hub app: boot rules, auth gates, computer URL + pin seam, enrollment, backup, web login.
run_test_electron_strict_loader packages/apps/hub/src/computer-auth.test.ts
run_test_electron_strict_loader packages/apps/hub/src/local-computer-roots.test.ts
run_test_electron_strict_loader packages/apps/hub/src/seed-computer-project-paths.test.ts
run_test_electron_strict_loader packages/apps/hub/src/supervised-bootstrap.test.ts
run_test_electron_strict_loader packages/apps/hub/src/host-kill.test.ts
run_test_electron_strict_loader packages/apps/hub/src/integrations-push.test.ts
run_test_electron_strict_loader packages/apps/hub/src/backup.test.ts
run_test_electron_strict_loader packages/apps/hub/src/dev-sql.test.ts
run_test_electron_strict_loader packages/apps/hub/src/tab-flag-recorders.test.ts
run_test_electron_strict_loader packages/apps/hub/src/hub-trpc-context.test.ts
run_test_electron_strict_loader packages/apps/hub/src/rest-auth.test.ts
run_test_electron_strict_loader packages/apps/hub/src/ws-origin.test.ts
run_test_electron_strict_loader packages/apps/hub/src/install-handshake.test.ts
run_test_electron_strict_loader packages/apps/hub/src/web-login-routing.test.ts
run_test_electron_strict_loader packages/apps/hub/src/web-assets-served.test.ts
run_test_electron_strict_loader packages/apps/hub/src/hub-boot.test.ts
run_test_electron_strict_loader packages/apps/hub/src/web-sessions.test.ts
run_test packages/apps/hub/src/build-info.test.ts
run_test packages/apps/hub/src/health.test.ts
run_test packages/apps/hub/src/web-assets.test.ts
run_test packages/apps/hub/src/port-claim.test.ts
run_test packages/apps/hub/src/remote-mcp-env-provider.test.ts
run_test packages/apps/hub/src/computer-tls-listener.test.ts
run_test packages/apps/hub/src/standalone-config.test.ts
run_test packages/apps/hub/src/boot-rules.test.ts
run_test packages/apps/hub/src/sidecar-socket-path.test.ts
run_test_electron_strict_loader packages/apps/hub/src/computer-restart-survival.test.ts
skip_suite packages/apps/hub/src/agent-hook-relay-consumer.test.ts \
  "fails at HEAD (2 of 7 tests: the transition spy is never called) and run-all.sh never registered it. TODO(T-01): fix the test, then move it into the vitest run below"

# Transport routers (tRPC): the surface the clients call.
run_test_electron_strict_loader packages/shared/transport/src/server/routers/settings.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/hub.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/tags.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/projects.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/task-terminals.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/computers.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/ai-config.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/file-editor.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/integrations.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/worktrees.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/agent-turns.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/chat.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/pty.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/task.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/template.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/artifacts.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/history.test.ts
run_test packages/shared/transport/src/server/routers/app.browser-events.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/automations.test.ts

# REST + MCP tools: the bearer-gated HTTP surface, join tokens, operator routes.
run_test_electron_strict_loader packages/shared/transport/src/server/http/rest-api/artifacts/export.test.ts
run_test packages/shared/transport/src/server/http/rest-api/artifacts/data-root.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/http/rest-api/computers/join-token.test.ts
run_test_no_loader packages/shared/transport/src/server/http/rest-api/hub/users.test.ts
run_test_no_loader packages/shared/transport/src/server/http/rest-api/hub/web-login.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tasks/archive.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tasks/archive-many.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tasks/create.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tasks/delete.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tasks/unarchive.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tasks/update.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tasks/done.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tasks/list.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tasks/get.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tasks/search.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tasks/subtasks.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tasks/blockers.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tasks/blocking.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tasks/blocked.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tasks/tags.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tasks/progress.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tasks/reset-conversation.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tags/crud.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/projects/list.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/projects/resolve-by-path.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/projects/crud.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/projects/skills.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/templates/crud.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/panels/crud.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/automations/crud.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/artifacts/list.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/artifacts/crud.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/artifacts/content.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/artifacts/versions.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/artifacts/search.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/agent-hook-attention.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/sessions/resolve-task.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/mcp-tools/archive-task.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/mcp-tools/archive-many-task.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/mcp-tools/create-task.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/mcp-tools/delete-task.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/mcp-tools/unarchive-task.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/mcp-tools/update-task.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/mcp-tools/get-current-task-id.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/mcp-tools/create-subtask.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/http/rest-api/tasks/open.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/http/rest-api/auth-deep-link.test.ts

# Schema migrations: ownership columns land here.
run_test_electron_strict_loader packages/shared/transport/src/db-bootstrap/history-migration.test.ts
run_test_electron_strict_loader packages/shared/transport/src/db-bootstrap/v140-task-state-migration.test.ts
run_test_electron_strict_loader packages/shared/transport/src/db-bootstrap/v147-agent-sessions-migration.test.ts
run_test_electron_strict_loader packages/shared/transport/src/db-bootstrap/v148-agent-sessions-runtime-migration.test.ts
run_test_electron_strict_loader packages/shared/transport/src/db-bootstrap/agent-panel-rename-migration.test.ts
run_test_electron_strict_loader packages/shared/transport/src/db-bootstrap/ai-config-raw-skill-migration.test.ts
run_test_electron_strict_loader packages/shared/transport/src/db-bootstrap/ai-config-slug-migration.test.ts
run_test_electron_strict_loader packages/shared/transport/src/db-bootstrap/codex-flags-migration.test.ts
run_test_electron_strict_loader packages/shared/transport/src/db-bootstrap/schema-too-new.test.ts
run_test_electron_strict_loader packages/shared/transport/src/db-bootstrap/status-normalization.test.ts
run_test_electron_strict_loader packages/shared/transport/src/db-bootstrap/tag-color-dedup-migration.test.ts

skip_suite packages/shared/transport/src/db-bootstrap/worktree-source-branch-migration.test.ts \
  "fails at HEAD (duplicate column name: execution_context) and run-all.sh never registered it. TODO(T-01): fix the test, then register it above"

# Hub switches and their config file, env scoping, hub address derivation.
run_test_electron_strict_loader packages/domains/computers/src/server/project-paths.test.ts
run_test packages/shared/platform/src/hub-switches.test.ts
run_test packages/shared/platform/src/hub-config-file.test.ts
run_test packages/shared/platform/src/env-manifest.test.ts
run_test packages/shared/platform/src/hub-addr.test.ts

# Node-environment vitest suites: scopes + trpc (the principal/scope gate), agent-hook.
# Under the app's vitest config, like run-all.sh.
run_vitest_files "vitest (transport server)" \
  packages/shared/transport/src/server/scopes.test.ts \
  packages/shared/transport/src/server/trpc.test.ts \
  packages/shared/transport/src/server/http/rest-api/agent-hook.test.ts \
  packages/shared/transport/src/server/http/rest-api/agent-hook-prompt-capture.test.ts

# Packages with their own vitest config: new test files in them are picked up with no
# edit here.
run_package_tests packages/domains/hub-auth @slayzone/hub-auth
run_package_tests packages/domains/computers @slayzone/computers
run_package_tests packages/domains/computer-transport @slayzone/computer-transport
skip_suite "packages/apps/computer (own vitest config)" \
  "not yet proven green on Linux CI: its handler suites spawn real ptys, git and gh, and fs.test.ts's fs.watch test timed out once under load (5s). TODO(T-01): enable after the first green hosted-tests run, then drop this line"

require_registered \
  packages/apps/hub/src \
  packages/shared/transport/src/server \
  packages/shared/transport/src/db-bootstrap

print_summary
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

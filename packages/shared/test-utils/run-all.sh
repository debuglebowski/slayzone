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
run_test_electron_strict_loader packages/shared/transport/src/server/routers/hub.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/tags.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/projects.test.ts
run_test_electron_strict_loader packages/domains/projects/src/server/task-automation.test.ts
# Project-group ordering — pure named txns (shared top-level sort_order space).
# Strict+electron: better-sqlite3 native ABI matches Electron's node only.
run_test_electron_strict_loader packages/domains/projects/src/server/project-groups-txns.test.ts
run_test_electron_strict_loader packages/domains/task/src/server/ops/conversation-id-heal.test.ts
run_test_electron_strict_loader packages/domains/task/src/server/ops/task-conversations.test.ts
run_test_electron_strict_loader packages/domains/task/src/server/ops/startup-purge.test.ts
run_test_electron_strict_loader packages/domains/task/src/server/artifact-watcher.test.ts
# v147 first-class agent-session entity — new resolver parity vs the v145 ledger.
run_test_electron_strict_loader packages/domains/task/src/server/ops/agent-sessions.test.ts
# Entity-model B — one-row-per-spawn session lifecycle (spawn→confirm→dead→bind).
run_test_electron_strict_loader packages/domains/task/src/server/ops/agent-sessions-lifecycle.test.ts
# v151 `in-band-clear` origin — CHECK-widening table rebuild. Guards the data copy
# (both tables are DROPped and recreated) + enum↔CHECK sync.
run_test_electron_strict_loader packages/domains/task/src/server/ops/in-band-clear-migration.test.ts
# listTaskSessions — sessions-sidebar grouping + reset cutoff (was unregistered).
run_test_electron_strict_loader packages/domains/task/src/server/ops/list-task-sessions.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/task-terminals.test.ts
# Wave-1 hub/runner split — exec-domain DB access moved behind injectable ops seams.
run_test_electron_strict_loader packages/domains/terminal/src/server/runtime/chat-data-ops.test.ts
run_test_electron_strict_loader packages/domains/terminal/src/server/runtime/chat-queue-data.test.ts
run_test_electron_strict_loader packages/domains/terminal/src/server/runtime/pty-session-ledger.test.ts
run_test_electron_strict_loader packages/domains/task/src/server/ops/worktree-exec-adapters.test.ts
run_test_electron_strict_loader packages/domains/task/src/server/ops/exec-boundary.test.ts
run_test_electron_strict_loader packages/apps/hub/src/runner-auth.test.ts
# Client↔hub /trpc connection-context seam — windowId parse + bearer→principal verify (real hub-auth).
run_test_electron_strict_loader packages/apps/hub/src/hub-trpc-context.test.ts
# HTTP twin of the above — /api/* + /mcp bearer gate (exemptions, loopback bypass,
# fail-closed) driven over a real listener with a real better-auth session.
run_test_electron_strict_loader packages/apps/hub/src/rest-auth.test.ts
# Wave-2 hub/runner split — OS-level exec routed behind injectable spawn-backend seams.
run_test_electron_strict_loader packages/domains/terminal/src/server/runtime/pty-backend.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/runners.test.ts
# Hub↔runner install handshake — boots the built hub+runner bins, isolated (tmp
# home/store, ports 0, scrubbed env), asserts the runner enrolls + the real
# dev/prod DBs stay byte-unchanged. Auto-builds both bundles on demand (first run
# is slower). Electron ABI → strict loader.
run_test_electron_strict_loader packages/apps/hub/src/install-handshake.test.ts
run_test packages/domains/task/src/shared/revive-decision.test.ts
run_test packages/domains/task/src/shared/provider-config-history.test.ts
run_test packages/domains/task/src/shared/conversation-heal.test.ts
run_test packages/domains/task/src/client/card-water-fill.test.ts
# Tab store — Home-icon nav forces home/kanban tab across project switch.
run_test packages/domains/settings/src/client/useTabStore.test.ts
run_test packages/domains/terminal/src/client/focus-loss-diag.test.ts
run_test packages/domains/sidebar/src/views/projectGrouping.test.ts
run_test packages/domains/sidebar/src/views/projectDrop.test.ts
# listForTask scoping — null taskId (Home/project view) must not leak other projects' processes.
run_test packages/domains/processes/src/server/process-manager.test.ts
# Persistence seam — fake ProcessPersistence records insert/update/remove; loadAll hydration.
run_test packages/domains/processes/src/server/process-persistence.test.ts
# Wave-2 spawn backend seam — fake ProcessBackend streaming/exit/autoRestart/kill.
run_test packages/domains/processes/src/server/process-backend.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/ai-config.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/file-editor.test.ts
run_test_electron_strict_loader packages/domains/diagnostics/src/electron/service.test.ts
# Sidecar build identity — /health + getServerBuildInfo (pure; plans/sidecar-staleness.md P1)
run_test packages/apps/hub/src/build-info.test.ts
# /health identity + loopback gating — the multi-hub discovery channel
# (plans/hub-lifecycle-and-discovery.md P1).
run_test packages/apps/hub/src/health.test.ts
# Hub port block — hubs bind a KNOWN range so `slay hub ls` can find them (P3).
run_test packages/shared/platform/src/hub-port-block.test.ts
# Multi-hub discovery — /health sweep of the port block; no pidfile/registry (P4).
run_test packages/shared/platform/src/hub-discovery.test.ts
# OS-supervisor units (launchd/systemd) behind `slay hub create` + `slay runner
# create` — generated file CONTENT only; never registers with the real supervisor (P5).
run_test packages/shared/platform/src/service-unit.test.ts
# `slay hub` end-to-end: boots two REAL hubs in temp roots, then drives ls /
# --hub targeting / stop through the built CLI bundle, and asserts the
# supervised-hub refusal. Spawns hubs directly (never `hub start`), so no
# launchd/systemd unit is ever installed by the suite. Electron ABI (the hub
# bundle needs better-sqlite3) → strict loader.
run_test_electron_strict_loader packages/apps/cli/src/commands/hub-lifecycle.test.ts
# `slay runner` end-to-end: boots a REAL hub in a temp root, mints a join token over
# its loopback REST channel, then drives `runner create` through the built CLI and
# asserts the runner ENROLLS (a runner has no /health to probe — its own
# `mode:"enroll"` line and its credential file are the evidence). Forces the
# unsupervised branch (SLZ_FORCE_NO_SERVICE=1), so no launchd/systemd unit is ever
# installed. Electron ABI (hub better-sqlite3 + runner node-pty) → strict loader.
run_test_electron_strict_loader packages/apps/cli/src/commands/runner-lifecycle.test.ts
# server_port non-clobber guard (pure; plans/sidecar-staleness.md P4)
run_test packages/apps/hub/src/port-claim.test.ts
# Wave-3.5 remote-mcp-env provider (remote hub URL + scoped task token).
run_test packages/apps/hub/src/remote-mcp-env-provider.test.ts
# Wave-3.5 runner TLS listener — separate https/wss server, cert pinning, bind-fail degrade.
run_test packages/apps/hub/src/runner-tls-listener.test.ts
# Shared ~/.slayzone/config.json (hub+runner; env>file>default, auto-gen secret, race-safe).
run_test packages/shared/platform/src/slayzone-config.test.ts
run_test packages/apps/hub/src/standalone-config.test.ts
# Interactive first-run setup (hub+runner): TTY/supervised/noninteractive gating,
# confirm-to-save, env seed, config.json merge (fake IO — no real TTY).
run_test packages/shared/platform/src/config-prompt.test.ts
# CLI author context resolves from SLAYZONE_AGENT_ID (the injected var), not AGENT_MODE.
run_test packages/apps/cli/src/commands/tasks/cli-author.test.ts
# Artifacts data-root: SLAYZONE_ROOT-derived <ROOT>/storage (retired DB_DIR ignored).
run_test packages/shared/transport/src/server/http/rest-api/artifacts/data-root.test.ts
# Storage migration — DB/artifacts/recent-backups extract into <ROOT>/storage, idempotent, copy-verify-delete.
run_test packages/apps/app/src/main/storage-migration.test.ts
# SLAYZONE_MODE resolver + mode/bind contradiction guard (local+exposed = fatal).
run_test packages/shared/platform/src/slayzone-mode.test.ts
# Env scope manifest + sanitizeSpawnEnv — spawn-boundary denylist (fail closed).
run_test packages/shared/platform/src/env-manifest.test.ts
# Cursor-position/status query+response stripping — shared by pty-manager and the
# runner (spontaneous-/clear regression guard; scope must stay narrow).
run_test packages/shared/platform/src/device-status-queries.test.ts
# hubUrlFromAddr — authority-only SLAYZONE_HUB_ADDRESS + scheme from SLAYZONE_MODE.
run_test packages/shared/platform/src/hub-addr.test.ts
# Sidecar socket path derives from SLAYZONE_ROOT (<ROOT>/run), override + length fallback.
run_test packages/apps/hub/src/sidecar-socket-path.test.ts
# Wave-3.5 D5 runner restart-survival — stable port + local-runner dedup (count stays 1 across reboots).
run_test_electron_strict_loader packages/apps/hub/src/runner-restart-survival.test.ts
# Wave-3.5 loopback join-token mint route (main auto-enroll channel).
run_test_electron_strict_loader packages/shared/transport/src/server/http/rest-api/runners/join-token.test.ts
# Loopback operator account routes (`slay hub users`). no_loader: the routes never
# touch the DB (the hubUsers capability is stubbed), so no Electron-ABI harness.
run_test_no_loader packages/shared/transport/src/server/http/rest-api/hub/users.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/integrations.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/worktrees.test.ts
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
# Cross-domain: task+tags+history activity-event recording + cursor pagination.
run_test_electron_strict_loader packages/shared/transport/src/server/routers/history.test.ts
# Browser onEvent snapshot replay (stuck-loading race fix) — no DB, plain tsx
run_test packages/shared/transport/src/server/routers/app.browser-events.test.ts
run_test packages/domains/automations/src/shared/templates.test.ts
run_test packages/domains/automations/src/shared/types.test.ts
run_test packages/domains/automations/src/shared/ai.test.ts
run_test_electron_strict_loader packages/shared/transport/src/server/routers/automations.test.ts
run_test_electron_strict_loader packages/domains/automations/src/server/engine.test.ts

# Terminal — SGR stripping + WebGL renderer lifecycle
run_test packages/domains/terminal/src/server/filter-buffer-data.test.ts
# Wave-3 remote-runner per-PTY env (loopback vs hub URL + scoped token).
run_test packages/domains/terminal/src/server/mcp-env.test.ts
run_test packages/domains/terminal/src/client/webgl-loader.test.ts
# Terminal — downgrade guard: the pinned @xterm/addon-webgl build must carry the
# shared-texture-atlas fix (#6042/#6055). Without it, correcting the atlas on one
# pane scrambles every pane sharing it (CharAtlasCache is module-level).
run_test packages/domains/terminal/src/client/xterm-atlas-fix.test.ts
# Terminal — scramble detection signals + paint throttle. Both suites existed and
# passed but were never registered here, so nothing ran them.
run_test packages/domains/terminal/src/client/scramble-detector.test.ts
run_test packages/domains/terminal/src/client/paint-throttle.test.ts
# Terminal — CPR suppression at the parser. Guards the modified-F3 regression: a
# reply and a Shift/Ctrl/Alt+F3 keystroke are byte-identical, so the reply must
# never be generated rather than filtered afterwards. Uses @xterm/headless.
run_test packages/domains/terminal/src/client/suppress-device-status.test.ts
# Terminal — hub replay buffer: eviction prelude + chunk immutability.
run_test packages/domains/terminal/src/server/ring-buffer.test.ts
# Terminal — server answers to timing-critical queries (CPR/DA/DSR/OSC), the
# bounded partial-sequence hold, and the OSC catch-all's title exclusion.
run_test packages/domains/terminal/src/server/sync-query-response.test.ts
# Diagnostics — payload blob offload. Screenshots were silently truncated to 4096
# chars by the redactor, making every recorded scramble event unprovable.
run_test packages/domains/diagnostics/src/server/payload-blobs.test.ts
# Diagnostics — blob retention. Offloading to disk means row deletion reclaims
# nothing, so blobs need their own age + size bound or they grow forever.
run_test packages/domains/diagnostics/src/server/blob-retention.test.ts
# Diagnostics — event-row retention (needs better-sqlite3 → electron ABI). Was
# never registered, which hid every assertion silently reading `undefined` from an
# un-awaited async call.
run_test_electron_strict_loader packages/domains/diagnostics/src/server/retention.test.ts

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
# `slay tasks done [--close]`: the done INTENT (project completed column) — not
# PATCH's status-alias resolution. See tasks/done.ts.
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/tasks/done.test.ts
# Wave-3 CLI cutover — dark hub REST read/CRUD surface consumed by the CLI.
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
# `slay init` hub-state half: skill rows + the installedVersion content-hash compare.
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/projects/skills.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/templates/crud.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/panels/crud.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/automations/crud.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/artifacts/list.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/artifacts/crud.test.ts
# Artifact CONTENT transfer — byte-exactness of the streamed create/upload/read
# paths (fixtures are deliberately not valid utf-8, so any string hop shows up).
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/artifacts/content.test.ts
# Artifact VERSION HISTORY routes (write/append + versions *). Byte-exactness of
# the streamed write/append bodies and the blob-streamed version read, plus the
# `Error [CODE]: …` 400 contract the CLI prints verbatim.
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/artifacts/versions.test.ts
# Artifact title+content search — the scan reads the blob store, so it can only
# run host-side; asserts the CLI's exact result shape + flag semantics.
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/artifacts/search.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/agent-hook-attention.test.ts
# Pool: session → bound task resolution (slay CLI fallback for pre-warmed agents).
run_test_electron_loader packages/shared/transport/src/server/http/rest-api/sessions/resolve-task.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/mcp-tools/archive-task.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/mcp-tools/archive-many-task.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/mcp-tools/create-task.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/mcp-tools/delete-task.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/mcp-tools/unarchive-task.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/mcp-tools/update-task.test.ts
# Warm-pool session → task fallback for MCP tools (mirrors the CLI/REST fallback above).
run_test_electron_loader packages/shared/transport/src/server/http/mcp-tools/get-current-task-id.test.ts
run_test_electron_loader packages/shared/transport/src/server/http/mcp-tools/create-subtask.test.ts
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
# Wave-3 CLI read commands routed through REST (hub-aware cutover).
run_test_electron_loader packages/apps/cli/test/cli-read-rest.test.ts
# Wave-3.5 CLI artifact commands routed through REST — metadata AND content
# (read/create/upload/delete/download), incl. a no-local-database suite.
run_test_electron_loader packages/apps/cli/test/cli-artifacts-rest.test.ts
# The rest of that cutover: search / update / write / append / versions *. Runs
# entirely with SLAYZONE_ROOT on an EMPTY dir — the hub owns the DB, the blobs and
# the artifact files; the CLI owns none of them. `path` is the one command left
# that opens the DB, and this suite asserts that too.
run_test_electron_loader packages/apps/cli/test/cli-artifacts-versions-rest.test.ts
# `slay tasks done` (incl. --close) + `slay init` against a hub, with NO local DB.
run_test_electron_loader packages/apps/cli/test/done-init-rest.test.ts

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
#
# A few non-jsdom node suites ride along here because they need vitest's runner for
# other reasons — the hub-auth ones use `vi`-free vitest globals plus node:sqlite,
# which the tsx/electron runners above don't provide. (Their own
# `pnpm --filter @slayzone/hub-auth test` also covers them; listing them here is
# what puts them in the aggregate run.)
echo ""
echo "=== vitest (jsdom client suites) ==="
if pnpm exec vitest run --config packages/apps/app/vitest.config.ts --exclude '**/.claude/worktrees/**' \
  packages/apps/app/src/main/boot-config.test.ts \
  packages/apps/app/src/main/renderer-csp.test.ts \
  packages/apps/app/src/main/hub-tokens.test.ts \
  packages/apps/app/src/main/hub-cert-pinning.test.ts \
  packages/shared/transport/src/client/federation.test.tsx \
  packages/domains/task/src/client/TaskDetailPage.test.tsx \
  packages/domains/task/src/client/TaskMetadataSidebar.test.tsx \
  packages/domains/task/src/client/TaskHistoryPanel.test.tsx \
  packages/domains/task/src/client/taskDetailCache.test.ts \
  packages/domains/task-browser/src/client/useBrowserViewEvents.test.tsx \
  packages/domains/worktrees/src/server/composite-ops.test.ts \
  packages/domains/settings/src/client/tabs/RunnersSettingsTab.test.tsx \
  packages/domains/task/src/client/RunnerCard.test.tsx \
  packages/domains/projects/src/client/GeneralTab.test.tsx \
  packages/domains/hub-auth/src/server/hub-auth.test.ts \
  packages/domains/hub-auth/src/server/users.test.ts \
  packages/shared/transport/src/server/http/rest-api/agent-hook.test.ts \
  packages/domains/runner-transport/src/server/exec-proxies.test.ts \
  packages/apps/runner/src/ring-buffer.test.ts; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Summary ==="
echo "Suites: $PASS passed, $FAIL failed"

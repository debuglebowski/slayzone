#!/bin/bash
# The ONE list of unit suites: `pnpm test:unit` locally and the CI unit-tests job.
# Usage: bash packages/shared/test-utils/run-all.sh
#        SLZ_UNIT_DRY=1 bash packages/shared/test-utils/run-all.sh   (registration check only)
#        SLZ_UNIT_LANES=harness bash packages/shared/test-utils/run-all.sh   (one lane: harness
#        or app_and_packages; CI runs each lane as its own job)
#
# Strict: exits non-zero if any suite fails, or if any test file under packages/ is
# neither run nor skipped with a reason (require_registered at the bottom). Add a suite:
# one line below with the runner it needs (node suites: `run_harness <file>`, run together
# under vitest.harness.config.ts); a test file nobody registers fails the run. The lines
# below only register; run_suites at the bottom runs them all (see runners.sh).
#
# Needs Node >= 24 (the hub-auth suites use node:sqlite without a flag) and the native
# modules rebuilt for Electron's ABI by the root postinstall (scripts/postinstall.js),
# so do not install with CI_SKIP_POSTINSTALL.

set -e
# shellcheck source=packages/shared/test-utils/runners.sh
source "$(dirname "${BASH_SOURCE[0]}")/runners.sh"

if ! dry_run; then
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$NODE_MAJOR" -lt 24 ]; then
    echo "test:unit needs Node >= 24, found $(node -v)" >&2
    exit 2
  fi
  ELECTRON_NODE=$(ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -p 'process.versions.node + " (electron " + process.versions.electron + ")"') || {
    echo "test:unit: electron cannot run as node (is it installed and rebuilt?)" >&2
    exit 2
  }
  echo "node $(node -v); electron's node $ELECTRON_NODE"
fi

# Domain handler contract tests touch the harness better-sqlite3 DB (Electron node ABI,
# which every run_harness suite runs under). Paths moved from src/main/ → src/electron/
# in the Wave C2 split; repointed here.
run_harness packages/shared/settings-core/src/server/router.test.ts
run_harness packages/apps/api/src/routers/hub.test.ts
run_harness packages/domains/tags/src/server/router.test.ts
run_harness packages/domains/projects/src/server/projects-router.test.ts
# With computers, a project's folder is recorded on a computer (create / update /
# refusal leaves no half-made project), never in the hub's projects.path column.
run_harness packages/domains/projects/src/server/project-folders.test.ts
run_harness packages/domains/projects/src/server/task-automation.test.ts
# Project-group ordering — pure named txns (shared top-level sort_order space).
run_harness packages/domains/projects/src/server/project-groups-txns.test.ts
run_harness packages/domains/task/src/server/ops/conversation-id-heal.test.ts
run_harness packages/domains/task/src/server/ops/task-conversations.test.ts
run_harness packages/domains/task/src/server/ops/startup-purge.test.ts
run_harness packages/domains/task/src/server/artifact-watcher.test.ts
# v147 first-class agent-session entity — new resolver parity vs the v145 ledger.
run_harness packages/domains/task/src/server/ops/agent-sessions.test.ts
# Entity-model B — one-row-per-spawn session lifecycle (spawn→confirm→dead→bind).
run_harness packages/domains/task/src/server/ops/agent-sessions-lifecycle.test.ts
# v151 `in-band-clear` origin — CHECK-widening table rebuild. Guards the data copy
# (both tables are DROPped and recreated) + enum↔CHECK sync.
run_harness packages/domains/task/src/server/ops/in-band-clear-migration.test.ts
# listTaskSessions — sessions-sidebar grouping + reset cutoff (was unregistered).
run_harness packages/domains/task/src/server/ops/list-task-sessions.test.ts
# v156 `user-selected` origin (session switch) + v157 session_deletions tombstones
# (session delete). Covers the CHECK-widening rebuild's data copy AND the ops.
run_harness packages/domains/task/src/server/ops/session-switch-delete.test.ts
# agent-prompts capture + the deleted-session filter on listPromptsForTask.
run_harness packages/domains/agent-turns/src/server/prompt-capture.test.ts
run_harness packages/domains/agent-turns/src/server/chat-prompt-recorder.test.ts
run_harness packages/domains/task-terminals/src/server/task-terminals-router.test.ts
# Wave-1 hub/computer split — exec-domain DB access moved behind injectable ops seams.
run_harness packages/domains/terminal/src/server/runtime/chat-data-ops.test.ts
run_harness packages/domains/terminal/src/server/runtime/chat-handlers.test.ts
run_harness packages/domains/terminal/src/server/runtime/chat-queue-data.test.ts
run_harness packages/domains/terminal/src/server/runtime/chat-queue-handlers.test.ts
run_harness packages/domains/terminal/src/server/runtime/chat-attachment-guard.test.ts
run_harness packages/domains/terminal/src/server/runtime/pty-session-ledger.test.ts
run_harness packages/domains/task/src/server/ops/worktree-exec-adapters.test.ts
run_harness packages/domains/task/src/server/ops/exec-boundary.test.ts
# Artifact export routes after the inversion: served by the HUB against ctx.db,
# reaching the desktop over AppDeps for the offscreen render alone.
run_harness packages/apps/api/src/http/rest-api/artifacts/export.test.ts
# GHSA-27r3-jxmh-p828: compressed request bodies are refused 415 on /mcp and /api/*
# (one compressed frame + trailing bytes crashed the process); one way to build a parser.
run_harness packages/apps/api/src/http/json-body.test.ts
# T-104: no id escapes into a path. Bad task/project ids refused by every fixed tRPC
# procedure (login off and on), REST archive-many and MCP; the data dir stays intact.
run_harness packages/apps/api/src/path-ids.test.ts
run_harness packages/apps/hub/src/computer-auth.test.ts
# Routing the filesystem to computers put the local computer's [homedir()] jail in
# front of work the desktop used to do unjailed. This pins the widening policy
# that keeps a project outside $HOME from silently breaking.
run_harness packages/apps/hub/src/local-computer-roots.test.ts
# T-19: a computer works only for its owner — bindings, auto-pick, the exec gate.
run_harness packages/apps/hub/src/computer-placement.test.ts
# Project folders: the ordered sequence each computer goes through on connect
# (refresh, legacy paths → pending, widen, deliver, default backfill) and user folder
# changes, serialized per computer so a refresh can never undo a folder just set.
run_harness packages/apps/hub/src/computer-project-sync.test.ts
# The hub composes the schema boot (migrations + domain boot steps).
run_harness packages/apps/hub/src/bootstrap-schema.test.ts
# Schema ownership: the hub migrates in EVERY mode. Pins that openServerDatabase
# has no opt-out and that a re-open neither re-migrates nor mints a 2nd backup.
run_harness packages/apps/hub/src/supervised-bootstrap.test.ts
# Diagnostics retention ownership: an unsupervised hub prunes its own diagnostics
# (rows + blobs; only the desktop host used to, so standalone hubs grew forever);
# a supervised hub leaves the shared file to its host.
run_harness packages/apps/hub/src/diagnostics-retention.test.ts
# Host-kill stamp: fires where the pty sessions are (the side-car), not on the
# host, whose session registry has been empty since slice 9.
run_harness packages/apps/hub/src/host-kill.test.ts
# Chat agents' state changes reach clients on pty.onStateChange (chat session id, same
# shape, owner-gated) — before, only the hub's own listeners saw them.
run_harness packages/apps/hub/src/chat-state-push.test.ts
# Hub — idle-close wiring: the hub runs the sweep + config + browser engagement
# touch (all were host-only after slice 9, so idle-close never fired).
run_harness packages/apps/hub/src/idle-close.test.ts
# Push-on-edit listens on the bus the task ops actually emit on. The host held the
# only listeners, on an ipcMain the ops stopped using at the slice-9 cutover.
run_harness packages/apps/hub/src/integrations-push.test.ts
# Pull-sync pollers: v0.35.0's host started them; the move to the hub dropped the call.
run_harness packages/apps/hub/src/integrations-pollers.test.ts
# Processes / integrations switched off (T-04, T-05, T-07), end to end over tRPC.
run_harness packages/apps/hub/src/switch-refusals.test.ts
# Hub-local exec and project files refused with processes switched off (T-06).
run_harness packages/apps/hub/src/local-exec-refusals.test.ts
# A bad processes.* input is a clean error, never a hub exit (T-102): the built hub with
# processes on (desktop, login) and off (Normain).
run_harness packages/apps/hub/src/processes-bad-input.test.ts
# Backup follows the DB. Pins the restore SEQUENCE (relaunch last — it kills this
# process) and that restore is refused on a hub the client merely connects to.
run_harness packages/apps/hub/src/backup.test.ts
# The E2E-only raw-SQL route. The GATE is the point: arbitrary SQL on a listener
# that faces the internet in remote mode, so its absence must be asserted.
run_harness packages/apps/hub/src/dev-sql.test.ts
# Restart-restore seam: the side-car must install the `was_spawned` recorder and
# set the shutdown gate before teardown, or a restart drops every agent.
run_harness packages/apps/hub/src/tab-flag-recorders.test.ts
# Client↔hub /trpc connection-context seam — windowId parse + bearer→principal verify (real hub-auth).
run_harness packages/apps/hub/src/hub-trpc-context.test.ts
# Account commands over real hub-auth + app DB: disable revokes BOTH session classes.
run_harness packages/apps/hub/src/hub-users.test.ts
# Leavers + session lifetimes (T-12): disable ends bearer, szw_, open sockets and owned
# computers, keeps every row; the hourly Entra re-check through fake timers + fake Entra.
run_harness packages/apps/hub/src/leavers.test.ts
# HTTP twin of the above — /api/* + /mcp bearer gate (exemptions, no loopback bypass,
# fail-closed) driven over a real listener with a real better-auth session.
run_harness packages/apps/hub/src/rest-auth.test.ts
# Project ownership (T-16): the boot backfill over real hub-auth + app DB, and the
# same through the real built hub against a v168 database (upgrade).
run_harness packages/apps/hub/src/ownership-backfill.test.ts
run_harness packages/apps/hub/src/ownership-boot.test.ts
# Every project-create surface (tRPC, REST, import; MCP has none) stores its owner.
run_harness packages/apps/api/src/project-owner-surfaces.test.ts
run_harness packages/apps/api/src/settings-host-wiring.test.ts
# Session retention (T-23): the sweep and its schedule, then through the built hub.
run_harness packages/apps/hub/src/session-retention.test.ts
run_harness packages/apps/hub/src/session-retention-boot.test.ts
# Owner checks (T-17): the one access function over a real DB, then two users on a real
# hub with login (ids, lists, live streams, admin) and the desktop's hub with login off.
run_harness packages/apps/api/src/access.test.ts
run_harness packages/apps/hub/src/owner-checks.test.ts
run_harness packages/apps/hub/src/owner-checks-login-off.test.ts
# Owner checks over REST, MCP and agent hooks (T-18): two users on a real hub with
# login (ids, lists, artifact files, relayed hooks, admin), then login off.
run_harness packages/apps/hub/src/owner-checks-http.test.ts
run_harness packages/apps/hub/src/owner-checks-http-login-off.test.ts
# Owner-check leftovers (T-101/T-105/T-106): own-content export, MCP sessions bound to
# their opener, admin routes decided by owner — with login, then the desktop's hub.
run_harness packages/apps/hub/src/owner-checks-admin.test.ts
run_harness packages/apps/hub/src/owner-checks-admin-login-off.test.ts
# Upload procedures never copy the hub's own files (DB, auth store, SSO key) or another
# user's to a caller, and read nothing off the hub's disk with processes off (T-107).
run_harness packages/apps/api/src/routers/upload-sources.test.ts
# WS twin of the same boundary — the /trpc upgrade origin guard. Was an untestable
# closure inside startServer; extracted so the "Origin: null is every sandboxed
# iframe on the web" case is actually asserted.
run_harness packages/apps/hub/src/ws-origin.test.ts
# Wave-2 hub/computer split — OS-level exec routed behind injectable spawn-backend seams.
run_harness packages/domains/terminal/src/server/runtime/pty-backend.test.ts
# The hub decides an agent's computer and folder before the spawn (task sessions and
# the project-wide agent panel); an explicit folder wins, none known = none guessed.
run_harness packages/domains/terminal/src/server/runtime/spawn-target.test.ts
run_harness packages/domains/terminal/src/server/runtime/pty-size.test.ts
# Doctor asks the task's computer whether node-pty can start terminals there.
run_harness packages/domains/terminal/src/server/runtime/runtime-doctor.test.ts
# Idle sweep runs windowless: idle-close countdown/hibernate + silence-timer idle flip.
run_harness packages/domains/terminal/src/server/runtime/idle-sweep.test.ts
# Hub-local pty/chat spawn refused with processes switched off; routed spawns unaffected.
run_harness packages/domains/terminal/src/server/runtime/hub-local-spawn-switch.test.ts
run_harness packages/domains/terminal/src/server/runtime/chat-proc-handle.test.ts
# node-pty optional in the published hub (T-30): loaded on the first local spawn, never at
# import; missing → a clear refusal at that spawn.
run_harness packages/domains/terminal/src/server/runtime/node-pty-optional.test.ts
run_harness packages/apps/api/src/routers/computers.test.ts
# Hub↔computer install handshake — boots the built hub+computer bins, isolated (tmp
# home/store, ports 0, scrubbed env), asserts the computer enrolls + the real
# dev/prod DBs stay byte-unchanged. The bundles are built by the harness globalSetup.
run_harness packages/apps/hub/src/install-handshake.test.ts
run_harness packages/apps/hub/src/web-login-routing.test.ts
# Web shell served by every hub (login off / on / desktop app); builds dist/web if absent.
run_harness packages/apps/hub/src/web-assets-served.test.ts
# Boot rules B1-B5, B7-B11, B13, B14 driven through the REAL built hub: each refusal exits
# non-zero before the hub touches its data dir; the defaults boot on loopback; a reachable
# hub behind a public address boots with login + secret and mints a pin-less wss token.
run_harness packages/apps/hub/src/hub-boot.test.ts
# The built hub boots with node-pty, bufferutil and utf-8-validate unresolvable (T-30).
run_harness packages/apps/hub/src/optional-natives-boot.test.ts
# T-11: a reachable hub writes no generated secret under ROOT and logs none (known
# values grepped in logs, stdout/stderr and every file); B17 + the loopback→reachable
# upgrade keeps sessions and enrolled computers.
run_harness packages/apps/hub/src/secrets-at-rest.test.ts
# Scoped browser sessions (mint/verify/revoke over a real migrated SlayzoneDb) —
# the credential a web login mints, distinct from a full better-auth session.
run_harness packages/apps/hub/src/web-sessions.test.ts
# Password sign-in off (T-10): every password route 403s with the switch code before the
# gate; break-glass (O-9) opens/closes with the switch over real hub-auth + app DB.
run_harness packages/apps/hub/src/password-switch.test.ts
run_harness packages/domains/task-contracts/src/revive-decision.test.ts
run_harness packages/domains/task-contracts/src/provider-config-history.test.ts
run_harness packages/domains/task-contracts/src/conversation-heal.test.ts
run_harness packages/domains/task/src/client/card-water-fill.test.ts
# Workflow columns — statuses shared by several projects (bulk status menu).
run_harness packages/shared/workflow/src/columns.test.ts
# Tab store — Home-icon nav forces home/kanban tab across project switch.
run_harness packages/domains/tabs-state/src/useTabStore.test.ts
# Explode-mode layout — column-major packing, whole-pixel rects, swap/reconcile order.
run_harness packages/domains/app-shell/src/client/explodeLayout.test.ts
run_harness packages/domains/terminal/src/client/focus-loss-diag.test.ts
run_harness packages/domains/sidebar/src/views/projectGrouping.test.ts
run_harness packages/domains/sidebar/src/views/projectDrop.test.ts
# listForTask scoping — null taskId (Home/project view) must not leak other projects' processes.
run_harness packages/domains/processes/src/server/process-manager.test.ts
# Persistence seam — fake ProcessPersistence records insert/update/remove; loadAll hydration.
run_harness packages/domains/processes/src/server/process-persistence.test.ts
# Wave-2 spawn backend seam — fake ProcessBackend streaming/exit/autoRestart/kill.
run_harness packages/domains/processes/src/server/process-backend.test.ts
# Processes switched off: no persisted row loaded, every spawn path refused at the backend too.
run_harness packages/domains/processes/src/server/process-switch.test.ts
run_harness packages/domains/ai-config/src/server/ai-config-router.test.ts
run_harness packages/domains/file-editor/src/server/file-editor-router.test.ts
run_harness packages/domains/diagnostics/src/electron/service.test.ts
# Write-queue batching: deferred flush, error/batch-size triggers, queue-cap drop event.
run_harness packages/domains/diagnostics/src/electron/batching.test.ts
# Write-queue flush timer never holds a process open; beforeExit flushes what it held.
run_harness packages/domains/diagnostics/src/server/flush-on-exit.test.ts
# Sidecar build identity — /health + getServerBuildInfo (pure; plans/sidecar-staleness.md P1)
run_harness packages/apps/hub/src/build-info.test.ts
# /health identity + loopback gating — the multi-hub discovery channel
# (plans/hub-lifecycle-and-discovery.md P1). PLAIN node: three tests dial this machine's
# own non-loopback LAN address, and on macOS a LAN connect from inside Electron.app is
# gated by its "Local Network" privacy permission — seen hanging there until granted,
# and every new Electron binary (an upgrade) asks again. Plain node passed throughout.
run_harness_node packages/apps/hub/src/health.test.ts
# A closed window's warm-pool tab counts are dropped (after a reconnect grace).
run_harness packages/apps/hub/src/warm-window-sockets.test.ts
run_harness packages/apps/hub/src/web-assets.test.ts
# Hub port block — hubs bind a KNOWN range so `slay hub ls` can find them (P3).
run_harness packages/shared/platform/src/hub-port-block.test.ts
# Multi-hub discovery — /health sweep of the port block; no pidfile/registry (P4).
run_harness packages/shared/platform/src/hub-discovery.test.ts
# OS-supervisor units (launchd/systemd) behind `slay hub create` + `slay computer
# create` — generated file CONTENT only; never registers with the real supervisor (P5).
run_harness packages/shared/platform/src/service-unit.test.ts
# The vitest fs module cache key: an import whose resolution can move must change it.
run_harness packages/shared/test-utils/fs-module-cache.test.ts
# The scripted fake `claude` CLI the chat e2e group and transport tests drive.
run_harness packages/shared/test-utils/fake-claude/fake-claude.test.ts
run_harness packages/shared/test-utils/chat-long-session/long-session.test.ts
# Recorded real-CLI transcripts (fake replay + drift check input): shape + no personal data.
run_harness packages/shared/test-utils/fake-claude/transcripts.test.ts
# Fake CLI token streaming + command tasks (chat plan 3.2 / 3.9).
run_harness packages/shared/test-utils/fake-claude/fake-claude-streams.test.ts
# expectKnownBug: marks one assertion as a known open bug without masking setup failures.
run_harness packages/shared/test-utils/known-bug.test.ts
# `slay hub` end-to-end: boots two REAL hubs in temp roots, then drives ls /
# --hub targeting / stop through the built CLI bundle, and asserts the
# supervised-hub refusal. Spawns hubs directly (never `hub start`), so no
# launchd/systemd unit is ever installed by the suite.
run_harness packages/apps/cli/src/commands/hub-lifecycle.test.ts
# Device sign-in (T-14): `slay hub login` against the REAL built hub with Entra sign-in
# on and password off (local fake Entra), browser approval with MFA, bearer on REST,
# denial, no token without MFA, audit; plus the CLI's password path (no more
# MISSING_OR_NULL_ORIGIN).
run_harness packages/apps/hub/src/hub-device-sign-in.test.ts
# The native app's Microsoft sign-in (PKCE code → `slayzone://`) through the REAL built
# hub (same fake Entra, sso-hub-harness.ts): confirm page, code exchange, bearer on REST,
# replay revokes, no open redirect, audit without secrets, token route flood-limited.
run_harness packages/apps/hub/src/hub-app-sign-in.test.ts
# `slay hub login` opens only an approval page on the hub's own host. Pure.
run_harness packages/apps/cli/src/hub-sign-in.test.ts
# `slay computer` end-to-end: boots a REAL hub in a temp root, mints a join token over
# its loopback REST channel, then drives `computer create` through the built CLI and
# asserts the computer ENROLLS (a computer has no /health to probe — its own
# `mode:"enroll"` line and its credential file are the evidence). Forces the
# unsupervised branch (SLZ_FORCE_NO_SERVICE=1), so no launchd/systemd unit is ever
# installed.
run_harness packages/apps/cli/src/commands/computer-lifecycle.test.ts
# `slay update` — global npm install detection + version bump. npm itself is a
# PATH-faked script (no native deps involved) => plain node.
run_harness packages/apps/cli/src/commands/update.test.ts
# `slay computer mint --for` / `--ttl` cap against a fake hub (T-20). Pure Node.
run_harness packages/apps/cli/src/commands/computer-mint.test.ts
# `slay computer roots` edit rules (T-27: folder limits are set on the device). Pure.
run_harness packages/apps/cli/src/commands/computer-roots.test.ts
run_harness packages/apps/cli/src/local-hub.test.ts
# server_port non-clobber guard (pure; plans/sidecar-staleness.md P4)
run_harness packages/apps/hub/src/port-claim.test.ts
# Wave-3.5 remote-mcp-env provider (remote hub URL + scoped task token).
run_harness packages/apps/hub/src/remote-mcp-env-provider.test.ts
# Computer /computers URL derivation (public address → wss, loopback → ws).
run_harness packages/apps/hub/src/computer-tls-listener.test.ts
# The built hub behind a TLS front end: CLI, computer and tRPC websocket verify its
# CA-issued certificate with no pin; a cert swap drops nothing; an older pinned token
# still enrolls (T-21).
run_harness packages/apps/hub/src/tls-front-end.test.ts
# The hub's boot rules as a pure function — one case per refusal (B1-B5, B7-B11, B13, B14).
run_harness packages/apps/hub/src/boot-rules.test.ts
# Per-role hub.config.json/hub.state.json + computer.config.json (env>file>default,
# auto-gen secret, race-safe, legacy shared config.json fallback).
run_harness packages/shared/platform/src/hub-config-file.test.ts
run_harness packages/shared/platform/src/computer-config-file.test.ts
run_harness packages/apps/hub/src/standalone-config.test.ts
# getSupervisedRoot: channel-to-bucket folding (beta/unknown → stable, never a
# third bucket), SLAYZONE_ROOT composition.
run_harness packages/shared/platform/src/dirs.test.ts
# Interactive first-run setup (hub+computer): TTY/supervised/noninteractive gating,
# confirm-to-save, env seed, config.json merge (fake IO — no real TTY).
run_harness packages/shared/platform/src/config-prompt.test.ts
# CLI author context resolves from SLAYZONE_AGENT_ID (the injected var), not AGENT_MODE.
run_harness packages/apps/cli/src/commands/tasks/cli-author.test.ts
# Artifacts data-root: SLAYZONE_ROOT-derived <ROOT>, flat (retired DB_DIR ignored).
run_harness packages/apps/api/src/http/rest-api/artifacts/data-root.test.ts
# Storage migration — DB/artifacts/recent-backups extract into <ROOT>/storage, idempotent, copy-verify-delete.
# Client-local settings store: corrupt-file handling, downgrade safety (unknown
# fields survive), and serialized read-modify-write.
run_harness packages/shared/platform/src/client-settings.test.ts
# The one-time move out of the shared DB. Copy-only, sentinel-gated, and it must
# REFUSE the sentinel when read-back fails — a wrong "done" is permanent.
run_harness packages/apps/app/src/main/client-settings-migration.test.ts
# Criterion 4: the same migration against a COPY of a real store. Opt-in — no-ops
# unless SLAYZONE_REAL_STORE_FIXTURE points at a real slayzone.sqlite. Asserts the
# ORIGINAL is byte-untouched, because a test that reads your live database is one
# bad line from repeating the storage-migration incident.
run_harness packages/apps/app/src/main/client-settings-migration.realstore.test.ts
# The desktop app's one Convex deployment (renderer + its hub): the build's URL, or the
# PLAYWRIGHT-only SLAYZONE_E2E_CONVEX_ADDRESS override (a bad value throws, never falls back).
run_harness packages/apps/app/src/main/convex-deployment.test.ts
# Schema-migration tests, relocated out of apps/app/src/main/db when the Electron
# host stopped opening the shared DB. They had NEVER been registered here, which
# is how six of the eleven rotted without anyone noticing: each rewound
# user_version and re-ran the whole tail, replaying forward-only DDL against a
# current schema — an operation production never performs. All eleven now build
# the DB at exactly version N-1 and apply migration N alone. Registered so they
# cannot rot again.
run_harness packages/shared/db-migrations/src/history-migration.test.ts
run_harness packages/shared/db-migrations/src/v140-task-state-migration.test.ts
run_harness packages/shared/db-migrations/src/v147-agent-sessions-migration.test.ts
run_harness packages/domains/task/src/server/v148-agent-sessions-runtime-migration.test.ts
# A v145 (v0.35.0) database with orphan rows must still migrate; and the whole chain
# v145 → latest must not lose a row in any table.
run_harness packages/shared/db-migrations/src/orphan-rows-migration.test.ts
run_harness packages/shared/db-migrations/src/v145-chain-conserves-rows.test.ts
run_harness packages/shared/db-migrations/src/agent-panel-rename-migration.test.ts
run_harness packages/shared/db-migrations/src/ai-config-raw-skill-migration.test.ts
run_harness packages/shared/db-migrations/src/ai-config-slug-migration.test.ts
run_harness packages/shared/db-migrations/src/codex-flags-migration.test.ts
run_harness packages/shared/db-migrations/src/schema-too-new.test.ts
# v51 on a v50 DB, with and without the column already present (drift).
run_harness packages/shared/db-migrations/src/worktree-source-branch-migration.test.ts
run_harness packages/domains/projects/src/server/status-normalization.test.ts
run_harness packages/shared/db-migrations/src/tag-color-dedup-migration.test.ts
# v169 project owner + per-user settings, on an empty and a populated v168 DB.
run_harness packages/shared/db-migrations/src/v169-ownership-migration.test.ts
run_harness packages/shared/db-migrations/src/v171-agent-startup-migration.test.ts
run_harness packages/shared/db-migrations/src/v172-chat-cli-snapshots-migration.test.ts
run_harness packages/shared/db-migrations/src/v173-claude-chat-mode-migration.test.ts
run_harness packages/shared/db-migrations/src/v175-conversation-handoff-fork-origins-migration.test.ts
run_harness packages/shared/db-migrations/src/v177-chat-composer-migration.test.ts
# Quit drains diagnostics (flush THEN close) inside a deadline.
run_harness packages/apps/app/src/main/lifecycle/quit-diagnostics.test.ts
# Quit WAITS for the local hub's and computer's reaps (fire-and-forget orphaned them), bounded.
run_harness packages/apps/app/src/main/lifecycle/quit-reap-child.test.ts
# How both supervisors kill their child: resolves only once it is gone, shared per process.
run_harness packages/apps/app/src/main/child-reaper.test.ts
# The packaged app forces NODE_ENV=production in its first import (dev/e2e keep theirs).
run_harness packages/apps/app/src/main/packaged-node-env.test.ts
run_harness packages/apps/app/src/main/storage-migration.test.ts
run_harness packages/apps/app/src/main/storage-migration-hardening.test.ts
# Channel-scoped migration — flat legacy ~/.slayzone → ~/.slayzone/<channel>/<hub|computer>,
# copy-only (regression guard: a failed copy must never touch the legacy source),
# computer slice is a per-host-file → shared-map TRANSFORM, not a directory copy.
run_harness packages/apps/app/src/main/channel-storage-migration.test.ts
# project-icons/ was in neither allow-list above: own sentinel (reaches users a beta
# already migrated), copy-only, non-fatal. The hub repoints the DB rows afterwards.
run_harness packages/apps/app/src/main/project-icons-migration.test.ts
# Main DB renamed slayzone.sqlite → slayzone.data.sqlite. The in-place rename helper
# (real better-sqlite3, rows living only in the WAL) and the app's whole first-launch
# sequence end to end — the latter pins that a beta hub root's live DB is adopted BEFORE
# the copy migrations can plant an older one at the new name.
run_harness packages/shared/platform/src/adopt-renamed-db.test.ts
run_harness packages/apps/app/src/main/data-paths.test.ts
run_harness packages/domains/projects/src/server/project-icons-relocate.test.ts
# Hidden-window invariant under Playwright. Six call sites open-coded
# restore/show/focus with no PLAYWRIGHT gate, so an e2e spec hitting one stole
# the developer's focus for the rest of that worker's specs (worker-scoped app).
run_harness packages/apps/app/src/main/present-window.test.ts
# App windows show the app, never a website: external main-frame loads open in the browser.
run_harness packages/apps/app/src/main/app-window-navigation-guard.test.ts
# Remote hubs: the app document's /trpc sockets reach the hub with no Origin (native client).
run_harness packages/apps/app/src/main/hub-socket-origin.test.ts
# File-tree copy/paste of files: Electron 44's async clipboard, text/uri-list ⇄ native file refs.
run_harness packages/apps/app/src/main/clipboard-file-paths.test.ts
# Remembered dialog folder: Electron 43 opens a dialog without defaultPath in Downloads.
run_harness packages/apps/app/src/main/dialog-last-dir.test.ts
# Browser-panel extension import list: every Chromium profile, not just Default.
run_harness packages/apps/app/src/main/browser-extension-discovery.test.ts
# Chrome extension ID from manifest key (one copy per extension; Web Store wins).
run_harness packages/apps/app/src/main/extension-id.test.ts
# Dev launcher (dev.mjs) ↔ main: relaunch exit code, shutdown grace > quit watchdog.
run_harness packages/apps/app/src/main/dev-launcher-contract.test.ts
# macOS update manifest: OS-minimum stamp (Electron 44 = macOS 13+) survives the arch merge.
run_harness scripts/release/update-manifest.test.mjs
# Linux glibc-floor release gate (#165): ELF symbol-version parser + floor check.
run_harness scripts/release/check-glibc-floor.test.mjs
# `pnpm lint:trpc-deps`: flags a useMutation() result object bare in a hook dep array
# (by `*Mutation` name and by binding, multi-line arrays included); quiet on stable forms.
run_harness scripts/check-trpc-stable-deps.test.mjs
# `pnpm lint:workspace-cycles`: a dependency edge inside a package cycle must be in the
# baseline, and a baseline edge no longer in a cycle must be removed (shrink-only).
run_harness scripts/check-workspace-cycles.test.mjs
# `pnpm lint:tsconfig-hermetic`: tsconfig include/files/references/paths/extends entries
# and typechecked sources' relative imports resolve inside the package or a workspace
# package it depends on (transitively).
run_harness scripts/check-tsconfig-hermetic.test.mjs
# CI's Turborepo typecheck cache keeps only the current run's entries before it is saved.
run_harness scripts/ci/turbo-cache-prune.test.mjs
# `pnpm lint:theme` (Tailwind sources): every class-bearing module a theme-css shell renders
# sits under an @source path, else its classes are never generated (MediaView bg-popover/90).
run_harness scripts/check-tailwind-sources.test.mjs
# `pnpm lint:theme` (lint-theme.sh): hardcoded color classes in renderer .tsx, and color
# literals in the mobile app outside src/theme.ts, fail; a missing search root fails closed.
run_harness scripts/lint-theme.test.mjs
# `/cap` bearer gate (web-access plan open question #5) — loopback alone must
# NOT get into the desktop's capabilityBridgeRouter; the WS upgrade itself must
# reject a missing/wrong/mismatched-length per-boot token.
run_harness packages/apps/app/src/main/desktop-bridge-server.test.ts
# The per-hub switches that replaced SLAYZONE_MODE: 0|1 only, defaults = the desktop app's hub.
run_harness packages/shared/platform/src/hub-switches.test.ts
# Env scope manifest + sanitizeSpawnEnv — spawn-boundary denylist (fail closed).
run_harness packages/shared/platform/src/env-manifest.test.ts
# Startup deadline shared by the computer and pty-manager: must read output that
# is already waiting before judging a session hung after an event-loop stall.
run_harness packages/shared/platform/src/startup-deadline.test.ts
# Event-loop stall detector: a frozen main thread is reported after it thaws,
# with the stacks / child processes / CPU split that name the cause.
run_harness packages/shared/platform/src/event-loop-stall.test.ts
# Cursor-position/status query+response stripping — shared by pty-manager and the
# computer (spontaneous-/clear regression guard; scope must stay narrow).
run_harness packages/shared/platform/src/device-status-queries.test.ts
# hubUrlFromAddr — authority-only addresses + the scheme from the HOST (loopback → http/ws, else https/wss).
run_harness packages/shared/platform/src/hub-addr.test.ts
# Security audit events on stdout (T-03).
run_harness packages/shared/platform/src/security-log.test.ts
# Real client IP behind a trusted front end (T-22): the resolver, then the built hub.
run_harness packages/shared/platform/src/client-address.test.ts
run_harness packages/apps/hub/src/trusted-proxy.test.ts
# Switch refusals: one audit line + one error shape per refusal.
run_harness packages/shared/platform/src/hub-switch-refusal.test.ts
# The hub's own Convex deployment (T-99): address parsing, the desktop hand-over, and
# the gate that refuses a client-named Convex host; then end to end over tRPC with
# fetch stubbed — refused means nothing was sent.
run_harness packages/shared/platform/src/hub-convex.test.ts
run_harness packages/apps/hub/src/convex-sign-in.test.ts
# Sidecar socket path derives from SLAYZONE_ROOT (<ROOT>/run), override + length fallback.
run_harness packages/apps/hub/src/sidecar-socket-path.test.ts
# Wave-3.5 D5 computer restart-survival — stable port + local-computer dedup (count stays 1 across reboots).
run_harness packages/apps/hub/src/computer-restart-survival.test.ts
# Wave-3.5 loopback join-token mint route (main auto-enroll channel).
run_harness packages/apps/api/src/http/rest-api/computers/join-token.test.ts
# T-19: the REST computer roster is the caller's own (every one for an admin).
run_harness packages/apps/api/src/http/rest-api/computers/list.test.ts
# Loopback operator account routes (`slay hub users`). The routes never touch the DB
# (the hubUsers capability is stubbed).
run_harness packages/apps/api/src/http/rest-api/hub/users.test.ts
run_harness packages/apps/api/src/http/rest-api/hub/web-login.test.ts
run_harness packages/apps/api/src/routers/integrations.test.ts
run_harness packages/domains/integrations/src/server/integrations-switch.test.ts
run_harness packages/domains/integrations/src/server/push-on-edit.test.ts
run_harness packages/domains/worktrees/src/server/worktrees-router.test.ts
# agent-turns suite: async-DB rot fixed (awaits added; snapshotWorktree return adapted
# to {snapshotSha,headSha}). A broken suite counts as FAIL; a known-red one is
# skip_suite'd with a reason.
run_harness packages/domains/agent-turns/src/server/db.test.ts
run_harness packages/domains/agent-turns/src/server/git-snapshot.test.ts
run_harness packages/domains/agent-turns/src/server/turn-tracker.test.ts
run_harness packages/domains/agent-turns/src/server/agent-turns-router.test.ts
run_harness packages/domains/terminal/src/server/chat-router.test.ts
# pty.onData's server-side sessionIds filter — the web-bandwidth fix (§2.6).
run_harness packages/domains/terminal/src/server/pty-router.test.ts
# Transport routers P13 — task + template + artifacts (createCaller contract tests)
run_harness packages/apps/api/src/routers/task.test.ts
# Order/blocker, tag and artifact writes signal notify.onTasksChanged naming their tasks
# (they emitted nothing, so other clients never saw them live); a burst stays merged.
run_harness packages/apps/api/src/routers/task-change-signals.test.ts
run_harness packages/apps/api/src/routers/template.test.ts
run_harness packages/domains/task-artifacts/src/server/artifacts-router.test.ts
# Cross-domain: task+tags+history activity-event recording + cursor pagination.
run_harness packages/apps/api/src/routers/history.test.ts
# Browser onEvent snapshot replay (stuck-loading race fix) — no DB
run_harness packages/domains/task-browser/src/server/router.test.ts
# Desktop bridge replay cache: a browser tab subscribing right after a relayed
# dom-ready/did-stop-loading is replayed THAT state (stale "loading" stranded the overlay).
run_harness packages/apps/hub/src/host-bridge.test.ts
run_harness packages/domains/automations/src/shared/templates.test.ts
run_harness packages/domains/automations/src/shared/types.test.ts
run_harness packages/domains/automations/src/shared/ai.test.ts
run_harness packages/domains/automations/src/server/automations-router.test.ts
run_harness packages/domains/automations/src/server/engine.test.ts
run_harness packages/domains/automations/src/server/engine-switch.test.ts

# Terminal — SGR stripping + WebGL renderer lifecycle
run_harness packages/domains/terminal/src/server/filter-buffer-data.test.ts
run_harness packages/domains/terminal/src/server/stdin-input.test.ts
# Wave-3 remote-computer per-PTY env (loopback vs hub URL + scoped token).
run_harness packages/domains/terminal/src/server/mcp-env.test.ts
run_harness packages/domains/terminal/src/client/webgl-loader.test.ts
# Terminal — downgrade guard: the pinned @xterm/addon-webgl build must carry the
# shared-texture-atlas fix (#6042/#6055). Without it, correcting the atlas on one
# pane scrambles every pane sharing it (CharAtlasCache is module-level).
run_harness packages/domains/terminal/src/client/xterm-atlas-fix.test.ts
# Terminal — the pinned xterm build must carry the ESC[3J fix (#6081): erasing the
# scrollback a user scrolled into releases the viewport to follow output again.
run_harness packages/domains/terminal/src/client/xterm-ed3-scrollback.test.ts
# Terminal — scramble detection signals + paint throttle. Both suites existed and
# passed but were never registered here, so nothing ran them.
run_harness packages/domains/terminal/src/client/scramble-detector.test.ts
run_harness packages/domains/terminal/src/client/paint-throttle.test.ts
run_harness packages/domains/terminal/src/client/terminal-identity.test.ts
# Terminal — boot renderer economy: WebGL only for on-screen terminals under an MRU
# budget, parked (no DOM-renderer stylesheet) otherwise; plus the hidden-terminal
# init queue and the one-round-trip pty.attach (with fallback for older servers).
run_harness packages/domains/terminal/src/client/webgl-budget.test.ts
run_harness packages/domains/terminal/src/client/terminal-init-scheduler.test.ts
run_harness packages/domains/terminal/src/client/open-trace.test.ts
run_harness packages/domains/terminal/src/client/input-gate.test.ts
run_harness packages/domains/terminal/src/client/hibernated-sessions-source.test.ts
run_harness packages/domains/terminal/src/client/early-input.test.ts
# Stuck-'starting' watchdog: waits on a session the backend still holds as starting
# (queued for an agent-start slot) instead of showing it dead.
run_harness packages/domains/terminal/src/client/starting-watchdog.test.ts
# Dead-session overlay text: the exit reason, not a bare (possibly hub-made) code.
run_harness packages/domains/terminal/src/client/exit-description.test.ts
# macOS Option key: Meta vs composed character per keystroke (issue #103 — Option+2
# must type @ on Swedish), checked against measured layouts, not hand-typed ones.
run_harness packages/domains/terminal/src/client/option-as-meta.test.ts
# Terminal — CPR suppression at the parser. Guards the modified-F3 regression: a
# reply and a Shift/Ctrl/Alt+F3 keystroke are byte-identical, so the reply must
# never be generated rather than filtered afterwards. Uses @xterm/headless.
run_harness packages/domains/terminal/src/client/suppress-device-status.test.ts
# Terminal — hub replay buffer: eviction prelude + chunk immutability.
run_harness packages/domains/terminal/src/server/ring-buffer.test.ts
# Terminal — server answers to timing-critical queries (CPR/DA/DSR/OSC), the
# bounded partial-sequence hold, and the OSC catch-all's title exclusion.
run_harness packages/domains/terminal/src/server/sync-query-response.test.ts
# Diagnostics — payload blob offload. Screenshots were silently truncated to 4096
# chars by the redactor, making every recorded scramble event unprovable.
run_harness packages/domains/diagnostics/src/server/payload-blobs.test.ts
# Diagnostics — blob retention. Offloading to disk means row deletion reclaims
# nothing, so blobs need their own age + size bound or they grow forever.
run_harness packages/domains/diagnostics/src/server/blob-retention.test.ts
# Diagnostics — the blob dir is bound by each host, never resolved from ambient env.
# The old lazy require('@slayzone/platform') failed in Electron main every tick.
run_harness packages/domains/diagnostics/src/server/blob-dir.test.ts
# Diagnostics — event-row retention (better-sqlite3). Was
# never registered, which hid every assertion silently reading `undefined` from an
# un-awaited async call.
run_harness packages/domains/diagnostics/src/server/retention.test.ts
# Diagnostics — config push to the desktop. Two processes record into the SAME
# machine-local diagnostics DB from separate config copies; the Settings UI writes
# only the hub's, so without this seam the desktop keeps recording after the user
# turns diagnostics off.
run_harness packages/domains/diagnostics/src/server/config-push.test.ts

# Terminal — state machine + hook-driven input-flip gate (stuck-running-after-/status)
run_harness packages/domains/terminal/src/server/state-machine.test.ts
# Terminal — claude agent TREE ladder: a background subagent must never overwrite
# "the main agent is waiting for your answer" (spinner lied for 37 min).
run_harness packages/domains/terminal/src/server/agent-tree.test.ts
# Terminal — renderer state store reconcile/self-heal. Was never registered here,
# so its 22 assertions only ran if someone happened to invoke the file by hand.
run_harness packages/domains/terminal/src/client/useTerminalStateStore.test.ts
run_harness packages/domains/terminal/src/client/terminal-state-reducer.test.ts
run_harness packages/domains/terminal/src/client/terminal-state-labels.test.ts
# Terminal — idle-close engagement (browser/other-panel interaction keeps agent warm)
run_harness packages/domains/terminal/src/server/engagement.test.ts
run_harness packages/domains/terminal/src/server/session-error-gate.test.ts
# Terminal — PTY exit handling: shell-fallback decision + the computer-routed
# recovery-shell adoption guard (was never registered here, so it never ran).
run_harness packages/domains/terminal/src/server/pty-exit-strategy.test.ts
# Terminal — fresh-vs-resume decision (restart-clobber invariant: known id ⇒ resume)
run_harness packages/domains/terminal/src/server/spawn-conversation.test.ts
run_harness packages/domains/terminal/src/server/claude-transcripts.test.ts
run_harness packages/domains/terminal/src/server/adapters/claude-adapter.test.ts
run_harness packages/domains/terminal/src/server/adapters/antigravity-adapter.test.ts
run_harness packages/domains/terminal/src/server/adapters/hook-driven-modes.test.ts

# Terminal — Codex Chat (codex-chat mode) driver + transport + adapter
run_harness packages/domains/terminal/src/server/agents/codex/codex-app-server-client.test.ts
run_harness packages/domains/terminal/src/server/agents/codex/codex-chat-session.test.ts
run_harness packages/domains/terminal/src/server/adapters/codex-adapter.test.ts

# Terminal — chat transport manager (session lifecycle + liveness watchdog)
run_harness packages/domains/terminal/src/server/runtime/chat-transport-manager.test.ts
run_harness packages/domains/terminal/src/server/runtime/chat-transport-robustness.test.ts
# Spawn CLI-version hint (summarized thinking) + command tasks through the transport (chat plan 3.2 / 3.9).
run_harness packages/domains/terminal/src/server/runtime/chat-transport-command-tasks.test.ts
run_harness packages/domains/terminal/src/server/runtime/chat-transport-chaos.test.ts
run_harness packages/domains/terminal/src/server/chat-events-store.test.ts
run_harness packages/domains/terminal/src/server/chat-tab-state-store.test.ts
run_harness packages/domains/terminal/src/server/runtime/chat-event-splitter.test.ts
run_harness packages/domains/terminal/src/server/runtime/chat-resume-guard.test.ts
run_harness packages/domains/terminal/src/server/runtime/chat-watchdog.test.ts
run_harness packages/domains/terminal/src/server/runtime/chat-outbox.test.ts
run_harness packages/domains/terminal/src/server/runtime/chat-transport-stop.test.ts
run_harness packages/domains/terminal/src/server/runtime/chat-transport-rewind.test.ts
run_harness packages/domains/terminal/src/server/runtime/chat-transport-switch.test.ts
run_harness packages/domains/terminal/src/server/runtime/chat-transport-fork.test.ts
run_harness packages/domains/terminal/src/server/runtime/chat-transport-agent-turn.test.ts
run_harness packages/domains/terminal/src/server/runtime/chat-transport-history.test.ts
run_harness packages/domains/terminal/src/server/runtime/cli-version.test.ts

# Terminal — warm-process pool (per-project gate + adopt-match). Strict+electron:
# pty-manager pulls in `electron`; a fake spawnShell is injected so no real shells spawn.
run_harness packages/domains/terminal/src/server/runtime/warm-process-manager.test.ts
# Terminal — createPty warm-shell adoption branch (fake pty/win/db, no real spawn).
run_harness packages/domains/terminal/src/server/runtime/adopt-pty.test.ts
# exists/write/start must not treat an exited session in its ~100ms drain window
# as live (a Retry raced it; writes landed in the dead pty).
run_harness packages/domains/terminal/src/server/runtime/pty-live.test.ts
# Terminal — createPty main-authoritative resolver wiring (null hint + ledger id ⇒ resume).
run_harness packages/domains/terminal/src/server/runtime/createpty-resolver.test.ts
run_harness packages/domains/terminal/src/server/runtime/live-conversations.test.ts



# Side-car supervisor crash-recovery (slice 2.5.1 HARD GATE). Also stop() as quit
# awaits it, and parent death against the REAL hub bundle (rebuilt on demand): a
# supervised hub never outlives its app; a standalone one is untouched. Three files
# (shared sidecar-server-supervisor-harness.ts) so the real deadlines run in parallel.
run_harness packages/apps/app/src/main/sidecar-server-supervisor.test.ts
run_harness packages/apps/app/src/main/sidecar-server-supervisor-parent-death.test.ts
run_harness packages/apps/app/src/main/sidecar-server-supervisor-real-stop.test.ts

# Local-computer supervisor exit reporting — the computer owns every agent pty, so
# its exits must stay observable (they killed whole fleets silently before). Also
# stop() as quit awaits it, and parent death against the REAL computer bundle
# (rebuilt on demand): a supervised computer never outlives its app.
run_harness packages/apps/app/src/main/local-computer-supervisor.test.ts

# e2e stale-process reaper: must never match the dev app's live computer (doing so
# SIGTERM'd every agent on the machine once per `pnpm test:e2e`).
run_harness packages/apps/app/e2e/fixtures/stale-processes.test.ts

# e2e runtime-dir pruner: only dirs whose owning pid is dead (231 GB of leftovers
# filled the disk); a concurrent group's live worker dirs must survive.
run_harness packages/apps/app/e2e/fixtures/stale-runtime-dirs.test.ts

# node-pty install health (shared by the e2e gate, the computer's spawn errors and
# Doctor): an install that skipped its scripts (pendingBuilds, or a non-executable
# spawn-helper) is named with its fix.
run_harness packages/shared/platform/src/node-pty-install.test.ts
# e2e install-health gate: such an install must stop the run with the fix named.
run_harness packages/apps/app/e2e/fixtures/install-health.test.ts

# Wave 5 — taskEvents bus + REST routes + MCP tools + CLI integration
run_harness packages/domains/task/src/server/events.test.ts
run_harness packages/apps/api/src/http/rest-api/tasks/archive.test.ts
run_harness packages/apps/api/src/http/rest-api/tasks/archive-many.test.ts
run_harness packages/apps/api/src/http/rest-api/tasks/create.test.ts
run_harness packages/apps/api/src/http/rest-api/tasks/delete.test.ts
run_harness packages/apps/api/src/http/rest-api/tasks/unarchive.test.ts
run_harness packages/apps/api/src/http/rest-api/tasks/update.test.ts
# `slay tasks done [--close]`: the done INTENT (project completed column) — not
# PATCH's status-alias resolution. See tasks/done.ts.
run_harness packages/apps/api/src/http/rest-api/tasks/done.test.ts
# Wave-3 CLI cutover — dark hub REST read/CRUD surface consumed by the CLI.
run_harness packages/apps/api/src/http/rest-api/tasks/list.test.ts
run_harness packages/apps/api/src/http/rest-api/tasks/get.test.ts
run_harness packages/apps/api/src/http/rest-api/tasks/search.test.ts
run_harness packages/apps/api/src/http/rest-api/tasks/subtasks.test.ts
run_harness packages/apps/api/src/http/rest-api/tasks/blockers.test.ts
run_harness packages/apps/api/src/http/rest-api/tasks/blocking.test.ts
run_harness packages/apps/api/src/http/rest-api/tasks/blocked.test.ts
run_harness packages/apps/api/src/http/rest-api/tasks/tags.test.ts
run_harness packages/apps/api/src/http/rest-api/tasks/progress.test.ts
run_harness packages/apps/api/src/http/rest-api/tasks/reset-conversation.test.ts
run_harness packages/apps/api/src/http/rest-api/tags/crud.test.ts
run_harness packages/apps/api/src/http/rest-api/projects/list.test.ts
run_harness packages/apps/api/src/http/rest-api/projects/resolve-by-path.test.ts
run_harness packages/apps/api/src/http/rest-api/projects/crud.test.ts
# `slay init` hub-state half: skill rows + the installedVersion content-hash compare.
run_harness packages/apps/api/src/http/rest-api/projects/skills.test.ts
run_harness packages/apps/api/src/http/rest-api/templates/crud.test.ts
run_harness packages/apps/api/src/http/rest-api/panels/crud.test.ts
run_harness packages/apps/api/src/http/rest-api/automations/crud.test.ts
run_harness packages/apps/api/src/http/rest-api/switch-refusal.test.ts
run_harness packages/apps/api/src/http/rest-api/artifacts/list.test.ts
run_harness packages/apps/api/src/http/rest-api/artifacts/crud.test.ts
# Artifact CONTENT transfer — byte-exactness of the streamed create/upload/read
# paths (fixtures are deliberately not valid utf-8, so any string hop shows up).
run_harness packages/apps/api/src/http/rest-api/artifacts/content.test.ts
# Artifact VERSION HISTORY routes (write/append + versions *). Byte-exactness of
# the streamed write/append bodies and the blob-streamed version read, plus the
# `Error [CODE]: …` 400 contract the CLI prints verbatim.
run_harness packages/apps/api/src/http/rest-api/artifacts/versions.test.ts
# Artifact title+content search — the scan reads the blob store, so it can only
# run host-side; asserts the CLI's exact result shape + flag semantics.
run_harness packages/apps/api/src/http/rest-api/artifacts/search.test.ts
run_harness packages/apps/api/src/http/rest-api/agent-hook-attention.test.ts
run_harness packages/apps/api/src/http/mcp-tools/archive-task.test.ts
run_harness packages/apps/api/src/http/mcp-tools/archive-many-task.test.ts
run_harness packages/apps/api/src/http/mcp-tools/create-task.test.ts
run_harness packages/apps/api/src/http/mcp-tools/delete-task.test.ts
run_harness packages/apps/api/src/http/mcp-tools/unarchive-task.test.ts
run_harness packages/apps/api/src/http/mcp-tools/update-task.test.ts
# Warm-pool session → task fallback for MCP tools (mirrors the CLI/REST fallback above).
run_harness packages/apps/api/src/http/mcp-tools/get-current-task-id.test.ts
run_harness packages/apps/api/src/http/mcp-tools/create-subtask.test.ts
run_harness packages/apps/api/src/http/rest-api/tasks/open.test.ts
run_harness packages/apps/api/src/http/rest-api/auth-deep-link.test.ts
run_harness packages/apps/cli/test/tasks-rest.test.ts

# CLI command tests (better-sqlite3 + ESM interop). @dagrejs/dagre (pulled transitively
# via the ai-config barrel) is mocked by the harness config — the real ESM build trips
# Node's require(esm)-in-cycle guard.
run_harness packages/apps/cli/test/db.test.ts
run_harness packages/apps/cli/test/tags.test.ts
run_harness packages/apps/cli/test/templates.test.ts
run_harness packages/apps/cli/test/automations.test.ts
run_harness packages/apps/cli/test/tasks-ext.test.ts
run_harness packages/apps/cli/test/projects-update.test.ts
# Wave-3 CLI read commands routed through REST (hub-aware cutover).
run_harness packages/apps/cli/test/cli-read-rest.test.ts
# Wave-3.5 CLI artifact commands routed through REST — metadata AND content
# (read/create/upload/delete/download), incl. a no-local-database suite.
run_harness packages/apps/cli/test/cli-artifacts-rest.test.ts
# The rest of that cutover: search / update / write / append / versions *. Runs
# entirely with SLAYZONE_ROOT on an EMPTY dir — the hub owns the DB, the blobs and
# the artifact files; the CLI owns none of them. `path` is the one command left
# that opens the DB, and this suite asserts that too.
run_harness packages/apps/cli/test/cli-artifacts-versions-rest.test.ts
# `slay tasks done` (incl. --close) + `slay init` against a hub, with NO local DB.
run_harness packages/apps/cli/test/done-init-rest.test.ts

if [ -n "$LINEAR_API_KEY" ]; then
  run_test_no_loader packages/domains/integrations/src/electron/handlers.integration.linear.test.ts
else
  skip_suite packages/domains/integrations/src/electron/handlers.integration.linear.test.ts \
    "live Linear API: runs only with LINEAR_API_KEY set"
fi
if [ -n "$GITHUB_TOKEN" ]; then
  run_test_no_loader packages/domains/integrations/src/electron/handlers.integration.github.test.ts
else
  skip_suite packages/domains/integrations/src/electron/handlers.integration.github.test.ts \
    "live GitHub API: runs only with GITHUB_TOKEN set"
fi

# Swept in 2026-10-22: these suites existed (most passed untouched) but no runner ran
# them.
run_harness packages/apps/app/src/main/db/v127-disk-migration.test.ts
run_harness packages/apps/app/src/main/raise-fd-limit.test.ts
run_harness packages/apps/cli/test/artifacts-mv.test.ts
run_harness packages/apps/cli/test/hub.test.ts
# A stored hub target (`slay hub use/login`) never retargets a task terminal's task
# commands; break-glass keeps its session apart from the stored target.
run_harness packages/apps/cli/test/hub-target-scope.test.ts
run_harness packages/apps/cli/test/init-skills.test.ts
run_harness packages/apps/cli/test/panels.test.ts
run_harness packages/domains/agent-panels/src/agent-status/useIdleTasks.test.ts
run_harness packages/domains/ai-config/src/client/skill-validation.test.ts
run_harness packages/domains/ai-config/src/client/sync-view-model.test.ts
run_harness packages/domains/automations/src/server/history.test.ts
run_harness packages/domains/diagnostics/src/server/self-heal.test.ts
run_harness packages/domains/integrations/src/server/credentials.test.ts
run_harness packages/domains/integrations/src/server/sync.test.ts
run_harness packages/domains/projects/src/client/useProjectLockGuard.test.ts
run_harness packages/domains/projects-contracts/src/columns.test.ts
run_harness packages/domains/projects-contracts/src/resolve-repo.test.ts
run_harness packages/domains/projects-contracts/src/placements.test.ts
run_harness packages/domains/computers/src/shared/computer-labels.test.ts
run_harness packages/domains/file-editor/src/shared/dir-picker.test.ts
run_harness packages/domains/dialogs/src/useDialogStore.test.ts
run_harness packages/domains/task-browser/src/client/dom-picker.test.ts
run_harness packages/domains/task-browser/src/client/scale.test.ts
run_harness packages/domains/task-terminals/src/client/chat/autocomplete/autocomplete.test.ts
run_harness packages/domains/task-terminals/src/client/chat/autocomplete/cli-custom-commands.test.ts
run_harness packages/domains/task-terminals/src/client/chat/autocomplete/ranking.test.ts
run_harness packages/domains/task-terminals/src/client/chat/attachments/prepare-attachment.test.ts
run_harness packages/domains/task-terminals/src/client/chat/prompt-history.test.ts
run_harness packages/domains/task-terminals/src/client/chat/prompts/prompt-options.test.ts
run_harness packages/domains/task-terminals/src/client/chat/skill-filter.test.ts
run_harness packages/domains/task-terminals/src/client/chat/turn-outline.test.ts
run_harness packages/domains/task-terminals/src/client/chat/tool-cards/parsers.test.ts
run_harness packages/domains/task-terminals/src/client/chat/files-changed/session-file-changes.test.ts
run_harness packages/domains/task-terminals/src/client/chat/diff-comments/format.test.ts
run_harness packages/domains/task-terminals/src/client/chat/palette/chat-palette-commands.test.ts
run_harness packages/domains/task-terminals/src/client/chat/turn-outline-palette.test.ts
run_harness packages/domains/task-terminals/src/client/get-tab-label.test.ts
run_harness packages/domains/task/src/server/ops/create-project-guard.test.ts
run_harness packages/domains/task/src/server/ops/create-warm-reserve.test.ts
run_harness packages/domains/task/src/server/ops/chat-flag-seeding.test.ts
run_harness packages/domains/task/src/server/ops/load-board-rows-position.test.ts
# A task's main-agent spawn props + cwd (worktree > base dir > bound child repo > root),
# shared by the desktop task page and the hub's task.startMainAgent.
run_harness packages/domains/task/src/shared/main-terminal.test.ts
# task.startMainAgent: the hub starts a task's main agent (pty or chat) only when none is
# live, once under concurrent calls, with the cwd resolved on the hub.
run_harness packages/domains/task/src/server/main-agent.test.ts
run_harness packages/domains/task-contracts/src/handoff.test.ts
run_harness packages/domains/task-contracts/src/panel-config.test.ts
run_harness packages/domains/task-contracts/src/reparent-validation.test.ts
run_harness packages/domains/terminal/src/client/chat-timeline.test.ts
run_harness packages/domains/terminal/src/client/turn-file-changes.test.ts
run_harness packages/domains/terminal/src/client/persistent-index.test.ts
# Reducer: token streaming (live state, finalize in place) + command tasks (chat plan 3.2 / 3.9).
run_harness packages/domains/terminal/src/client/chat-timeline-streaming.test.ts
# A streaming tool input as far as it arrived; per-row live block notifications (chat plan 3.2).
run_harness packages/domains/terminal/src/client/partial-json.test.ts
run_harness packages/domains/terminal/src/client/live-blocks.test.ts
run_harness packages/domains/terminal/src/client/useLoopMode.test.ts
run_harness packages/domains/terminal/src/client/web-link-provider.test.ts
run_harness packages/domains/terminal/src/server/adapters/copilot-adapter.test.ts
run_harness packages/domains/terminal/src/server/adapters/encode-submit.test.ts
run_harness packages/domains/terminal/src/server/adapters/gemini-adapter.test.ts
run_harness packages/domains/terminal/src/server/adapters/qwen-adapter.test.ts
run_harness packages/domains/terminal/src/server/agents/claude-code-adapter.test.ts
# One Claude process's task_* frames → command tasks (Bash/Monitor) or sub-agents; task control requests.
run_harness packages/domains/terminal/src/server/agents/claude-command-tasks.test.ts
run_harness packages/domains/terminal/src/server/agents/claude-session-driver.test.ts
run_harness packages/domains/terminal/src/server/agents/claude-session-import.test.ts
run_harness packages/domains/terminal/src/server/agents/claude-content.test.ts
# Stream-format drift check (chat plan 0.5): recorded real-CLI transcripts through the adapter.
run_harness packages/domains/terminal/src/server/agents/claude-stream-drift.test.ts
run_harness packages/domains/terminal/src/server/agents/claude-hook-output.test.ts
run_harness packages/domains/terminal/src/server/files-scan.test.ts
run_harness packages/domains/terminal/src/server/runtime/session-registry.test.ts
run_harness packages/domains/terminal/src/server/shell-env.test.ts
run_harness packages/domains/terminal/src/server/skills.test.ts
run_harness packages/domains/terminal/src/server/commands.test.ts
run_harness packages/domains/terminal-contracts/src/agent-event-handler.test.ts
run_harness packages/domains/terminal-contracts/src/auto-start.test.ts
# The conversation ids a fresh agent spawn passes (desktop terminal + hub startMainAgent).
run_harness packages/domains/terminal-contracts/src/spawn-conversation-ids.test.ts
run_harness packages/domains/terminal-contracts/src/bg-shell-helpers.test.ts
run_harness packages/domains/terminal-contracts/src/chat-effort.test.ts
run_harness packages/domains/terminal-contracts/src/chat-model.test.ts
run_harness packages/domains/terminal-contracts/src/chat-mode.test.ts
run_harness packages/domains/terminal-contracts/src/chat-capabilities.test.ts
run_harness packages/domains/terminal-contracts/src/chat-attachments.test.ts
run_harness packages/domains/terminal-contracts/src/key-sequences.test.ts
run_harness packages/domains/terminal-contracts/src/osc.test.ts
run_harness packages/domains/terminal-contracts/src/terminal-state-labels.test.ts
run_harness packages/domains/worktrees/src/client/CopyFilesDialog.utils.test.ts
run_harness packages/shared/diff-view/src/parse-diff.test.ts
run_harness packages/domains/worktrees/src/client/utils.test.ts
run_harness packages/domains/worktrees/src/server/list-project-repos.test.ts
run_harness packages/domains/worktrees/src/server/remove-worktree.test.ts
run_harness packages/domains/worktrees/src/server/resolve-graph.test.ts
run_harness packages/domains/worktrees/src/server/resolve-graph.visual.test.ts

# Known-red suites, skipped visibly with the reason instead of failing every run. Each
# has a follow-up task; drop the skip_suite line when the suite is fixed.
skip_suite packages/domains/task-terminals/src/client/chat/__perf__/baseline.test.ts \
  "timing benchmark against a committed baseline (machine-dependent); run it with pnpm test:chat:perf"

# jsdom React client suites (vi.mock + JSX + @vitest-environment jsdom) run under the
# app's vitest config, not the node harness config above. The app
# vitest config wires @vitejs/plugin-react with the React Compiler, set up exactly as
# the renderer build runs it (@slayzone/react-compiler-config), so these suites test
# components compiled the way they ship; react-compiler-canary.test.tsx pins that.
# Explicit file paths override vitest's default include glob so only these run.
#
# A few non-jsdom node suites ride along here for other reasons (vi.mock, node:sqlite).
run_vitest_files "vitest (jsdom client suites)" \
  packages/apps/app/src/renderer/src/react-compiler-canary.test.tsx \
  packages/apps/app/src/main/boot-config.test.ts \
  packages/apps/app/src/main/renderer-csp.test.ts \
  packages/apps/app/src/main/debugger-holders.test.ts \
  packages/apps/app/src/main/hub-tokens.test.ts \
  packages/shared/transport/src/client/federation.test.tsx \
  packages/shared/transport/src/client/hubClientCache.test.ts \
  packages/shared/transport/src/client/hubCapabilities.test.ts \
  packages/shared/transport/src/client/runtime.test.ts \
  packages/apps/web-shell/src/window-api.test.ts \
  packages/apps/web-shell/src/hub-health.test.ts \
  packages/shared/transport/src/client/electron-bootstrap.test.ts \
  packages/shared/editor/src/use-artifact-upload.test.tsx \
  packages/shared/transport/src/client/connectDeadlineLink.test.ts \
  packages/shared/transport/src/client/connectPacing.test.ts \
  packages/domains/diagnostics/src/server/boot-steps.test.ts \
  packages/shared/transport/src/client/hubOwnershipStore.test.ts \
  packages/shared/transport/src/client/hubConnection.test.tsx \
  packages/domains/tasks/src/client/useCompleteAndCloseTask.test.tsx \
  packages/domains/search/src/SearchDialog.algorithm.test.ts \
  packages/domains/task/src/client/CreateTaskDialog.test.tsx \
  packages/domains/task/src/client/TaskDetailPage.test.tsx \
  packages/domains/task/src/client/TaskMetadataSidebar.test.tsx \
  packages/domains/task/src/client/terminal-first.test.ts \
  packages/domains/task/src/client/TaskHistoryPanel.test.tsx \
  packages/domains/task/src/client/BlockerDialog.test.tsx \
  packages/domains/task/src/client/taskDetailCache.test.ts \
  packages/domains/task-browser/src/client/useBrowserViewEvents.test.tsx \
  packages/domains/task-browser/src/client/useBrowserFind.test.tsx \
  packages/domains/task-browser/src/client/useBrowserImportUrls.test.tsx \
  packages/domains/task-browser/src/client/DeviceWebview.test.tsx \
  packages/domains/terminal/src/client/useChatSession.test.tsx \
  packages/domains/worktrees/src/server/composite-ops.test.ts \
  packages/domains/worktrees/src/server/gh-pr-for-checkout.test.ts \
  packages/domains/worktrees/src/server/git-push.test.ts \
  packages/domains/worktrees/src/client/pr-task-map.test.ts \
  packages/domains/worktrees/src/server/login-shell-path.test.ts \
  packages/domains/worktrees/src/server/spawn-failure.test.ts \
  packages/domains/worktrees/src/server/branch-queries.test.ts \
  packages/domains/worktrees/src/server/git-watcher.test.ts \
  packages/domains/worktrees/src/server/untracked-diffs.test.ts \
  packages/shared/ui/src/use-stable-poll.test.ts \
  packages/apps/hub/src/fd-watch.test.ts \
  packages/domains/settings/src/client/tabs/HubCard.test.tsx \
  packages/domains/projects/src/client/ProjectLockScreen.test.tsx \
  packages/domains/projects/src/client/useProjectLockState.test.tsx \
  packages/domains/terminal/src/client/BackgroundJobsBanner.test.tsx \
  packages/domains/ai-config/src/client/state-sync-hooks.test.tsx \
  packages/domains/ai-config/src/client/state-sync-components.test.tsx \
  packages/domains/ai-config/src/client/context-manager-slots.test.tsx \
  packages/domains/settings/src/client/tabs/settings-state-sync.test.tsx \
  packages/domains/settings/src/client/UserSettingsDialog.test.tsx \
  packages/domains/settings/src/client/AppearanceContext.test.tsx \
  packages/domains/agent-turns/src/client/useAgentTurns.test.tsx \
  packages/domains/task/src/client/useSharedCardHeights.test.tsx \
  packages/apps/app/src/renderer/src/components/SecondaryTaskWindow.test.tsx \
  packages/apps/app/src/renderer/src/app-shell/project-path-diagnostics.test.tsx \
  packages/apps/renderer-app/src/ExtensionsModal.test.tsx \
  packages/domains/agent-panels/src/agent-status/agent-status-hooks.test.tsx \
  packages/domains/agent-panels/src/global-agent-panel/FloatingGlobalAgentPanel.test.tsx \
  packages/domains/automations/src/client/automation-dialog/AutomationDialog.test.tsx \
  packages/domains/feedback/src/client/FeedbackDialog.test.tsx \
  packages/domains/search/src/SearchDialog.test.tsx \
  packages/domains/file-editor/src/client/SearchPanel.test.tsx \
  packages/domains/file-editor/src/client/CodeEditor.test.tsx \
  packages/apps/app/src/renderer/src/app-shell/useAppShortcuts.home-panels.test.tsx \
  packages/apps/app/src/renderer/src/hooks/useTabLifecycle.test.tsx \
  packages/domains/task-terminals/src/client/chat/useChatPanelKeyboard.test.tsx \
  packages/domains/task-terminals/src/client/chat/files-changed/files-changed.test.tsx \
  packages/shared/diff-view/src/DiffView.line-action.test.tsx \
  packages/domains/task-terminals/src/client/chat/diff-comments/diff-comments.test.tsx \
  packages/domains/task-terminals/src/client/chat/RewindPicker.test.tsx \
  packages/domains/worktrees/src/client/ConflictFileView.test.tsx \
  packages/shared/layout/src/SplitDivider.test.tsx \
  packages/domains/file-editor/src/client/SearchableCodeView.test.tsx \
  packages/domains/task-browser/src/client/useBrowserViewLifecycle.test.tsx \
  packages/domains/task/src/client/task-detail/usePersistenceSaves.test.tsx \
  packages/domains/file-editor/src/client/useFileTreeData.test.tsx \
  packages/domains/onboarding/src/client/CliInstallStep.test.tsx \
  packages/domains/onboarding/src/client/OnboardingDialog.test.tsx \
  packages/domains/onboarding/src/client/tutorial/TutorialAnimationModal.test.tsx \
  packages/domains/tags/src/client/CreateTagDialog.test.tsx \
  packages/domains/telemetry/src/client/TelemetryProvider.test.tsx \
  packages/domains/telemetry/src/client/telemetry.test.ts \
  packages/domains/telemetry/src/client/useTrack.test.tsx \
  packages/domains/leaderboard/src/convexAuth.test.tsx \
  packages/domains/leaderboard/src/LeaderboardPage.test.tsx \
  packages/shared/editor/src/ArtifactPicker.test.tsx \
  packages/shared/editor/src/rich-text-editor.mention.test.tsx \
  packages/shared/editor/src/rich-text-editor.tab-switch.test.tsx \
  packages/domains/projects/src/client/ProjectSettingsDialog.test.tsx \
  packages/domains/projects/src/client/project-settings-reseed.test.tsx \
  packages/domains/integrations/src/client/useIntegrationsTab.test.tsx \
  packages/domains/integrations/src/client/ProjectIntegrationConnectionModal.test.tsx \
  packages/domains/integrations/src/client/useStatusSyncLockLookup.test.ts \
  packages/domains/task-artifacts/src/client/useArtifacts.test.tsx \
  packages/domains/task-browser/src/client/useBrowserPickElement.test.tsx \
  packages/domains/task-terminals/src/client/chat/autocomplete/useAutocomplete.test.tsx \
  packages/domains/task-terminals/src/client/chat/renderers.collapse.test.tsx \
  packages/domains/task-terminals/src/client/chat/useChatSearch.test.tsx \
  packages/domains/task-terminals/src/client/chat/useChatDisplay.test.tsx \
  packages/domains/task-terminals/src/client/chat/chat-ui-components.test.tsx \
  packages/domains/task-terminals/src/client/chat/conversation-actions.test.tsx \
  packages/domains/task-terminals/src/client/chat/useChatLifecycle.test.tsx \
  packages/domains/task-terminals/src/client/chat/useChatMode.test.tsx \
  packages/domains/task-terminals/src/client/chat/useFollowBottom.test.tsx \
  packages/domains/task-terminals/src/client/chat/useChatComposer.test.tsx \
  packages/domains/task-terminals/src/client/chat/attachments/useChatAttachments.test.tsx \
  packages/domains/task-terminals/src/client/chat/UserMessageAttachments.test.tsx \
  packages/domains/task-terminals/src/client/chat/composer-state/useChatDraftPersistence.test.tsx \
  packages/domains/task-terminals/src/client/chat/composer-state/useChatScrollMemory.test.tsx \
  packages/domains/task-terminals/src/client/chat/ChatComposer.test.tsx \
  packages/domains/task-terminals/src/client/chat/ChatQueueList.test.tsx \
  packages/domains/task-terminals/src/client/chat/renderers.prompts.test.tsx \
  packages/domains/task-terminals/src/client/chat/tool-cards/tool-cards.test.tsx \
  packages/domains/task-terminals/src/client/chat/tool-cards/BashCard.test.tsx \
  packages/domains/task-terminals/src/client/chat/ChatTimeline.streaming.test.tsx \
  packages/domains/task-terminals/src/client/chat/ChatTimeline.codex.test.tsx \
  packages/domains/task-terminals/src/client/chat/virtual-timeline.test.tsx \
  packages/domains/task-terminals/src/client/chat/row-ui-state.test.tsx \
  packages/domains/task-terminals/src/client/chat/timeline-reveal.test.tsx \
  packages/domains/task-terminals/src/client/chat/ChatTurnOutline.test.tsx \
  packages/domains/task-terminals/src/client/chat/prompts/PromptDock.test.tsx \
  packages/domains/task-terminals/src/client/useTaskTerminals.test.tsx \
  packages/domains/task-terminals/src/client/agent-sessions/TaskSessionsSource.test.tsx \
  packages/domains/task-terminals/src/client/agent-sessions/family-sessions.test.ts \
  packages/domains/task/src/client/ProcessDialog.test.tsx \
  packages/domains/task/src/client/ProcessesPanel.test.tsx \
  packages/domains/task/src/client/task-detail/useTaskTitleEditing.test.tsx \
  packages/domains/task/src/client/task-detail/useTaskTerminalSession.test.tsx \
  packages/domains/task/src/client/task-detail/useDevServerDetection.test.tsx \
  packages/domains/task/src/client/usePanelOwnership.test.tsx \
  packages/domains/app-shell/src/client/useExplodeMode.test.tsx \
  packages/domains/home/src/client/useHomePanelVisibility.test.tsx \
  packages/domains/usage-analytics/src/client/useUsageAnalytics.test.tsx \
  packages/domains/task/src/client/TaskProgressPopover.test.tsx \
  packages/domains/task/src/client/WebPanelView.test.tsx \
  packages/domains/tasks/src/client/useKanbanSelectionKeyboard.test.tsx \
  packages/domains/tasks/src/client/KanbanListView.test.tsx \
  packages/domains/terminal/src/client/PtyContext.test.tsx \
  packages/domains/terminal/src/client/TerminalDeadOverlay.test.tsx \
  packages/domains/terminal/src/client/TerminalStartError.test.tsx \
  packages/domains/terminal/src/client/TerminalSearchBar.test.tsx \
  packages/domains/terminal/src/client/TerminalStatusPopover.test.tsx \
  packages/domains/terminal/src/client/useTerminalModes.test.tsx \
  packages/domains/worktrees/src/client/CopyFilesDialog.test.tsx \
  packages/domains/worktrees/src/client/useBranchGraph.test.tsx \
  packages/domains/worktrees/src/client/ConflictPhaseContent.test.tsx \
  packages/domains/worktrees/src/client/useConsolidatedGeneralData.test.tsx \
  packages/domains/worktrees/src/client/useConsolidatedGeneralData.poll.test.tsx \
  packages/domains/worktrees/src/client/ProjectGeneralTab.test.tsx \
  packages/domains/test-panel/src/client/TestsTab.test.tsx \
  packages/domains/worktrees/src/client/ProjectGeneralTab.fresh.test.tsx \
  packages/domains/worktrees/src/client/useGitMergeActions.test.tsx \
  packages/domains/worktrees/src/client/CreatePrDialog.test.tsx \
  packages/domains/worktrees/src/client/ProjectPrTab.test.tsx \
  packages/domains/worktrees/src/client/useGitDiffData.test.tsx \
  packages/domains/worktrees/src/client/useGitDiffSelectionTurns.test.tsx \
  packages/domains/worktrees/src/client/useGitPanelTabs.test.tsx \
  packages/domains/file-editor/src/client/WorkspaceDirPicker.test.tsx \
  packages/domains/settings/src/client/tabs/HubsSettingsTab.test.tsx \
  packages/domains/settings/src/client/settings-reopen.test.ts \
  packages/domains/settings/src/client/useSettingsReopenTab.test.tsx \
  packages/domains/task/src/client/ComputerCard.test.tsx \
  packages/domains/projects/src/client/GeneralTab.test.tsx \
  packages/shared/settings-core/src/server/service.test.ts \
  packages/shared/settings-core/src/server/scope.test.ts \
  packages/domains/projects/src/server/project-access.test.ts \
  packages/apps/hub/src/auth-db.test.ts \
  packages/apps/api/src/http/rest-api/agent-hook.test.ts \
  packages/apps/hub/src/agent-hook-relay-consumer.test.ts \
  packages/apps/api/src/http/rest-api/agent-hook-prompt-capture.test.ts \
  packages/apps/app/src/main/agent-hooks/hook-execution.test.ts \
  packages/apps/app/src/main/agent-hooks/hook-roundtrip.test.ts \
  packages/apps/app/src/main/agent-hooks/notify-script-gemini.test.ts \
  packages/apps/app/src/main/agent-hooks/opencode-plugin-behavior.test.ts \
  packages/domains/computer-transport/src/server/exec-proxies.test.ts \
  packages/domains/computer-transport/src/server/exec-proxies-chat.test.ts \
  packages/apps/computer/src/ring-buffer.test.ts \
  packages/apps/api/src/scopes.test.ts \
  packages/apps/api/src/settings-admin.test.ts \
  packages/apps/api/src/trpc.test.ts \
  packages/shared/trpc-server/src/trpc-transformer.test.ts \
  packages/domains/hub-auth/src/server/entra.test.ts \
  packages/domains/hub-auth/src/server/password.test.ts

# Swept in 2026-10-22: vitest suites (jsdom / vi.mock) that no runner ran.
run_vitest_files "vitest (swept-in suites)" \
  packages/apps/app/src/main/browser-link-context-menu.test.ts \
  packages/apps/app/src/main/browser-view-keys.test.ts \
  packages/apps/app/src/main/browser-view-nav-focus-guard.test.ts \
  packages/apps/app/src/main/floating-global-agent-panel/state-machine.test.ts \
  packages/apps/app/src/preload/browser-link-task-capture.test.ts \
  packages/apps/app/src/renderer/src/components/ErrorBoundary.test.tsx \
  packages/apps/app/src/renderer/src/components/dialogs/CliInstallDialog.test.tsx \
  packages/domains/automations/src/client/AutomationCard.test.tsx \
  packages/domains/file-editor/src/client/useFileEditor.test.ts \
  packages/domains/file-editor/src/client/useWatchedFile.test.ts \
  packages/domains/projects/src/client/TasksGeneralTab.test.tsx \
  packages/domains/task-terminals/src/client/focus-handoff.test.ts \
  packages/domains/task/src/client/TaskDetailDataLoader.test.tsx \
  packages/domains/task/src/client/TaskSettingsPanel.test.tsx \
  packages/domains/task/src/client/createTaskFormDefaults.test.ts \
  packages/domains/task/src/client/usePanelSizes.test.ts \
  packages/domains/task-contracts/src/create-task-draft.test.ts \
  packages/domains/worktrees/src/client/git-diff-store.test.ts \
  packages/shared/diff-view/src/highlight.test.ts \
  packages/shared/diff-view/src/parse-diff.cache.test.ts \
  packages/domains/worktrees/src/shared/worktree-color.test.ts \
  packages/shared/editor/src/milkdown-link-click.test.ts \
  packages/shared/editor/src/milkdown-task-list.test.ts \
  packages/shared/suspense/src/suspense-cache.test.tsx \
  packages/shared/transport/src/client/hubRegistryStore.test.ts \
  packages/apps/api/src/txns/txns.test.ts

# tasks-changed refresh: per-subscriber burst coalescing, board row patching, the
# per-task query refresh that defers hidden tabs until they are revealed, the one
# shared panel config, and the first-paint theme cache.
run_vitest_files "vitest (tasks-changed refresh)" \
  packages/shared/notify/src/server/notify-coalescer.test.ts \
  packages/domains/tasks/src/client/board-patch.test.ts \
  packages/domains/task/src/client/taskScopedQueries.test.tsx \
  packages/domains/task/src/client/usePanelConfig.test.tsx \
  packages/domains/settings/src/client/theme-cache.test.ts

# Boot idle hydration: hidden task tabs mount their detail page one per idle slice
# (queue order, readiness gating, permanence), and task events that arrive before
# a tab's page is mounted are held for it.
run_vitest_files "vitest (boot idle hydration)" \
  packages/apps/app/src/renderer/src/app-shell/pane-hydration.test.ts \
  packages/apps/app/src/renderer/src/app-shell/trigger-dedupe.test.ts \
  packages/apps/app/src/renderer/src/lib/bootTimings.test.ts \
  packages/domains/task/src/client/taskPaneEvents.test.ts

# The account-role gate (T-15): tRPC + REST + MCP classification and refusals, and the
# hub's open REST routes.
run_vitest_files "vitest (role gate)" \
  packages/apps/api/src/admin-policy.test.ts \
  packages/apps/hub/src/admin-authz.test.ts

# The owner-check classification (T-17): every user procedure marked, exhaustively.
run_vitest_files "vitest (owner checks)" \
  packages/apps/api/src/owner-policy.test.ts \
  packages/apps/api/src/http-owner-policy.test.ts \
  packages/apps/api/src/http/rest-api/agent-hook-owner.test.ts

# The computer is a separate app with its OWN vitest config (node environment, no
# jsdom). Its handler suites — pty/proc/fs/git/project/gh/computer-config — were never
# in this aggregate, so they only ran if someone happened to run the package directly.
# Listing the files under the app's jsdom config is not a substitute:
# `fs.watch({recursive:true})` never delivers there, at any timeout. Run each
# package's own suite instead. Proven on Linux (ubuntu 24.04) before CI ran it: that
# run found proc.kill leaking a shell's children (dash forks a lone command).
# Includes the hub⇄computer round trips (handlers/{proc,fs,chat}-roundtrip.test.ts):
# the real computer handlers wired to the real hub-side transport, so they live in the
# computer, which depends on @slayzone/computer-transport (never the reverse).
run_package_tests packages/apps/computer @slayzone/computer

# The hub-side transport's own suites, under the same node-environment default config.
run_package_tests packages/domains/computer-transport @slayzone/computer-transport

# The computers DOMAIN suite (store, join-tokens, migration) was never registered
# here, so three files' worth of assertions had gone stale unnoticed — the
# migration test was asserting a column list two migrations out of date. Includes
# `project-paths.test.ts`: the hub's MIRROR of computer-reported paths, on the v149
# table that modelled this and was never wired. Pins that a report replaces a
# computer's rows wholesale (a stale row would be trusted by reverse lookup) and that
# `resolve-by-path` still answers from the legacy column during the upgrade window.
run_package_tests packages/domains/computers @slayzone/computers

# hub-auth (node:sqlite, real better-auth) and platform (shell primitives, hook
# installers) have their own vitest configs; platform's runs under plain node (CI's
# Windows job), so it excludes its Electron-node suites, registered with run_harness above.
run_package_tests packages/domains/hub-auth @slayzone/hub-auth
run_package_tests packages/shared/platform @slayzone/platform
# Packages whose own `vitest run` was green but never aggregated (swept in 2026-10-22).
run_package_tests packages/domains/task-artifacts @slayzone/task-artifacts
run_package_tests packages/shared/layout @slayzone/layout
run_package_tests packages/shared/markdown @slayzone/markdown
run_package_tests packages/shared/shortcuts @slayzone/shortcuts
run_package_tests packages/shared/ui @slayzone/ui
# Theme presets + the colour converter the mobile app paints with: every preset colour
# must convert (themes.test.ts), and the choice resolution desktop and mobile share.
run_package_tests packages/shared/theme-tokens @slayzone/theme-tokens
# The mobile app's React Native components (jest-expo's iOS preset + Testing Library), in
# Node, no simulator. The app's platform-free logic shared with desktop runs in its own
# package's vitest suites.
run_jest_package_tests packages/apps/mobile @slayzone/mobile

# Security headers on every hub response (T-25): the header logic, and the built hub
# through each handler (shell, assets, better-auth, REST, 404, /trpc, /health).
run_harness packages/apps/hub/src/security-headers.test.ts
run_harness packages/apps/hub/src/security-headers-served.test.ts

# Break-glass v2 (O-9/O-23): grant over the local socket, one-time redemption, the REST
# allowlist, TTL / end / boot closing, over real hub-auth + app DB; and the computer
# revoke route it uses (hub-auth's account half runs in its package suite).
run_harness packages/apps/hub/src/break-glass.test.ts
run_harness packages/apps/api/src/http/rest-api/hub/computers.test.ts

# Flood limits (T-26): the hub's front-door limits (web-login, break-glass redemption,
# /trpc upgrades). better-auth's limiter and the /computers caps run in their packages.
run_harness packages/apps/hub/src/flood-limits.test.ts
# better-auth /api/auth/* body cap: declared length ≤ 64 KiB (413), chunked refused (411).
run_harness packages/apps/hub/src/auth-body-limit.test.ts
# The hub defaults an unset NODE_ENV to production in its first import.
run_harness packages/apps/hub/src/default-node-env.test.ts

# Web shell sign-in and sign-out through Entra (T-13): the session routes over real
# hub-auth + app DB, and the shell's cookie-only session (hub-auth's web sign-in runs in
# its package suite above).
run_harness packages/apps/hub/src/web-session-routes.test.ts
run_vitest_files "vitest (web shell session, T-13)" \
  packages/apps/web-shell/src/web-session-storage.test.ts \
  packages/apps/web-shell/src/web-session.test.ts \
  packages/apps/web-shell/src/sign-in-error.test.ts \
  packages/apps/web-shell/src/LoginScreen.test.tsx

# Runtime-imports build guard: every module a shipped Node bundle resolves at runtime
# must resolve where it runs. A `require('@slayzone/platform')` Rollup left unbundled
# in out/main failed on every diagnostics retention tick.
run_harness packages/shared/build-guards/runtime-imports.test.ts
# Sidecar dev watcher: rebuild hub/computer bin.cjs on ANY bundled input change,
# incl. inlined workspace server code outside the package's own src/.
run_harness packages/shared/build-guards/watch-inputs.test.ts

# Everything registered above runs here, in concurrent lanes (see runners.sh): the node
# harness runs, ONE vitest run over every run_vitest_files group, and the package runs.
run_suites

# Every test file in every package must be run or skipped above, file by file or as
# part of a package run. Without this, 75 test files had drifted out of every runner
# (and most out of typecheck too) and rotted unnoticed.
# shellcheck disable=SC2046
require_registered $(find packages -mindepth 2 -maxdepth 2 -type d | sort)

print_summary
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

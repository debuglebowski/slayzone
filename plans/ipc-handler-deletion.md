# Plan: Delete dead domain IPC handler files

## Goal
Remove the ~323 `ipcMain.handle` calls across 15 `packages/domains/*/src/electron/handlers.ts` files. They are **dead in production** (replaced by tRPC) and only kept alive by **vitest unit tests** that exercise domain logic through the IPC-handler indirection. End state: domain logic is tested at the **tRPC router** layer; handler files + the `ipc-harness` shim are gone.

## Verified findings (this session)
- **Prod**: no `register*Handlers` fn is imported or called in `packages/apps/app/src/main/index.ts` or any non-test path. All 15 are dead in prod.
- **e2e (Playwright)**: `__testInvoke` is used in 19 files, but only for 5 infra channels — `e2e:get-env`, `e2e:get-mcp-port`, `e2e:spy-app-dep`, `app:get-sidecar-status`, `app:reset-for-test` — plus the `if(isPlaywright)` block in `index.ts` (`shell:open-external`, `shell:open-path`, `auth:github-system-sign-in`). **Zero domain channels.** e2e does NOT block deletion. (Earlier analysis claiming e2e drives domain handlers was wrong.)
- **Unit tests (vitest)**: ~24 `*.test.ts` files call `register*Handlers(h.ipcMain as never, h.db)` against a mock `ipcMain` from `packages/shared/test-utils/ipc-harness.js`, then `h.invoke('channel', args)` and assert. **This is the only thing keeping handler files referenced.**
- **Handlers are thin wrappers**: e.g. `registerTaskHandlers` binds channels → `*Op` fns in `server/ops/`. Same ops the tRPC routers call. Logic lives in `server/ops/`, not handler bodies.
- **Migration target exists**: every domain has a tRPC router in `packages/shared/transport/src/server/routers/`. The contract-test pattern is established — `router.createCaller(ctx)` + `setXDeps({ ops })` + shared `createTestHarness()`. Existing router tests: `task`, `worktrees`, `agent-turns`, `template`, `artifacts`, `chat`, `app.browser-events`.

## What stays (NOT in scope — prod IPC that can't move)
- Bootstrap IPC (~7 ch): `app:get-server-url`, `app:relaunch`, `app:set-boot-settings`, `app:probe-server-health`, `app:get-window-id`, `app:data-ready`, `boot:mark`.
- Browser preload (2 ch): `browser:request-create-task-from-link`, `browser:request-open-link-externally`.
- `webContents.send` event broadcast (new unidirectional-events arch, not legacy).
- `if(isPlaywright)` test bridges + the 5 `e2e:*`/`app:*` infra channels.

## Per-domain migration map

| Domain | handler file handles | handler test files | router | router test exists? | action |
|---|---|---|---|---|---|
| usage-analytics | 3 | 0 | usage-analytics.ts | — | **delete handler now** |
| feedback | 6 | 0 | feedback.ts | — | **delete handler now** |
| terminal/pty | 1 | 0 | pty.ts | — | **delete handler now** |
| ai-config | 54 | 6 (selections, skills-merging, marketplace-sync, skills-status, items, context) | ai-config.ts | NO | port 6 → router test (biggest gap) |
| integrations | 43 | 5 (linear, github, analyze*, api, db) | integrations.ts | NO | port 5 → router test (*analyze calls registerWorktreeHandlers) |
| task | 56 | 4 (handlers, temp-cleanup, history**, template-handlers) | task.ts | YES | extend task/template router tests; **history.test also covers tags+history** |
| worktrees | 86 | 2 (electron/handlers, server/copy-files) | worktrees.ts | YES | extend router test to cover gaps |
| settings | 3 | 1 | settings.ts | NO | port → router test |
| projects | 14 | 1 | projects.ts | NO | port → router test |
| task-terminals | 8 | 1 | task-terminals.ts | NO | port → router test |
| tags | 9 | 1 (+ via task/history.test) | tags.ts | NO | port → router test |
| file-editor | 15 | 1 | file-editor.ts | NO | port → router test |
| automations | 10 | 1 | automations.ts | NO | port → router test |
| agent-turns | 1 | 1 | agent-turns.ts | YES | verify coverage, drop handler test |
| history | 2 | (via task/history.test) | history.ts | NO | covered when task/history ported |

## Task outliers (decided: extract to ops + test ops)
Some `task` handlers do MORE than delegate to ops:
- artifact watcher init (`startArtifactWatcher`, `initArtifactWatcherBroadcast`)
- artifact downloads (`downloadArtifact*` — PDF/PNG/HTML/zip)
- `dataRoot` path resolution
Plan: pull this logic into `server/ops` (or `server/artifact-*`) fns with their own unit tests, so the router/ops layer owns it and no handler-only logic survives. The `artifacts` router test already exists — extend it where it covers the same surface.

## Sequence (tests-first, reversible)
1. **Phase 0 — free deletions**: delete `usage-analytics`, `feedback`, `terminal/pty` handler files (zero test deps). Confirm typecheck + build green.
2. **Phase 1 — coverage port**: for each remaining domain, ensure its router contract test covers what the handler test covered. Build a channel→proc map per domain (derive from `handlers.ts` + `routers/<domain>.ts`). Add/extend `routers/<domain>.test.ts`. Net-new tests for: ai-config, integrations, settings, projects, task-terminals, tags, file-editor, automations. Extend: task, worktrees.
3. **Phase 2 — task outliers**: extract watcher/download/dataRoot logic to ops, test at ops/artifacts-router level.
4. **Phase 3 — delete**: once router tests green and cover parity, delete the 15 handler files + their `*.test.ts` handler tests. Delete `packages/shared/test-utils/ipc-harness.js` if no longer referenced (it's also used by router tests — KEEP if still used; verify).
5. **Phase 4 — cleanup**: fix stale comment `index.ts:1817` ("registerPtyHandlers still live below" = false). Remove any now-dead `export {}` re-exports of `register*Handlers` from domain barrels.

## Verification per phase
- `pnpm typecheck` + domain-scoped vitest after each domain port.
- `pnpm build` (prod) after deletions — local typecheck can hide module-resolution breaks.
- e2e unaffected (no domain-channel dependency) — but run full e2e once after Phase 3 as backstop.

## Risks / watch-items
- `ipc-harness.js` is shared by BOTH handler tests AND router tests (router tests import `createTestHarness`). Do NOT delete it blindly — only the handler-driving parts (`h.ipcMain`, `h.invoke`) may become unused. Audit before removing.
- Parity gap: handler test may assert behaviors the router proc doesn't expose 1:1 (e.g. a channel with no proc). Any such channel is a real blocker — surface it, don't silently drop coverage.
- Cross-domain handler tests (`integrations/handlers.analyze.test.ts` calls `registerWorktreeHandlers`; `task/history.test.ts` registers task+tags+history) — port these as a unit, not per-file.
- Migration runner: router tests run via electron + experimental-loader (`test-utils/run-all.sh`), not plain vitest — match that harness.

## Unresolved Qs
- `ipc-harness.js`: keep (router tests use it) or split into a tRPC-only harness? Confirm what router tests actually import before deciding.
- Any channel lacking a 1:1 tRPC proc = hard blocker. Build the full channel→proc map in Phase 1 and list misses before deleting anything.
- Delete handler `*.test.ts` files outright, or keep a thin smoke test pointing at ops during transition?
- Scope: all 15 domains this effort, or land Phase 0 + 1-2 domains as a proof, then batch the rest?

# E2E Test Isolation: Per-File Reset

## Why this document exists

SlayZone's 67 E2E test files share a single Electron instance and SQLite database with no cleanup between files. Data accumulates across the full suite, creating implicit ordering dependencies. You cannot run test 58 without first running tests 01-57. If an earlier test fails or is skipped, downstream tests that rely on its data break silently or unpredictably.

This makes the test suite fragile, slow to debug, and impractical for focused development — running a single test to validate a change requires running the entire suite up to that point.

This doc proposes a per-file reset mechanism that gives each test file a clean slate while keeping the shared Electron instance for performance.

## Current state (as of 2026-03-08)

### Test infrastructure
- **67 numbered test files** (`01-smoke.spec.ts` through `67-leaderboard-auth.spec.ts`) in `packages/apps/app/e2e/`
- **Playwright config**: `workers: 1`, `fullyParallel: false` — strict sequential execution
- **Shared Electron instance**: Worker-scoped fixture in `e2e/fixtures/electron.ts` launches one Electron app per worker, reused for all 67 files
- **Shared SQLite DB**: Created once per worker in a temp directory (`SLAYZONE_DB_DIR`), never wiped between files
- **Fixtures**: `electron.ts` (core), `terminal.ts` (PTY helpers), `context-manager.ts` (settings dialog helpers)

### Data lifecycle
- Tests create data via `seed()` helper (calls `window.api.*` through `page.evaluate`)
- Each `test.describe` block typically has a `beforeAll` that seeds its own projects/tasks
- Data from earlier tests persists — later tests can see and interact with it
- No `afterAll` cleanup in any test file
- DB only destroyed when the worker finishes and the temp directory is cleaned up

### Known dependency chain examples
- `03-projects.spec.ts` creates "Second Project"
- `04-tasks-crud.spec.ts` searches for "Second Project" — fails if 03 is skipped
- Tests using unique 2-letter project abbreviations can collide if prefixes overlap
- Terminal tests leave PTY sessions running; later tests may encounter stale sessions

### Stateful main-process services
The Electron main process holds significant state beyond the database:

| Service | File | State | Impact |
|---------|------|-------|--------|
| PTY Manager | `terminal/src/main/pty-manager.ts` | `sessions` Map, `activeNotifications` Map, `idleCheckerInterval` | Running child processes, 5MB buffers each |
| Process Manager | `app/src/main/process-manager.ts` | `processes` Map, `logSubscribers` Map | Background child processes |
| MCP Server | `app/src/main/mcp-server.ts` | HTTP server, `transports` Map, `idleTimer` | Bound port, active connections |
| File Watchers | `file-editor/src/main/handlers.ts` | `watchers` Map (FSWatcher), `ignoreCache` Map | Open file handles, debounce timers |
| Integration Sync | `integrations/src/main/sync.ts` | `syncRunning`, `discoveryRunning` booleans | Blocks concurrent syncs if left true |
| Main index | `app/src/main/index.ts` | `linearSyncPoller`, `discoveryPoller`, `mcpCleanup`, `oauthCallbackWaiters` | Interval timers, stale callbacks |
| Auto-Backup | `app/src/main/backup.ts` | `autoBackupTimer` | Periodic disk writes |
| Browser Registry | `app/src/main/browser-registry.ts` | `registry` Map | Stale webContents references |

All of these are only cleaned up at `app.on('will-quit')` — never between tests.

### Existing cleanup patterns
- `app.on('will-quit')` calls `killAllPtys()`, `killAllProcesses()`, `stopIdleChecker()`, `stopAutoBackup()`, `closeDatabase()`, etc.
- `seed().deleteAllProjects()` exists but is rarely used
- `dismissOnboardingIfPresent()` handles fresh-DB onboarding dialog
- `__testInvoke` bridge exposed in preload when `PLAYWRIGHT=1` for arbitrary IPC calls from renderer

### Unit tests (for comparison)
Unit tests are fully isolated — each file creates a fresh in-memory SQLite DB via `createTestHarness()`, no cross-file imports, no shared state. This is the gold standard we want to approximate for E2E.

## Problems with current architecture

1. **Can't run tests in isolation.** Running test 58 requires tests 01-57. Debugging a single test failure means waiting for the full suite.

2. **Cascading failures.** If test 03 fails, test 04 fails too (missing data), which may cause 05 to fail (unexpected state), creating a chain reaction that obscures the root cause.

3. **Implicit contracts.** Tests rely on data created by other test files without any explicit dependency declaration. These contracts are invisible and break silently when tests are reordered or modified.

4. **Stale process state.** PTY sessions, file watchers, and interval timers from earlier tests linger and can interfere with later tests. A terminal test leaving a PTY running can cause a later terminal test to see unexpected sessions.

5. **Can't parallelize.** Even if we wanted to run tests in parallel (multiple workers), the shared DB and ordering dependencies make it impossible without isolation first.

6. **Slow feedback loop.** Developers must run the full suite or guess which subset of prior tests to run, slowing iteration significantly.

## Design decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Keep shared Electron instance? | Yes | Cold start is ~3-5s. Starting 67 times = 3-5 min of pure overhead. Unacceptable. |
| Reset mechanism | IPC handler `app:reset-for-test` | Runs in main process where all state lives. Callable from test via `__testInvoke`. |
| DB reset strategy | Drop all tables + re-migrate | Simpler than truncating (no need to enumerate tables correctly). Guarantees clean schema. ~50ms. |
| Restart pollers/timers after reset? | No | Keep stopped. Tests that need sync/MCP start them explicitly. Avoids interference. |
| Renderer reload | `page.reload()` after IPC completes | Clears all React state, re-initializes from fresh DB. |
| Opt-in vs automatic | Opt-in via `resetApp()` in `beforeAll` | Allows incremental migration. Tests not yet converted keep working. |
| File naming | Keep numbered files | Renaming 67 files is churn with no functional benefit. Numbers become meaningless (good — they shouldn't imply ordering). |
| Diagnostics DB | Leave it | Useful for debugging across test runs. Not a source of test pollution. |

## Proposed implementation

### Phase 1: Add cleanup exports to stateful domains

Each domain that holds main-process state exports a reset function:

| File | Export | What it does |
|------|--------|-------------|
| `domains/file-editor/src/main/handlers.ts` | `closeAllWatchers()` | Close all FSWatcher instances, clear debounce timeouts, clear `ignoreCache` |
| `app/src/main/browser-registry.ts` | `clearBrowserRegistry()` | `registry.clear()` |
| `domains/integrations/src/main/sync.ts` | `resetSyncFlags()` | `syncRunning = false`, `discoveryRunning = false` |
| `domains/terminal/src/main/pty-manager.ts` | `resetPtyState()` | `killAllPtys()` + clear `activeNotifications` |

### Phase 2: Add `app:reset-for-test` IPC handler

In `packages/apps/app/src/main/index.ts`, guarded by `if (isPlaywright)`:

```ts
ipcMain.handle('app:reset-for-test', async () => {
  // 1. Kill running processes
  resetPtyState()
  killAllProcesses()

  // 2. Stop timers
  stopIdleChecker()
  stopAutoBackup()
  if (linearSyncPoller) { clearInterval(linearSyncPoller); linearSyncPoller = null }
  if (discoveryPoller) { clearInterval(discoveryPoller); discoveryPoller = null }
  for (const t of inlineDeviceToolbarDisableTimers) clearTimeout(t)
  inlineDeviceToolbarDisableTimers = []

  // 3. Stop MCP
  mcpCleanup?.()
  mcpCleanup = null

  // 4. Close file watchers
  closeAllWatchers()

  // 5. Clear registries + flags
  clearBrowserRegistry()
  resetSyncFlags()

  // 6. Clear oauth state
  oauthCallbackQueue.length = 0
  oauthCallbackWaiters.clear()

  // 7. Drop all tables + re-migrate
  const db = getDatabase()
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all() as { name: string }[]

  db.exec('PRAGMA foreign_keys = OFF')
  for (const { name } of tables) {
    db.exec(`DROP TABLE IF EXISTS "${name}"`)
  }
  db.exec('PRAGMA foreign_keys = ON')
  db.pragma('user_version = 0')

  runMigrations(db)
  normalizeProjectStatusData(db)

  // 8. Re-init process manager
  initProcessManager(db)

  return { ok: true }
})
```

### Phase 3: Add `resetApp` fixture helper

In `packages/apps/app/e2e/fixtures/electron.ts`:

```ts
export async function resetApp(page: Page) {
  await page.evaluate(() => window.__testInvoke('app:reset-for-test'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#root', { timeout: 10_000 })
  await dismissOnboardingIfPresent(page)
}
```

### Phase 4: Convert first test as proof-of-concept

Pick `04-tasks-crud.spec.ts` — it has a clear `beforeAll` with seeding and a known dependency on `03-projects.spec.ts`:

```ts
test.beforeAll(async ({ mainWindow }) => {
  await resetApp(mainWindow)
  const s = seed(mainWindow)
  const p = await s.createProject({ name: 'CRUD Test', path: TEST_PROJECT_PATH })
  // ... seed tasks, etc.
})
```

Verify it passes standalone: `pnpm test:e2e -- --grep "Task CRUD"`

### Phase 5: Incremental migration

Convert remaining files one-by-one:
1. Add `await resetApp(mainWindow)` as first line of `beforeAll`
2. Ensure all needed data is seeded (no reliance on prior test data)
3. Remove manual cleanup that compensated for shared state
4. Verify standalone: `pnpm test:e2e -- --grep "<test name>"`
5. Verify full suite: `pnpm test:e2e`

## Performance impact

| Step | Time |
|------|------|
| Kill PTYs/processes | ~5ms |
| Drop tables + migrate | ~50ms |
| Page reload | ~500ms |
| Onboarding dismissal | ~2s |
| **Total per file** | **~2.5s** |
| **67 files** | **~2.5 min added** |

This is acceptable given the isolation benefits. The onboarding dismissal wait could be optimized later (skip if dialog doesn't appear).

## Edge cases and risks

1. **Onboarding dialog on fresh DB.** Already handled by `dismissOnboardingIfPresent` in the fixture. The reset produces a fresh DB which triggers onboarding — same as initial launch.

2. **Tests that mock IPC handlers.** Some tests (`29-codex-session-detection`, `53-screenshot-to-terminal`) call `ipcMain.removeHandler()` + `ipcMain.handle()` to mock handlers. Reset doesn't re-register handlers (they were registered once at startup). If a test removes a handler and doesn't restore it, the handler is gone for subsequent tests. This is a pre-existing issue — each mocking test must restore handlers in `afterAll`. Reset doesn't make this worse.

3. **MCP server tests.** Tests that need MCP (`46-mcp-server.spec.ts`) must restart it after reset since `mcpCleanup` stops the server. These tests should call MCP start in their `beforeAll`.

4. **Settings that persist across tests.** If any test assumes a setting (e.g., theme) was set by a prior test, it will break after isolation. Each test must seed its own settings. This is a feature, not a bug — it surfaces hidden dependencies.

5. **Same-DB connection reuse.** The `app:reset-for-test` handler drops tables on the existing `db` connection rather than closing/reopening it. This keeps all handler closures valid (they captured `db` at startup). `runMigrations` recreates all tables on the same connection.

## Files to modify

| File | Change |
|------|--------|
| `packages/domains/file-editor/src/main/handlers.ts` | Add `closeAllWatchers()` export |
| `packages/apps/app/src/main/browser-registry.ts` | Add `clearBrowserRegistry()` export |
| `packages/domains/integrations/src/main/sync.ts` | Add `resetSyncFlags()` export |
| `packages/domains/terminal/src/main/pty-manager.ts` | Add `resetPtyState()` export |
| `packages/apps/app/src/main/index.ts` | Add `app:reset-for-test` IPC handler (Playwright-only) |
| `packages/apps/app/e2e/fixtures/electron.ts` | Add `resetApp()` helper |
| `packages/apps/app/e2e/04-tasks-crud.spec.ts` | First conversion (proof-of-concept) |

## Verification

1. `pnpm typecheck` — no type errors
2. `pnpm test:e2e -- --grep "Task CRUD"` — test 04 passes standalone (without 01-03)
3. `pnpm test:e2e` — full suite passes with no regressions
4. Run test 04 twice in a row — second run gets clean state, not leftover data

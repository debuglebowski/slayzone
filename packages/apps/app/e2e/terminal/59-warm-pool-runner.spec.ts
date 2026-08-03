/**
 * Warm pool runs ON THE RUNNER (Phase 6).
 *
 * The pool pre-boots a real agent, so before this it was the last path by which
 * the HUB could start an agent itself — and `pty-store` reached for it precisely
 * when no runner resolved, i.e. the case that is supposed to raise "no runner
 * available". It is opt-in (`terminal_prewarm_enabled`, default off), which is
 * why it had no e2e coverage at all and the violation went unnoticed.
 *
 * These tests assert the invariant end-to-end: with pre-warm ON, the warm agent is
 * spawned through the runner, and adopting it produces a working terminal.
 */
import path from 'path'
// `node:sqlite`, not better-sqlite3: the latter's native binding is compiled for
// Electron's ABI and will not load in the Playwright runner's plain node.
import { DatabaseSync } from 'node:sqlite'
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'

test.describe('Warm pool (runner-hosted)', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test.afterAll(async ({ mainWindow }) => {
    // Leave pre-warm OFF for every other spec: a live pooled agent per project
    // would otherwise linger for the rest of the worker.
    await mainWindow.evaluate(() =>
      window
        .getTrpcVanillaClient()
        .settings.set.mutate({ key: 'terminal_prewarm_enabled', value: '0' })
    )
  })

  test('warm agent is spawned on a runner, never in the hub process', async ({ mainWindow, electronApp }) => {
    const project = (await seed(mainWindow).createProject({
      name: 'WarmPool',
      color: '#22c55e',
      path: TEST_PROJECT_PATH
    })) as { id: string }
    const projectId = project.id

    await mainWindow.evaluate(() =>
      window
        .getTrpcVanillaClient()
        .settings.set.mutate({ key: 'terminal_prewarm_enabled', value: '1' })
    )

    // The gate is "this project has ≥1 open task tab", reported per window.
    //
    // Re-issued on every poll rather than sent once: the sidecar refreshes its
    // cached `terminal_prewarm_enabled` asynchronously off a settings-changed
    // event, so a single report can land while the flag is still false and be
    // dropped as `warm.reconcile_skip_disabled`. Each report schedules a fresh
    // (debounced) reconcile, so re-sending is how the test converges rather than
    // racing.
    const reportTabOpen = (): Promise<unknown> =>
      mainWindow.evaluate(
        (pid) =>
          window
            .getTrpcVanillaClient()
            .pty.warmSetProjectTabCounts.mutate({ counts: { [pid]: 1 } }),
        projectId
      )

    // A pooled agent_sessions row with no task bound is the pool's footprint. It is
    // written SYNCHRONOUSLY through the data seam, unlike the `warm.agent_spawned`
    // diagnostic — diagnostics are batched before flush, so that table lags and
    // asserting on it reads as "the pool never ran" when it merely has not flushed.
    //
    // Reaching this state requires `backend.warmSpawn` to have RESOLVED, which only
    // the routing backend implements: the local backend has no warm pool, so a
    // pooled row cannot exist unless a runner accepted the spawn. That the runnerId
    // is threaded correctly, and that nothing warms when no runner resolves, are
    // asserted directly in warm-process-manager.test.ts.
    await expect
      .poll(
        async () => {
          await reportTabOpen()
          const rows = await queryFile<{ id: string; task_id: string | null }>(
            electronApp,
            SIDECAR_DB,
            `SELECT id, task_id FROM agent_sessions WHERE status = 'pooled' LIMIT 5`
          )
          return rows.length > 0 && rows[0].task_id === null
        },
        { timeout: 30_000, intervals: [500, 1_000] }
      )
      .toBe(true)
  })

  test('pre-warm off spawns nothing', async ({ mainWindow, electronApp }) => {
    await mainWindow.evaluate(() =>
      window
        .getTrpcVanillaClient()
        .settings.set.mutate({ key: 'terminal_prewarm_enabled', value: '0' })
    )
    const project = (await seed(mainWindow).createProject({
      name: 'NoWarm',
      color: '#3b82f6',
      path: TEST_PROJECT_PATH
    })) as { id: string }
    const projectId = project.id

    // Turning pre-warm off does not merely stop NEW warms — the next reconcile
    // tears down every live one and marks its pooled session dead, so the pooled
    // count drains to zero (including the one the previous test left armed). That
    // is the assertion worth making: "off" means no pre-booted agent is left
    // running anywhere, not just that none are added.
    await expect
      .poll(
        async () => {
          await mainWindow.evaluate(
            (pid) =>
              window
                .getTrpcVanillaClient()
                .pty.warmSetProjectTabCounts.mutate({ counts: { [pid]: 1 } }),
            projectId
          )
          return countWarmSpawns(electronApp)
        },
        { timeout: 20_000, intervals: [500, 1_000] }
      )
      .toBe(0)
  })
})

/**
 * Read a sqlite file under the app's userData directly.
 *
 * NOT `window.__db`: that is the MAIN process's `userdata/slayzone.dev.sqlite`,
 * while the warm pool runs in the SIDECAR and writes `userdata/storage/…` — two
 * different files with the same basename. Diagnostics are a third file again.
 * Querying the wrong one silently returns nothing, which reads as "the pool never
 * ran".
 */
async function queryFile<T>(
  electronApp: import('@playwright/test').ElectronApplication,
  relPath: string,
  sql: string
): Promise<T[]> {
  const userData = (await electronApp.evaluate(async ({ app }) =>
    app.getPath('userData')
  )) as string
  const db = new DatabaseSync(path.join(userData, relPath), { readOnly: true })
  try {
    return db.prepare(sql).all() as T[]
  } finally {
    db.close()
  }
}

const SIDECAR_DB = path.join('storage', 'slayzone.dev.sqlite')

async function countWarmSpawns(
  electronApp: import('@playwright/test').ElectronApplication
): Promise<number> {
  const rows = await queryFile<{ n: number }>(
    electronApp,
    SIDECAR_DB,
    `SELECT COUNT(*) AS n FROM agent_sessions WHERE status = 'pooled'`
  )
  return rows[0]?.n ?? 0
}

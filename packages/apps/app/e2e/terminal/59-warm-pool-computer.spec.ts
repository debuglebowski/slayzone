/**
 * Warm pool runs ON THE COMPUTER (Phase 6).
 *
 * The pool pre-boots a real agent, so before this it was the last path by which
 * the HUB could start an agent itself — and `pty-store` reached for it precisely
 * when no computer resolved, i.e. the case that is supposed to raise "no computer
 * available". It was opt-in (`terminal_prewarm_enabled`, default off), which is
 * why it had no e2e coverage at all and the violation went unnoticed. It now runs
 * in the `auto` and `instant` agent startup modes (`terminal_agent_startup`).
 *
 * These tests assert the invariant end-to-end: with the pool on (`auto` startup mode), the warm agent is
 * spawned through the computer, and a task created to be opened takes the id the
 * agent booted with, so its first spawn adopts it.
 */
// `node:sqlite`, not better-sqlite3: the latter's native binding is compiled for
// Electron's ABI and will not load in the Playwright computer's plain node.
import { DatabaseSync } from 'node:sqlite'
import { test, expect, seed, resetApp, TEST_PROJECT_PATH, cliDbPath } from '../fixtures/electron'

test.describe('Warm pool (computer-hosted)', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test.afterAll(async ({ mainWindow }) => {
    // Leave the pool OFF (`manual`, the e2e baseline) for every other spec: a live pooled agent per project
    // would otherwise linger for the rest of the worker.
    await mainWindow.evaluate(() =>
      window
        .getTrpcVanillaClient()
        .settings.set.mutate({ key: 'terminal_agent_startup', value: 'manual' })
    )
  })

  test('warm agent is spawned on a computer, never in the hub process', async ({
    mainWindow,
    electronApp
  }) => {
    const project = (await seed(mainWindow).createProject({
      name: 'WarmPool',
      color: '#22c55e',
      path: TEST_PROJECT_PATH
    })) as { id: string }
    const projectId = project.id

    await mainWindow.evaluate(() =>
      window
        .getTrpcVanillaClient()
        .settings.set.mutate({ key: 'terminal_agent_startup', value: 'auto' })
    )

    // The gate is "this project has ≥1 open task tab", reported per window.
    //
    // Re-issued on every poll rather than sent once: the sidecar refreshes its
    // cached startup mode asynchronously off a settings-changed
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
    // Reaching this state requires the routing backend: the local backend has no
    // warm pool, and the pool writes no row without a computer to boot the agent on
    // (a spawn the computer then refuses marks the row dead, not pooled). That the
    // computerId is threaded correctly, and that nothing warms when no computer
    // resolves, are asserted directly in warm-process-manager.test.ts.
    await expect
      .poll(
        async () => {
          await reportTabOpen()
          const rows = await querySidecarDb<{ id: string; task_id: string | null }>(
            electronApp,
            `SELECT id, task_id FROM agent_sessions WHERE status = 'pooled' LIMIT 5`
          )
          return rows.length > 0 && rows[0].task_id === null
        },
        { timeout: 30_000, intervals: [500, 1_000] }
      )
      .toBe(true)
  })

  test('a task created to be opened takes the warm agent’s task id, and its first spawn adopts it', async ({
    mainWindow,
    electronApp
  }) => {
    const project = await seed(mainWindow).createProject({
      name: 'WarmAdopt',
      color: '#a855f7',
      path: TEST_PROJECT_PATH
    })
    const projectId = project.id
    // The folder as the computer recorded it (its real path), which is the folder
    // the warm agent booted in.
    const projectFolder = project.placements[0]?.path ?? TEST_PROJECT_PATH
    await mainWindow.evaluate(() =>
      window
        .getTrpcVanillaClient()
        .settings.set.mutate({ key: 'terminal_agent_startup', value: 'auto' })
    )
    const pooledIds = async (): Promise<string[]> =>
      (
        await querySidecarDb<{ id: string }>(
          electronApp,
          `SELECT id FROM agent_sessions WHERE status = 'pooled'`
        )
      ).map((r) => r.id)
    // The gate is a synthetic "this project has an open tab" report. The renderer
    // re-reports its REAL tabs whenever they change (the create below does), which
    // drops this project again — so, as in the first test, every poll re-reports.
    const reportTabOpen = (): Promise<unknown> =>
      mainWindow.evaluate(
        (pid) =>
          window
            .getTrpcVanillaClient()
            .pty.warmSetProjectTabCounts.mutate({ counts: { [pid]: 1 } }),
        projectId
      )
    // Other projects' warm agents (an earlier test's) are already pooled; this
    // project's is the one that appears after its tab is reported open.
    const before = new Set(await pooledIds())
    let warmSessionId: string | undefined
    await expect
      .poll(
        async () => {
          await reportTabOpen()
          warmSessionId = (await pooledIds()).find((id) => !before.has(id))
          return !!warmSessionId
        },
        { timeout: 15_000, intervals: [500, 1_000] }
      )
      .toBe(true)
    // Pooled ≠ reservable: the row exists from spawn, but only a READY agent is
    // reserved by a task create. A create that lands while it still boots misses,
    // the create's own tab re-report drops this project, and the pool tears the
    // booting agent down — the task then cold-spawns (correct, not adoption).
    await expect
      .poll(
        async () => {
          await reportTabOpen()
          const status = (await mainWindow.evaluate(() =>
            window.getTrpcVanillaClient().pty.testWarmStatus.query()
          )) as Record<string, string>
          return status[projectId]
        },
        { timeout: 30_000, intervals: [500, 1_000] }
      )
      .toBe('ready')

    // What the scratch-terminal button does: create a temp task it opens at once.
    const task = (await mainWindow.evaluate(
      (pid) =>
        window.getTrpcVanillaClient().task.create.mutate({
          projectId: pid,
          title: 'Terminal 1',
          isTemporary: true,
          openAfterCreate: true
        }),
      projectId
    )) as { id: string; provider_config: Record<string, { flags?: string }> }

    // Its terminal's first spawn: fresh, project root, the task's own flags.
    const sessionId = `${task.id}:${task.id}`
    await mainWindow.evaluate(
      ({ sId, dir, flags }) =>
        window.getTrpcVanillaClient().pty.create.mutate({
          sessionId: sId,
          cwd: dir,
          mode: 'claude-code',
          providerFlags: flags
        }),
      {
        sId: sessionId,
        dir: projectFolder,
        flags: task.provider_config['claude-code']?.flags ?? ''
      }
    )

    // The warm agent's own ledger row is now this task's: it booted with this task's
    // id, so nothing else could have claimed it.
    await expect
      .poll(
        async () =>
          (
            await querySidecarDb<{ status: string; task_id: string | null }>(
              electronApp,
              `SELECT status, task_id FROM agent_sessions WHERE id = '${warmSessionId}'`
            )
          )[0],
        { timeout: 10_000, intervals: [250, 500] }
      )
      .toEqual({ status: 'bound', task_id: task.id })

    // And the project got a fresh warm agent for the next task.
    await expect
      .poll(
        async () => {
          await reportTabOpen()
          return (await pooledIds()).some((id) => !before.has(id) && id !== warmSessionId)
        },
        { timeout: 10_000, intervals: [500, 1_000] }
      )
      .toBe(true)

    await mainWindow.evaluate(
      (id) => window.getTrpcVanillaClient().pty.kill.mutate({ sessionId: id }),
      sessionId
    )
  })

  test('manual startup mode (pool off) spawns nothing', async ({ mainWindow, electronApp }) => {
    await mainWindow.evaluate(() =>
      window
        .getTrpcVanillaClient()
        .settings.set.mutate({ key: 'terminal_agent_startup', value: 'manual' })
    )
    const project = (await seed(mainWindow).createProject({
      name: 'NoWarm',
      color: '#3b82f6',
      path: TEST_PROJECT_PATH
    })) as { id: string }
    const projectId = project.id

    // Turning the pool off does not merely stop NEW warms — the next reconcile
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
 * Read the SIDECAR's sqlite file directly.
 *
 * NOT `window.__db`: that is the MAIN process's `userdata/slayzone.dev.diagnostics.sqlite`,
 * while the warm pool runs in the SIDECAR and writes the app's real DB under its
 * channel-scoped hub root — two different files with the same basename.
 * Diagnostics are a third file again. Querying the wrong one silently returns
 * nothing, which reads as "the pool never ran".
 *
 * The path comes from the shared `cliDbPath` helper rather than a local literal:
 * this spec previously hardcoded its own `storage/…` fragment, so it was one of
 * the files the channel-scoping change would have silently broken into exactly
 * that false "pool never ran" reading.
 */
async function querySidecarDb<T>(
  electronApp: import('@playwright/test').ElectronApplication,
  sql: string
): Promise<T[]> {
  const userData = (await electronApp.evaluate(async ({ app }) =>
    app.getPath('userData')
  )) as string
  const db = new DatabaseSync(cliDbPath(userData), { readOnly: true })
  try {
    return db.prepare(sql).all() as T[]
  } finally {
    db.close()
  }
}

async function countWarmSpawns(
  electronApp: import('@playwright/test').ElectronApplication
): Promise<number> {
  const rows = await querySidecarDb<{ n: number }>(
    electronApp,
    `SELECT COUNT(*) AS n FROM agent_sessions WHERE status = 'pooled'`
  )
  return rows[0]?.n ?? 0
}

/**
 * Smoke test for the terminal-corruption-on-task-switch fix.
 *
 * Drives task switches ≥10 times across ≥3 task tabs and asserts that the WebGL
 * atlas never enters a dirty state (atlas tile metrics diverged from renderer
 * cell metrics with no follow-up correction). Uses the existing diag harness
 * (window.__slayzone_terminalDiag) as the detection signal — no screenshots.
 *
 * Without the fix:
 *   - task switch is a CSS visibility flip; no fit() fires
 *   - cell metrics can drift while hidden; nothing re-rasterizes on return
 *   - the smoke fails when any post-switch fit lands with dirty=true
 *
 * With the fix:
 *   - isActive false→true edge re-runs fit() + scheduleAtlasCorrection()
 *   - a per-frame watchdog corrects on cell-key drift while active
 */
import {
  test,
  expect,
  seed,
  resetApp,
  TEST_PROJECT_PATH
} from '../fixtures/electron'
import { getMainSessionId, openTaskTerminal, waitForPtySession } from '../fixtures/terminal'

interface DiagEvent {
  t: number
  sessionId: string
  event: 'webgl-load' | 'atlas-correct' | 'fit' | 'webgl-context-loss'
  site?: string
  geom?: {
    cellDeviceW: number
    cellDeviceH: number
    cellCssW: number
    cellCssH: number
    dpr: number
    cols: number
    rows: number
  }
  dirty?: boolean
}

const ITERATIONS = 10
const TASK_COUNT = 3

test.describe('terminal atlas stability across task switches', () => {
  let projectAbbrev: string
  const taskIds: string[] = []

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Atlas Smoke',
      color: '#22d3ee',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    for (let i = 0; i < TASK_COUNT; i++) {
      const t = await s.createTask({
        projectId: p.id,
        title: `Atlas smoke ${i + 1}`,
        status: 'in_progress'
      })
      await mainWindow.evaluate(
        (id) => window.getTrpcVanillaClient().task.update.mutate({ id, terminalMode: 'terminal' }),
        t.id
      )
      taskIds.push(t.id)
    }
    await s.refreshData()
  })

  test(`atlas stays in sync across ${ITERATIONS} switches over ${TASK_COUNT} tasks`, async ({
    mainWindow
  }) => {
    test.setTimeout(240_000)

    // Open each task so its Terminal mounts and webgl-load fires.
    for (let i = 0; i < TASK_COUNT; i++) {
      await openTaskTerminal(mainWindow, {
        projectAbbrev,
        taskTitle: `Atlas smoke ${i + 1}`
      })
      const sid = getMainSessionId(taskIds[i])
      await waitForPtySession(mainWindow, sid)
    }

    // Confirm the diag harness is live.
    await expect
      .poll(
        async () =>
          mainWindow.evaluate(
            () =>
              typeof (window as unknown as { __slayzone_terminalDiag?: unknown })
                .__slayzone_terminalDiag
          ),
        { timeout: 15_000 }
      )
      .toBe('object')

    // Find each task's tab index in the tab store.
    interface TabStore {
      getState: () => {
        tabs: { type: string; taskId?: string }[]
        activeTabIndex: number
        setActiveTabIndex: (i: number) => void
      }
    }
    const tabIndexByTaskId: Record<string, number> = await mainWindow.evaluate((ids) => {
      const store = (window as unknown as { __slayzone_tabStore?: TabStore }).__slayzone_tabStore
      const state = store?.getState()
      const out: Record<string, number> = {}
      if (!state) return out
      for (const id of ids) {
        const i = state.tabs.findIndex((t) => t.type === 'task' && t.taskId === id)
        if (i >= 0) out[id] = i
      }
      return out
    }, taskIds)

    expect(Object.keys(tabIndexByTaskId).length, 'all task tabs registered').toBe(TASK_COUNT)

    // Clear diag ring so only post-switch events count.
    await mainWindow.evaluate(() =>
      (
        window as unknown as { __slayzone_terminalDiag: { clear: () => void } }
      ).__slayzone_terminalDiag.clear()
    )

    const readDirty = (prefix: string): Promise<DiagEvent[]> =>
      mainWindow.evaluate(
        (p) =>
          (
            window as unknown as {
              __slayzone_terminalDiag: { dirty: () => DiagEvent[] }
            }
          ).__slayzone_terminalDiag
            .dirty()
            .filter((e: DiagEvent) => e.sessionId.startsWith(p)),
        prefix
      )

    const readEvents = (prefix: string): Promise<DiagEvent[]> =>
      mainWindow.evaluate(
        (p) =>
          (
            window as unknown as {
              __slayzone_terminalDiag: { dump: (s?: string) => DiagEvent[] }
            }
          ).__slayzone_terminalDiag.dump(p),
        prefix
      )

    interface Failure {
      iter: number
      to: string
      dirty: DiagEvent[]
    }
    const failures: Failure[] = []
    for (let i = 0; i < ITERATIONS; i++) {
      const toTaskId = taskIds[(i + 1) % TASK_COUNT]
      const toIndex = tabIndexByTaskId[toTaskId]

      await mainWindow.evaluate((idx) => {
        const store = (window as unknown as { __slayzone_tabStore?: TabStore })
          .__slayzone_tabStore
        store?.getState().setActiveTabIndex(idx)
      }, toIndex)

      // Two rAFs: one for React commit, one for the post-commit settle window
      // the fix uses (reactivate effect's scheduleAtlasCorrection rAF lands
      // on the next frame).
      await mainWindow.evaluate(
        () =>
          new Promise<void>((r) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => requestAnimationFrame(() => r()))
            )
          )
      )

      const dirty = await readDirty(getMainSessionId(toTaskId))
      if (dirty.length > 0) {
        failures.push({ iter: i, to: toTaskId, dirty })
      }
    }

    if (failures.length > 0) {
      for (const f of failures) {
        const events = await readEvents(getMainSessionId(f.to))
        console.log(
          `[smoke] iter=${f.iter} to=${f.to.slice(0, 8)} dirty.len=${f.dirty.length} events.len=${events.length}`
        )
        for (const d of f.dirty.slice(0, 3)) {
          console.log('  dirty:', JSON.stringify(d))
        }
      }
    }

    expect(failures, `task-switch dirty atlas events across ${ITERATIONS} iterations`).toEqual(
      []
    )

    // Sanity — every target task recorded at least one fit/reactivate event,
    // proving the test actually exercised the new code path.
    const counts: Record<string, { reactivate: number; correct: number; fit: number }> = {}
    for (const id of taskIds) {
      const events = await readEvents(getMainSessionId(id))
      counts[id.slice(0, 8)] = {
        reactivate: events.filter((e) => e.event === 'fit' && e.site === 'reactivate').length,
        correct: events.filter((e) => e.event === 'atlas-correct').length,
        fit: events.filter((e) => e.event === 'fit').length
      }
    }
    console.log('[smoke] per-task event counts:', JSON.stringify(counts, null, 2))
    console.log(`[smoke] iterations=${ITERATIONS} failures=${failures.length}`)

    for (const id of taskIds) {
      const events = await readEvents(getMainSessionId(id))
      const reactivateFits = events.filter(
        (e) => e.event === 'fit' && e.site === 'reactivate'
      )
      expect(
        reactivateFits.length,
        `task ${id.slice(0, 8)} saw at least one reactivate fit`
      ).toBeGreaterThan(0)
    }
  })
})

/**
 * Boot budget with the strict quiet-box bar: the active tab within 1s. The same
 * measurement runs in the default suite (`core/116-boot-idle-hydration.spec.ts`)
 * with a 2s bar, because a healthy boot measures up to ~1.05s inside the busy
 * parallel suite. Run this one alone: `pnpm test:e2e:perf`. Calibrated on a
 * standard build — not a `SLAYZONE_PROFILE=1` one, whose profiling React is slower.
 */
import { test } from '../fixtures/electron'
import { expectBootBudget, measureBoot, seedBootTasks } from '../fixtures/boot-probe'

test.describe('boot budget', () => {
  let taskIds: string[] = []

  test.beforeAll(async ({ mainWindow }) => {
    taskIds = await seedBootTasks(mainWindow, 'Boot Budget')
  })

  test('boot stays within budget (active tab under 1s)', async ({ mainWindow }) => {
    test.setTimeout(240_000)
    expectBootBudget(await measureBoot(mainWindow, taskIds), 1_000)
  })
})

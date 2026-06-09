import {
  test,
  expect,
  seed,
  resetApp,
  goHome,
  clickProject,
  TEST_PROJECT_PATH
} from '../fixtures/electron'
import path from 'path'
import { fileURLToPath } from 'url'
import { profileScenario, defaultResultsDir, type ScenarioDefinition } from './harness'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
void __dirname

/**
 * Reusable performance harness scenarios.
 *
 * Run with:
 *   SLAYZONE_PROFILE=1 pnpm build
 *   pnpm test:e2e -- e2e/perf/scenarios.spec.ts
 *
 * Output: working-notes/performance/run-<timestamp>/{scenario}.json + .cpuprofile
 * Then:   pnpm tsx packages/apps/app/e2e/perf/report.ts <run-dir>
 *
 * To add a new scenario: append a definition to the SCENARIOS array. The
 * harness handles all measurement, dumping, and summarisation — keep the
 * scenario itself focused on what the user actually does.
 */

const ITERATIONS = 5
const RUN_DIR = path.join(defaultResultsDir(), `run-${Date.now()}`)
const PROJ_ABBREV = 'PE'

let projectId: string
let firstTaskId: string
let secondTaskId: string

test.describe
  .serial('Perf scenarios', () => {
    test.setTimeout(120_000)

    test.beforeAll(async ({ mainWindow }) => {
      test.setTimeout(120_000)
      await resetApp(mainWindow)
      const s = seed(mainWindow)
      const p = await s.createProject({
        name: 'PerfRun',
        color: '#8b5cf6',
        path: TEST_PROJECT_PATH
      })
      projectId = p.id
      // Realistic workload — 12 tasks across statuses gives kanban some weight
      // without ballooning beforeAll runtime.
      const statuses = ['inbox', 'in_progress', 'done', 'in_progress', 'inbox']
      const created: Array<{ id: string }> = []
      for (let i = 0; i < 12; i++) {
        const task = await s.createTask({
          projectId,
          title: `Perf seed ${i}`,
          status: statuses[i % statuses.length]
        })
        created.push(task)
      }
      firstTaskId = created[0].id
      secondTaskId = created[1].id
      await s.refreshData()
      await goHome(mainWindow)
      await clickProject(mainWindow, PROJ_ABBREV)
      // Settle render
      await mainWindow.waitForTimeout(500)
    })

    test('open-create-task-dialog', async ({ mainWindow }) => {
      const definition: ScenarioDefinition = {
        name: 'open-create-task-dialog',
        description:
          'Open the Create Task dialog from the kanban view, wait for content interactive.',
        iterations: ITERATIONS,
        beforeEach: async (page) => {
          // Ensure dialog is closed before each iteration
          await page.evaluate(() =>
            (window as any).__slayzone_dialogStore?.getState().closeCreateTask?.()
          )
          await page.waitForTimeout(150)
        },
        run: async (page) => {
          await page.evaluate(() =>
            (window as any).__slayzone_dialogStore.getState().openCreateTask()
          )
          // Wait for the dialog to be present and contain a title input
          await page.waitForFunction(
            () => {
              const dialogs = document.querySelectorAll('[role="dialog"][data-state="open"]')
              for (const d of dialogs) {
                if (d.querySelector('input,textarea')) return true
              }
              return false
            },
            { timeout: 5000 }
          )
        },
        afterEach: async (page) => {
          await page.evaluate(() =>
            (window as any).__slayzone_dialogStore?.getState().closeCreateTask?.()
          )
          await page.waitForTimeout(100)
        }
      }
      const result = await profileScenario(mainWindow, definition, { runDir: RUN_DIR })
      console.log(
        `[perf] ${result.name} p50=${result.summary.wallP50}ms p95=${result.summary.wallP95}ms`
      )
      expect(result.runs.length).toBe(ITERATIONS)
    })

    test('switch-task', async ({ mainWindow }) => {
      // Pre-open both task tabs so the scenario measures pure tab-switch cost
      await mainWindow.evaluate(
        ({ a, b }) => {
          const store = (window as any).__slayzone_tabStore.getState()
          store.openTask(a)
          store.openTask(b)
        },
        { a: firstTaskId, b: secondTaskId }
      )
      await mainWindow.waitForTimeout(800)

      const definition: ScenarioDefinition = {
        name: 'switch-task',
        description: 'Switch between two already-open task tabs.',
        iterations: ITERATIONS,
        beforeEach: async (page, iteration) => {
          // Park on tab 0 (project) before each measured switch so we always
          // measure the same direction: project → task A
          await page.evaluate(() =>
            (window as any).__slayzone_tabStore.getState().setActiveTabIndex(0)
          )
          await page.waitForTimeout(150)
          void iteration
        },
        run: async (page) => {
          await page.evaluate(() => {
            const store = (window as any).__slayzone_tabStore.getState()
            // Find the first task tab
            const idx = store.tabs.findIndex((t: any) => t.type === 'task')
            if (idx >= 0) store.setActiveTabIndex(idx)
          })
          // Wait for the task shell to be visible
          await page
            .waitForFunction(
              () => {
                return (
                  document.querySelector('[data-testid="terminal-mode-trigger"]') !== null ||
                  document.querySelector('[data-task-shell]') !== null
                )
              },
              { timeout: 5000 }
            )
            .catch(() => {})
        }
      }
      const result = await profileScenario(mainWindow, definition, { runDir: RUN_DIR })
      console.log(
        `[perf] ${result.name} p50=${result.summary.wallP50}ms p95=${result.summary.wallP95}ms`
      )
      expect(result.runs.length).toBe(ITERATIONS)
    })

    test('create-task', async ({ mainWindow }) => {
      // Make sure dialog is closed before starting
      await mainWindow.evaluate(() =>
        (window as any).__slayzone_dialogStore?.getState().closeCreateTask?.()
      )

      const definition: ScenarioDefinition = {
        name: 'create-task',
        description: 'Open Create Task dialog, fill title, submit, wait for new task in DB.',
        iterations: ITERATIONS,
        beforeEach: async (page) => {
          await page.evaluate(() =>
            (window as any).__slayzone_dialogStore?.getState().closeCreateTask?.()
          )
          await page.waitForTimeout(100)
        },
        run: async (page, iteration) => {
          // Open dialog
          await page.evaluate(() =>
            (window as any).__slayzone_dialogStore.getState().openCreateTask()
          )
          await page.waitForFunction(
            () => {
              const dialogs = document.querySelectorAll('[role="dialog"][data-state="open"]')
              for (const d of dialogs) if (d.querySelector('input,textarea')) return true
              return false
            },
            { timeout: 5000 }
          )

          // Type title into the first input/textarea inside the dialog
          const title = `perf-created-${Date.now()}-${iteration}`
          await page.evaluate((t) => {
            const dialog = document.querySelector(
              '[role="dialog"][data-state="open"]'
            ) as HTMLElement | null
            const input = dialog?.querySelector('input,textarea') as
              | HTMLInputElement
              | HTMLTextAreaElement
              | null
            if (!input) return
            const setter = Object.getOwnPropertyDescriptor(
              input.constructor.prototype,
              'value'
            )?.set
            setter?.call(input, t)
            input.dispatchEvent(new Event('input', { bubbles: true }))
          }, title)

          // Submit via Cmd+Enter (most dialogs honor this) or Enter
          await page.keyboard.press('Meta+Enter').catch(() => {})

          // Wait for the new task to land in DB
          await page
            .waitForFunction(
              (t) => {
                return window
                  .getTrpcVanillaClient()
                  .task.getAll.query()
                  .then((tasks: any[]) => tasks.some((task) => task.title === t))
              },
              title,
              { timeout: 5000 }
            )
            .catch(() => {})
        },
        afterEach: async (page) => {
          await page.evaluate(() =>
            (window as any).__slayzone_dialogStore?.getState().closeCreateTask?.()
          )
          await page.waitForTimeout(100)
        }
      }
      const result = await profileScenario(mainWindow, definition, { runDir: RUN_DIR })
      console.log(
        `[perf] ${result.name} p50=${result.summary.wallP50}ms p95=${result.summary.wallP95}ms`
      )
      console.log(`[perf] run dir: ${RUN_DIR}`)
      expect(result.runs.length).toBe(ITERATIONS)
    })
  })

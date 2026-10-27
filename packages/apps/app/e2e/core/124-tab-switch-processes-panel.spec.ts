import type { Page } from '@playwright/test'
import { test, expect, seed, openTaskById, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'

// ProcessesPanel across a task-tab switch. Task tabs live in <Activity>, so a hidden
// tab's load effect re-runs when it is shown again.
//  - That reload is how a process added while hidden reaches the list (the panel's
//    subscriptions only patch processes it already lists).
//  - It must keep the current list on screen: no spinner while it reloads.

const PANELS_WITH_PROCESSES = {
  terminal: true,
  browser: false,
  diff: false,
  settings: true,
  editor: false,
  artifacts: false,
  processes: true
}

const processesPanel = (page: Page) => page.locator('[data-panel-id="processes"]:visible')

/** A stopped, task-scoped process: listed, never spawned. */
function createProcess(page: Page, taskId: string, projectId: string, label: string) {
  return page.evaluate((input) => window.getTrpcVanillaClient().processes.create.mutate(input), {
    projectId,
    taskId,
    label,
    command: 'true',
    cwd: TEST_PROJECT_PATH,
    autoRestart: false
  })
}

/** From now on, record whether any processes panel ever renders its loading spinner. */
async function watchForSpinner(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __procSpinnerSeen: boolean; __procSpinnerStop?: () => void }
    w.__procSpinnerStop?.()
    w.__procSpinnerSeen = false
    const check = (): void => {
      if (document.querySelector('[data-panel-id="processes"] .animate-spin')) {
        w.__procSpinnerSeen = true
      }
    }
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true })
    w.__procSpinnerStop = () => observer.disconnect()
  })
}

const spinnerSeen = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __procSpinnerSeen: boolean; __procSpinnerStop?: () => void }
    w.__procSpinnerStop?.()
    return w.__procSpinnerSeen
  })

test.describe('ProcessesPanel across a tab switch', () => {
  let projectId = ''
  let taskA = ''
  let taskB = ''

  // Only A shows the processes panel, so its visibility pins which task's pane is on
  // screen. `openTaskById` alone can return while the previous tab is still visible.
  async function showA(page: Page): Promise<void> {
    await openTaskById(page, taskA)
    await expect(processesPanel(page)).toBeVisible({ timeout: 10_000 })
  }

  /** Show B's tab: A's pane is hidden once this returns. */
  async function showB(page: Page): Promise<void> {
    await openTaskById(page, taskB)
    await expect(processesPanel(page)).toHaveCount(0, { timeout: 10_000 })
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Proc Switch',
      color: '#14b8a6',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
    taskA = (await s.createTask({ projectId, title: 'PS task A', status: 'todo' })).id
    taskB = (await s.createTask({ projectId, title: 'PS task B', status: 'todo' })).id
    await s.updateTask({ id: taskA, panelVisibility: PANELS_WITH_PROCESSES })
    await createProcess(mainWindow, taskA, projectId, 'ps-proc-one')
    await s.refreshData()
  })

  test('re-show reloads the list: a process added while hidden is listed', async ({
    mainWindow
  }) => {
    await showA(mainWindow)
    await expect(processesPanel(mainWindow).getByText('ps-proc-one')).toBeVisible({
      timeout: 10_000
    })

    await showB(mainWindow)
    await createProcess(mainWindow, taskA, projectId, 'ps-proc-two')

    await showA(mainWindow)
    await expect(processesPanel(mainWindow).getByText('ps-proc-two')).toBeVisible({
      timeout: 10_000
    })
    await expect(processesPanel(mainWindow).getByText('ps-proc-one')).toBeVisible()
  })

  test('re-show keeps the current list on screen while it reloads (no spinner)', async ({
    mainWindow
  }) => {
    await showA(mainWindow)
    await expect(processesPanel(mainWindow).getByText('ps-proc-one')).toBeVisible({
      timeout: 10_000
    })

    await showB(mainWindow)
    await createProcess(mainWindow, taskA, projectId, 'ps-proc-three')
    await watchForSpinner(mainWindow)

    await showA(mainWindow)
    // Listed only once the re-show reload has landed: everything it rendered on the
    // way is behind us.
    await expect(processesPanel(mainWindow).getByText('ps-proc-three')).toBeVisible({
      timeout: 10_000
    })
    expect(await spinnerSeen(mainWindow)).toBe(false)
  })
})

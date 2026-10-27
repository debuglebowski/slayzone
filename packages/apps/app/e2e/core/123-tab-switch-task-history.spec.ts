import type { Page } from '@playwright/test'
import { test, expect, seed, openTaskById, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'

// TaskHistoryPanel across a task-tab switch. Task tabs live in <Activity>, so a
// hidden tab's effects re-run when it is shown again.
//  - The panel has NO live updates: the page-1 reload on re-show is its only refresh.
//  - That reload must not reset UI: an expanded automation run stays expanded.
//
// Only task A ever shows its Activity (history) view, so "a visible 'Back to
// settings' button" pins which task's pane is on screen. `openTaskById` alone can
// return while the previous tab is still the visible one.

/** The settings panel of the task on screen (hidden tabs are visibility:hidden). */
const settingsPanel = (page: Page) =>
  page.getByTestId('task-settings-panel').filter({ visible: true })
const backToSettings = (page: Page) =>
  settingsPanel(page).getByRole('button', { name: 'Back to settings' })
const viewActivity = (page: Page) =>
  settingsPanel(page).getByRole('button', { name: 'View activity' })

test.describe('TaskHistoryPanel across a tab switch', () => {
  let projectId = ''
  let taskA = ''
  let taskB = ''

  /** Show A's tab, whose settings panel is in the Activity view. */
  async function showA(page: Page): Promise<void> {
    await openTaskById(page, taskA)
    await expect(backToSettings(page)).toBeVisible({ timeout: 10_000 })
  }

  /** Show B's tab (Settings view): A's pane is hidden once this returns. */
  async function showB(page: Page): Promise<void> {
    await openTaskById(page, taskB)
    await expect(backToSettings(page)).toHaveCount(0, { timeout: 10_000 })
    await expect(viewActivity(page)).toBeVisible()
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'History Switch',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
    taskA = (await s.createTask({ projectId, title: 'HS task A', status: 'todo' })).id
    taskB = (await s.createTask({ projectId, title: 'HS task B', status: 'todo' })).id
    await s.refreshData()

    await openTaskById(mainWindow, taskA)
    await expect(viewActivity(mainWindow)).toBeVisible({ timeout: 10_000 })
    await viewActivity(mainWindow).click()
    await expect(backToSettings(mainWindow)).toBeVisible()
  })

  test('re-show reloads history: an event added while hidden is shown', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    await showA(mainWindow)
    await expect(settingsPanel(mainWindow).getByText('Task created')).toBeVisible({
      timeout: 10_000
    })
    await expect(settingsPanel(mainWindow).getByText('Title changed')).toHaveCount(0)

    await showB(mainWindow)
    await s.updateTask({ id: taskA, title: 'HS task A renamed' }) // records "Title changed"

    await showA(mainWindow)
    await expect(settingsPanel(mainWindow).getByText('Title changed')).toBeVisible({
      timeout: 10_000
    })
  })

  test('re-show keeps an expanded automation run expanded', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const command = 'echo history-switch-run'
    await mainWindow.evaluate(
      (input) => window.getTrpcVanillaClient().automations.create.mutate(input),
      {
        project_id: projectId,
        name: 'HS run',
        trigger_config: { type: 'task_status_change', params: { toStatus: 'in_progress' } },
        actions: [{ type: 'run_command', params: { command } }]
      }
    )
    await s.updateTask({ id: taskA, status: 'in_progress' })
    // The run finishes asynchronously; its history event exists once it completed.
    await expect
      .poll(
        async () => {
          const result = await mainWindow.evaluate(
            (id) =>
              window.getTrpcVanillaClient().history.listForTask.query({
                taskId: id,
                options: { limit: 50 }
              }),
            taskA
          )
          return result.events.some((e) => e.summary === 'Automation "HS run" succeeded')
        },
        { timeout: 15_000 }
      )
      .toBe(true)

    // No live updates: a hide + re-show brings the run in.
    await showB(mainWindow)
    await showA(mainWindow)
    await expect(settingsPanel(mainWindow).getByText('Automation "HS run" succeeded')).toBeVisible({
      timeout: 10_000
    })
    await settingsPanel(mainWindow)
      .getByRole('button', { name: 'Show automation run details' })
      .click()
    await expect(
      settingsPanel(mainWindow).getByRole('button', { name: 'Hide automation run details' })
    ).toBeVisible()
    await expect(settingsPanel(mainWindow).getByText(command)).toBeVisible()
    const titleChanges = await settingsPanel(mainWindow).getByText('Title changed').count()

    await showB(mainWindow)
    // An event only the re-show reload can bring in: once it is listed, the reload
    // has landed, so what is asserted below is the post-reload state.
    await s.updateTask({ id: taskA, title: 'HS task A renamed again' })
    await showA(mainWindow)
    await expect(settingsPanel(mainWindow).getByText('Title changed')).toHaveCount(
      titleChanges + 1,
      {
        timeout: 10_000
      }
    )

    await expect(
      settingsPanel(mainWindow).getByRole('button', { name: 'Hide automation run details' })
    ).toBeVisible()
    await expect(settingsPanel(mainWindow).getByText(command)).toBeVisible()
  })
})

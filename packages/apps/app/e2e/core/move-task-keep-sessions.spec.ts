import { test, expect, seed, resetApp, openTaskById, TEST_PROJECT_PATH } from '../fixtures/electron'
import type { Page } from '@playwright/test'

// The move dialog lists the task's agent tabs: a session that can follow the task
// to the new folder is kept by default (and can be un-ticked); one that cannot is
// disabled, with the reason.
async function createTab(page: Page, taskId: string, mode: string, label: string) {
  return page.evaluate((a) => window.getTrpcVanillaClient().taskTerminals.create.mutate(a), {
    taskId,
    mode,
    label
  })
}

test.describe('Move dialog: agent sessions', () => {
  test('Claude kept by default, Codex terminal cannot follow', async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const from = await s.createProject({
      name: 'Sessions From',
      color: '#2563eb',
      path: TEST_PROJECT_PATH
    })
    const to = await s.createProject({
      name: 'Sessions To',
      color: '#16a34a',
      path: TEST_PROJECT_PATH
    })
    const task = await s.createTask({ projectId: from.id, title: 'Session mover', status: 'todo' })
    const claude = await createTab(mainWindow, task.id, 'claude-code', 'Planner')
    const codex = await createTab(mainWindow, task.id, 'codex', 'Reviewer')
    await s.refreshData()

    // The task tab's Project field opens the same dialog as every other entry point.
    await openTaskById(mainWindow, task.id)
    const field = mainWindow.getByTestId('task-project-field').filter({ visible: true })
    await expect(field.getByRole('combobox')).toContainText('Sessions From', { timeout: 10_000 })
    await field.getByRole('combobox').click()
    await mainWindow.getByRole('option', { name: 'Sessions To' }).click()

    const dialog = mainWindow.getByTestId('move-task-dialog')
    const keepClaude = dialog.getByTestId(`move-task-keep-session-${claude.id}`)
    const keepCodex = dialog.getByTestId(`move-task-keep-session-${codex.id}`)
    await expect(keepClaude).toBeChecked({ timeout: 5_000 })
    await expect(keepClaude).toBeEnabled()
    await expect(keepCodex).not.toBeChecked()
    await expect(keepCodex).toBeDisabled()
    await expect(dialog.getByTestId('move-task-sessions')).toContainText('asks which folder')
    // Un-ticking a kept session starts it fresh instead.
    await keepClaude.click()
    await expect(keepClaude).not.toBeChecked()
    await keepClaude.click()

    await dialog.getByTestId('move-task-confirm').click()
    await expect(dialog).toBeHidden({ timeout: 5_000 })
    await expect
      .poll(
        async () => (await s.getTasks()).find((t: { id: string }) => t.id === task.id)?.project_id,
        { timeout: 5_000 }
      )
      .toBe(to.id)
  })
})

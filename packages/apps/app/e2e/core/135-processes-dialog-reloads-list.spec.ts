import type { Page } from '@playwright/test'
import { test, expect, seed, openTaskById, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'

// ProcessesPanel reloads its list after the process dialog saves or runs a process:
// that reload is how a new process reaches the list (the panel's subscriptions only
// patch processes it already lists). The reload now re-runs the panel's list load
// (stale guard, failure handling); this pins the real dialog -> list path end to end.
// Its failure and stale-answer paths are pinned in jsdom (ProcessesPanel.test.tsx):
// `processes.listForTask` reads an in-memory map, so there is no seam to fail or
// delay it deterministically here.

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

async function openNewProcessDialog(page: Page, label: string, command: string): Promise<void> {
  // The header's button (an empty list shows a second one).
  await processesPanel(page).getByRole('button', { name: 'New process' }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await dialog.getByPlaceholder('e.g. Frontend').fill(label)
  await dialog.getByPlaceholder('e.g. npm run dev').fill(command)
}

test.describe('ProcessesPanel after the process dialog saves or runs', () => {
  let taskId = ''

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Proc Dialog Reload',
      color: '#f97316',
      path: TEST_PROJECT_PATH
    })
    taskId = (await s.createTask({ projectId: p.id, title: 'PDR task', status: 'todo' })).id
    await s.updateTask({ id: taskId, panelVisibility: PANELS_WITH_PROCESSES })
    await s.refreshData()
  })

  test('Save lists the new process', async ({ mainWindow }) => {
    await openTaskById(mainWindow, taskId)
    await expect(processesPanel(mainWindow)).toBeVisible({ timeout: 10_000 })

    await openNewProcessDialog(mainWindow, 'pdr-saved', 'true')
    await mainWindow.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
    await expect(mainWindow.getByRole('dialog')).toHaveCount(0, { timeout: 10_000 })

    await expect(processesPanel(mainWindow).getByText('pdr-saved')).toBeVisible({
      timeout: 10_000
    })
    await expect(processesPanel(mainWindow).getByTestId('processes-refresh-error')).toHaveCount(0)
  })

  test("Run lists the new process with its log open, showing the process's output", async ({
    mainWindow
  }) => {
    await openTaskById(mainWindow, taskId)
    await expect(processesPanel(mainWindow)).toBeVisible({ timeout: 10_000 })

    // Its output differs from its command text, which the row shows too.
    await openNewProcessDialog(mainWindow, 'pdr-run', "printf 'pdr-run-%s\\n' output")
    await mainWindow.getByRole('dialog').getByRole('button', { name: 'Run', exact: true }).click()
    await expect(mainWindow.getByRole('dialog')).toHaveCount(0, { timeout: 10_000 })

    await expect(processesPanel(mainWindow).getByText('pdr-run', { exact: true })).toBeVisible({
      timeout: 10_000
    })
    // The log panel is open (spawn expands it) and carries the output.
    await expect(processesPanel(mainWindow).getByText('pdr-run-output')).toBeVisible({
      timeout: 10_000
    })
  })
})

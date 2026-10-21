import type { Page } from '@playwright/test'
import { test, expect, seed, openTaskById, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'

// Regression: a task whose status/priority changed while its tab was in the
// background (e.g. an agent ran `slay tasks update`) dropped to Inbox — and
// priority to 0 — the moment the tab became visible again.
//
// The settings panel lives in <Activity mode="hidden"> while its tab is
// inactive. Radix Select then renders its hidden native <select> with no
// <option>s; a value change landing while hidden made Radix read back '' on
// re-show and call onValueChange(''), which the panel saved as the new status
// (backend coerced '' → default column, Inbox) and priority (Number('') → 0).
test.describe('Hidden task tab: status/priority selects', () => {
  const getTask = (page: Page, id: string) =>
    page.evaluate((i) => window.getTrpcVanillaClient().task.get.query({ id: i }), id)

  test('a status/priority change made while the tab is hidden survives re-showing it', async ({
    mainWindow
  }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Hidden Select',
      color: '#a855f7',
      path: TEST_PROJECT_PATH
    })
    const a = await s.createTask({
      projectId: p.id,
      title: 'HS background task',
      status: 'in_progress',
      priority: 2
    })
    const b = await s.createTask({ projectId: p.id, title: 'HS foreground task', status: 'todo' })
    await s.refreshData()

    // Mount A's settings panel (Details: Status + Priority selects), then hide it.
    await openTaskById(mainWindow, a.id)
    const visibleDetails = mainWindow.locator('[data-testid="settings-details-pinned"]:visible')
    await expect(visibleDetails.getByText('In Progress', { exact: true })).toBeVisible({
      timeout: 10_000
    })
    await openTaskById(mainWindow, b.id)

    // The background change. The due date is the probe that A's HIDDEN panel has
    // re-rendered with the new task (the bug needs the new value to land while
    // hidden): it renders as plain text in the same panel as the two selects.
    await s.updateTask({ id: a.id, status: 'review', priority: 4, dueDate: '2026-12-24' })
    await mainWindow.waitForFunction(
      () => /Dec 2[34], 2026/.test(document.body.textContent ?? ''),
      undefined,
      { timeout: 10_000 }
    )

    // Re-show A. Its selects must render the new values without writing anything.
    await openTaskById(mainWindow, a.id)
    await expect(visibleDetails.getByText('Review', { exact: true })).toBeVisible({
      timeout: 10_000
    })
    await expect(visibleDetails.getByText('Low', { exact: true })).toBeVisible()
    // The stray write fires from an effect right after re-show — give it time to land.
    await mainWindow.waitForTimeout(1_500)
    const after = await getTask(mainWindow, a.id)
    expect(after?.status).toBe('review')
    expect(after?.priority).toBe(4)
  })
})

import { test, expect, seed, goHome, clickProject, resetApp } from './fixtures/electron'
import { TEST_PROJECT_PATH } from './fixtures/electron'

test.describe('Tag input field responsive overflow', () => {
  let projectId: string
  let projectAbbrev: string

  test.beforeAll(async ({ mainWindow, electronApp }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Overflow Test', color: '#3b82f6', path: TEST_PROJECT_PATH })
    projectId = p.id
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const task = await s.createTask({ projectId: p.id, title: 'Many tags task' })

    // Create 6 tags with long names
    const tagNames = ['frontend', 'backend', 'database', 'security', 'performance', 'documentation']
    const colors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7']
    const tagIds: string[] = []
    for (let i = 0; i < tagNames.length; i++) {
      const tag = await s.createTag({ name: tagNames[i], color: colors[i], textColor: '#ffffff', projectId: p.id })
      tagIds.push(tag.id)
    }
    await s.setTagsForTask(task.id, tagIds)
    await s.refreshData()
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.locator('h3').getByText('Inbox', { exact: true })).toBeVisible({ timeout: 5_000 })

    // Open the task detail
    await mainWindow.getByText('Many tags task').first().click()
    await expect(mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()).toBeVisible({ timeout: 5_000 })

    // Dismiss alert dialog if present
    const dialog = mainWindow.getByRole('alertdialog')
    if (await dialog.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await dialog.getByRole('button', { name: 'No' }).click()
    }
  })

  test('shows +N overflow when tags exceed button width', async ({ mainWindow }) => {
    // With 6 tags, there should be a +N indicator since they can't all fit
    const overflowBadge = mainWindow.locator('[data-overflow="true"]')
    await expect(overflowBadge).toBeVisible({ timeout: 3_000 })

    // The overflow badge text should be +N where N > 0
    const text = await overflowBadge.textContent()
    expect(text).toMatch(/^\+\d+$/)
    const overflowCount = parseInt(text!.slice(1))
    expect(overflowCount).toBeGreaterThan(0)
  })

  test('all tags visible in popover regardless of overflow', async ({ mainWindow }) => {
    // Open the tags popover
    const tagsLabel = mainWindow.locator('label').filter({ hasText: 'Tags' })
    const tagsButton = tagsLabel.locator('..').locator('button').first()
    await tagsButton.click()

    // All 6 tags should be visible as checkboxes in the popover
    const tagNames = ['frontend', 'backend', 'database', 'security', 'performance', 'documentation']
    for (const name of tagNames) {
      await expect(mainWindow.locator('[role="dialog"]').getByText(name)).toBeVisible({ timeout: 2_000 })
    }

    // Close popover by pressing Escape
    await mainWindow.keyboard.press('Escape')
  })

  test('overflow count increases when window shrinks', async ({ mainWindow, electronApp }) => {
    // Get current overflow count
    const overflowBadge = mainWindow.locator('[data-overflow="true"]')
    const textBefore = await overflowBadge.textContent()
    const countBefore = parseInt(textBefore!.slice(1))

    // Shrink window significantly
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setSize(900, 800)
    })
    await mainWindow.waitForTimeout(500)

    // Overflow count should be >= what it was before (more tags hidden)
    const textAfter = await overflowBadge.textContent()
    const countAfter = parseInt(textAfter!.slice(1))
    expect(countAfter).toBeGreaterThanOrEqual(countBefore)

    // Restore window size
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setSize(1920, 1200)
    })
    await mainWindow.waitForTimeout(500)
  })
})

import { test, expect, seed, goHome, clickProject, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'

test.describe('Tag create and edit dialog', () => {
  let projectId: string
  let projectAbbrev: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Tag Test', color: '#3b82f6', path: TEST_PROJECT_PATH })
    projectId = p.id
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const task = await s.createTask({ projectId: p.id, title: 'Tag task' })
    const tag = await s.createTag({ name: 'existing-tag', color: '#ef4444', projectId: p.id })
    await s.setTagsForTask(task.id, [tag.id])
    await s.refreshData()
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.locator('h3').getByText('Inbox', { exact: true })).toBeVisible({ timeout: 5_000 })
  })

  test('open task and navigate to tags popover', async ({ mainWindow }) => {
    await mainWindow.getByText('Tag task').first().click()
    await expect(mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()).toBeVisible({ timeout: 5_000 })

    // Dismiss alert dialog if present
    const dialog = mainWindow.getByRole('alertdialog')
    if (await dialog.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await dialog.getByRole('button', { name: 'No' }).click()
    }
  })

  test('edit existing tag: must update not create', async ({ mainWindow }) => {
    // Count tags before
    const tagsBefore = await seed(mainWindow).getTags()
    const countBefore = tagsBefore.length

    // Open tags popover
    const tagsLabel = mainWindow.locator('label').filter({ hasText: 'Tags' })
    const tagsButton = tagsLabel.locator('..').locator('button').first()
    await tagsButton.click()

    // Hover to reveal pencil, click it
    const tagRow = mainWindow.locator('[role="dialog"]').locator('label').filter({ hasText: 'existing-tag' })
    await tagRow.hover()
    const editButton = tagRow.locator('button:not([role="checkbox"])')
    await editButton.click()

    // Must show "Edit Tag" heading
    await expect(mainWindow.getByRole('heading', { name: 'Edit Tag' })).toBeVisible({ timeout: 3_000 })

    // Must NOT show "New Tag" heading
    await expect(mainWindow.getByRole('heading', { name: 'New Tag' })).not.toBeVisible()

    // Input must be pre-filled
    const nameInput = mainWindow.locator('#tag-name')
    await expect(nameInput).toHaveValue('existing-tag')

    // Rename and save
    await nameInput.clear()
    await nameInput.fill('renamed-tag')
    await mainWindow.getByRole('button', { name: 'Save' }).click()
    await expect(mainWindow.getByRole('heading', { name: 'Edit Tag' })).not.toBeVisible({ timeout: 3_000 })

    // CRITICAL: tag count must NOT increase (edit, not create)
    const tagsAfter = await seed(mainWindow).getTags()
    expect(tagsAfter.length).toBe(countBefore)

    // Old name must be gone
    const old = tagsAfter.find((t: any) => t.name === 'existing-tag')
    expect(old).toBeUndefined()

    // New name must exist
    const renamed = tagsAfter.find((t: any) => t.name === 'renamed-tag')
    expect(renamed).toBeTruthy()
    expect(renamed.id).toBe(tagsBefore.find((t: any) => t.name === 'existing-tag')!.id)
  })
})

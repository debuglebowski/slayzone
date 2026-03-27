import { test, expect, seed, goHome, clickProject, resetApp } from './fixtures/electron'
import { TEST_PROJECT_PATH } from './fixtures/electron'

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

  test('open task detail and open tags popover', async ({ mainWindow }) => {
    // Open task
    await mainWindow.getByText('Tag task').first().click()
    await expect(mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()).toBeVisible({ timeout: 5_000 })

    // Dismiss alert dialog if present
    const dialog = mainWindow.getByRole('alertdialog')
    if (await dialog.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await dialog.getByRole('button', { name: 'No' }).click()
    }

    // Find and click the tags trigger button (contains the tag pill or "None")
    const tagsLabel = mainWindow.locator('label').filter({ hasText: 'Tags' })
    const tagsButton = tagsLabel.locator('..').locator('button').first()
    await tagsButton.click()

    // Popover should show existing-tag with checkbox
    await expect(mainWindow.locator('[role="dialog"]').getByText('existing-tag')).toBeVisible({ timeout: 3_000 })
  })

  test('create tag via New tag dialog', async ({ mainWindow }) => {
    // Click "New tag" button in popover
    await mainWindow.getByRole('button', { name: 'New tag' }).click()

    // Dialog should show "New Tag" title
    await expect(mainWindow.getByRole('heading', { name: 'New Tag' })).toBeVisible({ timeout: 3_000 })

    // Fill name and submit
    const nameInput = mainWindow.locator('#tag-name')
    await nameInput.fill('created-tag')
    await mainWindow.getByRole('button', { name: 'Create' }).click()

    // Dialog should close
    await expect(mainWindow.getByRole('heading', { name: 'New Tag' })).not.toBeVisible({ timeout: 3_000 })

    // Verify tag was created in DB with correct project
    const tags = await seed(mainWindow).getTags()
    const created = tags.find((t: any) => t.name === 'created-tag')
    expect(created).toBeTruthy()
    expect(created.project_id).toBe(projectId)
  })

  test('edit tag via pencil icon opens Edit Tag dialog', async ({ mainWindow }) => {
    // Reopen the tags popover
    const tagsLabel = mainWindow.locator('label').filter({ hasText: 'Tags' })
    const tagsButton = tagsLabel.locator('..').locator('button').first()
    await tagsButton.click()

    // Hover over the existing-tag row to reveal pencil, then click it
    const tagRow = mainWindow.locator('[role="dialog"]').locator('label').filter({ hasText: 'existing-tag' })
    await tagRow.hover()
    // The pencil button is inside the colored span (not the checkbox)
    const editButton = tagRow.locator('button:not([role="checkbox"])')
    await editButton.click({ force: true })

    // Dialog must show "Edit Tag" — NOT "New Tag"
    await expect(mainWindow.getByRole('heading', { name: 'Edit Tag' })).toBeVisible({ timeout: 3_000 })
    await expect(mainWindow.getByRole('heading', { name: 'New Tag' })).not.toBeVisible()

    // Name input should be pre-filled with existing name
    const nameInput = mainWindow.locator('#tag-name')
    await expect(nameInput).toHaveValue('existing-tag')

    // Change name
    await nameInput.clear()
    await nameInput.fill('renamed-tag')

    // Click Save (not Create)
    await expect(mainWindow.getByRole('button', { name: 'Save' })).toBeVisible()
    await mainWindow.getByRole('button', { name: 'Save' }).click()

    // Dialog should close
    await expect(mainWindow.getByRole('heading', { name: 'Edit Tag' })).not.toBeVisible({ timeout: 3_000 })

    // Verify tag was updated (not duplicated) in DB
    const tags = await seed(mainWindow).getTags()
    const renamed = tags.find((t: any) => t.name === 'renamed-tag')
    const old = tags.find((t: any) => t.name === 'existing-tag')
    expect(renamed).toBeTruthy()
    expect(old).toBeUndefined()
  })
})

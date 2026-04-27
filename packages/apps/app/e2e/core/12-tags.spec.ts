import { test, expect, seed, goHome, clickProject, resetApp} from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'

test.describe('Tag management', () => {
  let projectAbbrev: string
  let projectId: string
  const tagA = `e2e-tag-${Date.now().toString().slice(-6)}`
  const tagB = `e2e-tag-2-${Date.now().toString().slice(-6)}`

  const projectSettingsDialog = (mainWindow: import('@playwright/test').Page) =>
    mainWindow.getByRole('dialog').filter({ hasText: 'Project Settings' }).last()

  const openTagsSection = async (mainWindow: import('@playwright/test').Page) => {
    await mainWindow.evaluate((id) => {
      window.dispatchEvent(new CustomEvent('open-project-settings', {
        detail: { projectId: id, tab: 'tasks/tags' }
      }))
    }, projectId)
    const dialog = projectSettingsDialog(mainWindow)
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await expect(dialog.getByRole('button', { name: 'New tag' })).toBeVisible({ timeout: 5_000 })
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Tag Test', color: '#3b82f6', path: TEST_PROJECT_PATH })
    projectId = p.id
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    await s.createTask({ projectId: p.id, title: 'Tag test task', status: 'todo' })
    await s.refreshData()
  })

  test('create tag in settings dialog', async ({ mainWindow }) => {
    await openTagsSection(mainWindow)

    await projectSettingsDialog(mainWindow).getByRole('button', { name: 'New tag' }).click()
    const createDialog = mainWindow.getByRole('dialog').filter({ hasText: 'New Tag' }).last()
    await createDialog.locator('#tag-name').fill(tagA)
    await createDialog.getByRole('button', { name: 'Create' }).click()

    // Verify tag appears in list
    await expect(projectSettingsDialog(mainWindow).getByText(tagA)).toBeVisible({ timeout: 3_000 })
  })

  test('create second tag', async ({ mainWindow }) => {
    await openTagsSection(mainWindow)
    await projectSettingsDialog(mainWindow).getByRole('button', { name: 'New tag' }).click()
    const createDialog = mainWindow.getByRole('dialog').filter({ hasText: 'New Tag' }).last()
    await createDialog.locator('#tag-name').fill(tagB)
    await createDialog.getByRole('button', { name: 'Create' }).click()
    await expect(projectSettingsDialog(mainWindow).getByText(tagB)).toBeVisible({ timeout: 3_000 })

    // Close settings
    await mainWindow.keyboard.press('Escape')
    await expect(projectSettingsDialog(mainWindow)).not.toBeVisible({ timeout: 3_000 })
  })

  test('assign tag to task via API', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const tasks = await s.getTasks()
    const task = tasks.find((t: { title: string }) => t.title === 'Tag test task')
    const tags = await s.getTags()
    const tag = tags.find((t: { name: string }) => t.name === tagA)
    expect(task).toBeTruthy()
    expect(tag).toBeTruthy()
    await s.setTagsForTask(task!.id, [tag!.id])
    await s.refreshData()

    // Verify tag assigned
    const assignedTags = await mainWindow.evaluate(
      (taskId) => window.api.taskTags.getTagsForTask(taskId),
      task!.id
    )
    expect(assignedTags.length).toBeGreaterThan(0)
  })

  test('tag pills visible in filter popover', async ({ mainWindow }) => {
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)

    // Open the Filter popover (ListFilter icon)
    const filterBtn = mainWindow.locator('button').filter({ has: mainWindow.locator('.lucide-list-filter') }).first()
    await expect(filterBtn).toBeVisible({ timeout: 5_000 })
    await filterBtn.click()

    const popover = mainWindow.locator('[data-radix-popper-content-wrapper]').last()
    // Tags section with individual tag pill buttons
    await expect(popover.locator('button').filter({ hasText: tagA }).first()).toBeVisible({ timeout: 5_000 })

    // Close popover
    await mainWindow.keyboard.press('Escape')
  })

  test('delete tag', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const tagsBefore = await s.getTags()
    const tag = tagsBefore.find((t: { name: string }) => t.name === tagB)
    expect(tag).toBeTruthy()

    await s.deleteTag(tag!.id)

    await expect
      .poll(async () => {
        const tagsAfter = await s.getTags()
        return tagsAfter.some((t: { name: string }) => t.name === tagB)
      }, { timeout: 3_000 })
      .toBe(false)
  })
})

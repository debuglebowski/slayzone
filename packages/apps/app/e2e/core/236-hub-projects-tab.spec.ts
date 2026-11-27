import { test, expect, seed, resetApp, clickSettings } from '../fixtures/electron'

/**
 * Settings → hub → Projects: every project on the hub, and New project. With the
 * local hub as the only one, the hub's tabs are Workspace pages, so this is
 * Workspace → Projects.
 */
test('the hub Projects tab lists projects and creates a new one', async ({ mainWindow }) => {
  await resetApp(mainWindow)
  const s = seed(mainWindow)
  const existing = await s.createProject({ name: 'Listed Already', color: '#0ea5e9' })
  let createdId: string | null = null
  try {
    await s.refreshData()
    await clickSettings(mainWindow)
    const view = mainWindow.getByTestId('settings-view').first()
    await view.getByTestId('settings-nav-workspace-projects').click()
    const tab = view.getByTestId('hub-projects-tab')
    await expect(tab).toBeVisible({ timeout: 10_000 })
    await expect(
      tab.locator(`[data-testid="hub-projects-row"][data-project-id="${existing.id}"]`)
    ).toContainText('Listed Already')

    await tab.getByTestId('hub-projects-new').click()
    const dialog = mainWindow
      .getByRole('dialog')
      .filter({ has: mainWindow.getByRole('heading', { name: 'Create Project' }) })
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await dialog.getByLabel('Name').fill('Made In Settings')
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(dialog).toBeHidden({ timeout: 10_000 })

    // The list refreshes on its own: the new project is there, still in Settings.
    await expect(
      tab.getByTestId('hub-projects-row').filter({ hasText: 'Made In Settings' })
    ).toHaveCount(1, {
      timeout: 10_000
    })
    createdId = (await s.getProjects()).find((p) => p.name === 'Made In Settings')?.id ?? null
    expect(createdId).toBeTruthy()

    // A row opens that project's settings.
    await tab.getByTestId('hub-projects-row').filter({ hasText: 'Made In Settings' }).click()
    await expect(view.getByTestId('settings-project-page')).toBeVisible({ timeout: 10_000 })
  } finally {
    await mainWindow.keyboard.press('Escape')
    await s.deleteProject(existing.id)
    if (createdId) await s.deleteProject(createdId)
  }
})

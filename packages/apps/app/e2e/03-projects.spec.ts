import {
  test,
  expect,
  seed,
  clickProject,
  clickAddProject,
  projectBlob,
  TEST_PROJECT_PATH,
} from './fixtures/electron'

test.describe('Projects', () => {
  test('create project via sidebar', async ({ mainWindow }) => {
    await clickAddProject(mainWindow)

    await mainWindow.getByPlaceholder('Project name').fill('Test Project')
    await mainWindow.getByPlaceholder('/path/to/repo').fill(TEST_PROJECT_PATH)
    await mainWindow.getByRole('button', { name: 'Create', exact: true }).click()

    await expect(projectBlob(mainWindow, 'TE')).toBeVisible({ timeout: 5_000 })
  })

  test('create second project', async ({ mainWindow }) => {
    await clickAddProject(mainWindow)
    await mainWindow.getByPlaceholder('Project name').fill('Second Project')
    await mainWindow.getByRole('button', { name: 'Create', exact: true }).click()

    await expect(projectBlob(mainWindow, 'SE')).toBeVisible({ timeout: 5_000 })
  })

  // Re-enabled: validate Linear integration wizard launch path.
  test('create project with Linear start option opens integration setup wizard', async ({ mainWindow }) => {
    await clickAddProject(mainWindow)
    await mainWindow.getByPlaceholder('Project name').fill('Linear Sync Project')
    await mainWindow.locator('button').filter({ hasText: 'Sync with Linear' }).first().click()
    await mainWindow.getByRole('button', { name: 'Create and continue' }).click()

    await expect(mainWindow.getByRole('heading', { name: 'Project Settings' })).toBeVisible({ timeout: 5_000 })
    await expect.poll(async () => {
      const connectVisible = await mainWindow.getByText('Connect Linear', { exact: true }).isVisible().catch(() => false)
      const continuousVisible = await mainWindow.getByText('Linear Continuous Sync', { exact: true }).isVisible().catch(() => false)
      return connectVisible || continuousVisible
    }, { timeout: 5_000 }).toBe(true)

    await mainWindow.keyboard.press('Escape')
    await expect(mainWindow.getByRole('heading', { name: 'Project Settings' })).not.toBeVisible({ timeout: 3_000 })
  })

  // Re-enabled: validate GitHub integration wizard launch path.
  test('create project with GitHub Projects option opens GitHub setup wizard', async ({ mainWindow }) => {
    await clickAddProject(mainWindow)
    await mainWindow.getByPlaceholder('Project name').fill('GitHub Sync Project')
    await mainWindow.locator('button').filter({ hasText: 'Sync with GitHub Projects' }).first().click()
    await mainWindow.getByRole('button', { name: 'Create and continue' }).click()

    await expect(mainWindow.getByRole('heading', { name: 'Project Settings' })).toBeVisible({ timeout: 5_000 })
    await expect.poll(async () => {
      const connectVisible = await mainWindow.getByText('Connect GitHub', { exact: true }).isVisible().catch(() => false)
      const continuousVisible = await mainWindow.getByText('GitHub Continuous Sync', { exact: true }).isVisible().catch(() => false)
      return connectVisible || continuousVisible
    }, { timeout: 5_000 }).toBe(true)

    await mainWindow.keyboard.press('Escape')
    await expect(mainWindow.getByRole('heading', { name: 'Project Settings' })).not.toBeVisible({ timeout: 3_000 })
  })

  // Re-enabled: verify project switching updates visible title.
  test('switch between projects', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const first = await s.createProject({ name: 'Alpha Switch', color: '#22c55e', path: TEST_PROJECT_PATH })
    const second = await s.createProject({ name: 'Beta Switch', color: '#3b82f6', path: TEST_PROJECT_PATH })
    await s.createTask({ projectId: first.id, title: 'Switch marker alpha', status: 'todo' })
    await s.createTask({ projectId: second.id, title: 'Switch marker beta', status: 'todo' })
    await s.refreshData()

    await clickProject(mainWindow, 'AL')
    await expect(mainWindow.getByText('Switch marker alpha').first()).toBeVisible({ timeout: 5_000 })

    await clickProject(mainWindow, 'BE')
    await expect(mainWindow.getByText('Switch marker beta').first()).toBeVisible({ timeout: 5_000 })
  })

  test('delete project via API', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const projects = await s.getProjects()
    const secondProject = projects.find((p: { name: string }) => p.name === 'Second Project')
    if (secondProject) {
      await s.deleteProject(secondProject.id)
    }
    await s.refreshData()

    await expect(projectBlob(mainWindow, 'SE')).not.toBeVisible({ timeout: 5_000 })
  })
})

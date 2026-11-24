import {
  test,
  expect,
  seed,
  resetApp,
  openProjectSettings,
  TEST_PROJECT_PATH
} from '../fixtures/electron'

/**
 * A project overrides a hub setting for itself (plans/settings-by-scope.md, phase 3):
 * its Agents tab starts from the hub's value, Override makes it the project's own,
 * new tasks in the project use it, and Reset goes back to the hub's.
 */
test.describe('Project setting overrides', () => {
  let projectId = ''

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    await s.setSetting('default_agent_id', 'claude-code')
    const p = await s.createProject({ name: 'Override P', color: '#3b82f6', path: TEST_PROJECT_PATH })
    projectId = p.id
    await s.refreshData()
  })

  const newTaskAgent = (page: import('@playwright/test').Page, title: string) =>
    page.evaluate(
      async ({ id, title }) => {
        const task = (await window
          .getTrpcVanillaClient()
          .task.create.mutate({ projectId: id, title, status: 'todo' })) as {
          agent_id?: string
          agentId?: string
        }
        return task.agent_id ?? task.agentId
      },
      { id: projectId, title }
    )

  test('override the default agent, new tasks use it, reset restores the hub value', async ({
    mainWindow
  }) => {
    const page = await openProjectSettings(mainWindow, 'OV', 'agents')
    const row = page.getByTestId('project-override-default_agent_id')
    await expect(row.getByTestId('override-source')).toHaveText('From hub', { timeout: 10_000 })

    await row.getByTestId('override-start').click()
    await expect(row.getByTestId('override-source')).toHaveText('Set for this project')
    await row.getByTestId('override-select').click()
    await mainWindow.getByRole('option', { name: 'Codex', exact: true }).click()
    await expect
      .poll(() =>
        mainWindow.evaluate(
          (id) =>
            window
              .getTrpcVanillaClient()
              .settings.effective.query({ key: 'default_agent_id', projectId: id }),
          projectId
        )
      )
      .toEqual({ value: 'codex', source: 'project' })
    expect(await newTaskAgent(mainWindow, 'Uses the override')).toBe('codex')
    // The hub's own default is untouched.
    expect(await seed(mainWindow).getSetting('default_agent_id')).toBe('claude-code')

    await row.getByTestId('override-reset').click()
    await expect(row.getByTestId('override-source')).toHaveText('From hub')
    expect(await newTaskAgent(mainWindow, 'Back on the hub default')).toBe('claude-code')

    await mainWindow.keyboard.press('Escape')
  })
})

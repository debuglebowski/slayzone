import { test, expect, seed, resetApp, openProjectSettings } from '../fixtures/electron'

/**
 * A project's folder on each computer, from Settings → project → Computers.
 *
 * The second computer is a seeded, never-connected row: a folder chosen for an
 * offline computer is kept on the hub as `pending` ("Waiting for computer") until it
 * connects, which is exactly the state worth showing — and needs no second process.
 */
test('set and forget a project folder on a second, offline computer', async ({
  mainWindow,
  electronApp
}) => {
  await resetApp(mainWindow)
  const s = seed(mainWindow)
  const db = (method: 'all' | 'run', query: string, params: unknown[] = []) =>
    electronApp.evaluate(
      async (_electron, { m, q, p }) => {
        const handle = (globalThis as Record<string, unknown>).__db as Record<
          'all' | 'run',
          (sql: string, params?: unknown[]) => Promise<unknown>
        >
        return handle[m](q, p)
      },
      { m: method, q: query, p: params }
    )
  await db(
    'run',
    `INSERT OR IGNORE INTO computers (id, name, platform, version, capabilities_json, last_seen_at, created_at)
     VALUES ('e2e-second-box', 'second-box', 'linux-x64', '0.0.0', '{}', 1, 1)`
  )
  const project = await s.createProject({ name: 'Folders Everywhere', color: '#0ea5e9' })
  try {
    await s.refreshData()
    const settings = await openProjectSettings(mainWindow, 'FO', 'computers')
    const tab = settings.getByTestId('project-computers-tab')
    await expect(tab).toBeVisible({ timeout: 10_000 })

    const row = tab.getByTestId('project-computer-e2e-second-box')
    await expect(row.getByTestId('project-computer-e2e-second-box-status')).toHaveText('Not set')
    await expect(row).toContainText('offline')

    await row.getByRole('button', { name: 'Type a path' }).click()
    await row.getByLabel('Folder path').fill('/srv/folders-everywhere')
    await row.getByRole('button', { name: 'Save', exact: true }).click()

    await expect(row.getByTestId('project-computer-e2e-second-box-status')).toHaveText(
      'Waiting for computer',
      { timeout: 10_000 }
    )
    await expect(row.getByTestId('project-computer-e2e-second-box-path')).toHaveText(
      '/srv/folders-everywhere'
    )
    await expect
      .poll(async () =>
        db(
          'all',
          'SELECT root_path, status FROM project_placements WHERE project_id = ? AND computer_id = ?',
          [project.id, 'e2e-second-box']
        )
      )
      .toEqual([{ root_path: '/srv/folders-everywhere', status: 'pending' }])

    // Forget: the computer is unreachable, so it is cleared for clients now and told
    // on its next connect.
    await row.getByTestId('project-computer-e2e-second-box-forget').click()
    await expect(row.getByTestId('project-computer-e2e-second-box-status')).toHaveText('Not set', {
      timeout: 10_000
    })
    await expect
      .poll(async () =>
        db(
          'all',
          'SELECT status FROM project_placements WHERE project_id = ? AND computer_id = ?',
          [project.id, 'e2e-second-box']
        )
      )
      .toEqual([{ status: 'forgotten' }])
  } finally {
    await s.deleteProject(project.id)
    await db('run', "DELETE FROM computers WHERE id = 'e2e-second-box'")
  }
})

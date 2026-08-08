import { test, expect, seed, clickProject, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'

test.describe('Edge cases', () => {
  let projectAbbrev: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('delete all projects shows empty state', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    await s.deleteAllProjects()
    await s.refreshData()

    await expect(mainWindow.getByText('create a project')).toBeVisible({ timeout: 5_000 })
  })

  test('create project after empty state restores kanban', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Restored Project',
      color: '#10b981',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    await s.refreshData()

    await clickProject(mainWindow, projectAbbrev)

    await expect(mainWindow.locator('h3').getByText('Inbox', { exact: true })).toBeVisible({
      timeout: 5_000
    })
  })

  test('create and immediately archive task', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const projects = await s.getProjects()
    const p = projects.find((pr: { name: string }) => pr.name === 'Restored Project')!
    const task = await s.createTask({
      projectId: p.id,
      title: 'Archive me immediately',
      status: 'done'
    })
    await s.archiveTask(task.id)
    await s.refreshData()

    await clickProject(mainWindow, projectAbbrev)

    await expect(mainWindow.getByText('Archive me immediately')).not.toBeVisible()
  })

  test('task dependency creates blocked and blocker tasks', async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const projects = await s.getProjects()
    const p = projects.find((pr: { name: string }) => pr.name === 'Restored Project')!
    const blocker = await s.createTask({
      projectId: p.id,
      title: 'Blocker task',
      status: 'in_progress'
    })
    const blocked = await s.createTask({
      projectId: p.id,
      title: 'Blocked task',
      status: 'todo'
    })
    await s.addBlocker(blocked.id, blocker.id)
    await s.refreshData()

    await clickProject(mainWindow, projectAbbrev)

    await expect(mainWindow.getByText('Blocker task')).toBeVisible()
    await expect(mainWindow.getByText('Blocked task')).toBeVisible()
  })
})

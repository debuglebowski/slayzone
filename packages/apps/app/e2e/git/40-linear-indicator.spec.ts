import { test, expect, seed, goHome, clickProject, resetApp} from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'

test.describe('Linear link indicator', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ electronApp, mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Linear Ind', color: '#6366f1', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'Linked task', status: 'todo' })
    taskId = t.id

    // Insert mock external_link directly via main process DB (disable FK for fake connection_id)
    await electronApp.evaluate(({ }, { taskId: tid }: { taskId: string }) => {
      const db = (globalThis as Record<string, any>).__db
      if (!db) throw new Error('__db not exposed')
      const id = crypto.randomUUID()
      db.pragma('foreign_keys = OFF')
      db.prepare(`
        INSERT INTO external_links (
          id, provider, connection_id, external_type, external_id, external_key,
          external_url, task_id, sync_state, created_at, updated_at
        ) VALUES (?, 'linear', 'fake-conn', 'issue', ?, 'LI-1', ?, ?, 'active', datetime('now'), datetime('now'))
      `).run(id, 'fake-ext-' + id, 'https://linear.app/test/issue/LI-1/linked-task', tid)
      db.pragma('foreign_keys = ON')
    }, { taskId })

    await s.refreshData()
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
  })

  test('kanban card has indigo left border for linked task', async ({ mainWindow }) => {
    const card = mainWindow.locator('[class*="border-l-indigo"]').filter({ hasText: 'Linked task' })
    await expect(card).toBeVisible({ timeout: 5_000 })
  })

  test('kanban card has Linear dot indicator', async ({ mainWindow }) => {
    // The card should contain a small indigo dot with tooltip
    const card = mainWindow.getByText('Linked task').locator('..')
    const dot = card.locator('.bg-indigo-500')
    await expect(dot).toBeVisible({ timeout: 5_000 })
  })

  test('task detail shows Linear badge in header', async ({ mainWindow }) => {
    // Open the task
    await mainWindow.getByText('Linked task').click()
    // Header should have a clickable "Linear" badge
    const badge = mainWindow.locator('a').filter({ hasText: 'Linear' }).first()
    await expect(badge).toBeVisible({ timeout: 5_000 })
  })
})

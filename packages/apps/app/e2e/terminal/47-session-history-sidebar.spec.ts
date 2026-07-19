import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import { openTaskTerminal } from '../fixtures/terminal'
import type { ElectronApplication } from 'playwright'

/**
 * Session-history sidebar: lists every agent session (one entry per distinct
 * provider conversation) tied to the MAIN agent. The listTaskSessions grouping
 * + exclusion rules are unit-covered (task/server list-task-sessions.test.ts);
 * this spec proves the live chain — agent_sessions rows → tRPC → sidebar render
 * — plus the ">1 session" gate on the toggle button.
 *
 * Sessions are seeded BEFORE the task terminal opens: the sidebar/query mounts
 * fresh per task, so its first fetch already sees the seeded set (no reliance on
 * a live spawn or the onChanged nudge).
 */
test.describe('Session history sidebar', () => {
  let projectAbbrev: string
  let projectId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Session History',
      color: '#a855f7',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    projectId = p.id
  })

  test('single-session task shows NO toggle', async ({ mainWindow, electronApp }) => {
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'One session', status: 'todo' })
    await seedSession(electronApp, { id: 'one-1', taskId: t.id, conv: 'ONE-A', createdAt: 1000 })
    await seedPrompt(electronApp, { id: 'one-p1', taskId: t.id, conv: 'ONE-A', text: 'only session', createdAt: 1001 })
    await s.refreshData()
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'One session' })

    // One distinct conversation → no history worth a separate view → no button.
    await mainWindow.waitForTimeout(400)
    await expect(mainWindow.locator('[data-testid="session-history-toggle"]:visible')).toHaveCount(0)
  })

  test('multi-session task lists sessions newest-first, docks beside messages', async ({
    mainWindow,
    electronApp
  }) => {
    const s = seed(mainWindow)
    const t = await s.createTask({ projectId, title: 'Many sessions', status: 'todo' })
    // Two distinct conversations. CONV-B is newer → must list first.
    await seedSession(electronApp, { id: 'many-1', taskId: t.id, conv: 'CONV-A', createdAt: 1000 })
    await seedPrompt(electronApp, { id: 'many-p1', taskId: t.id, conv: 'CONV-A', text: 'older session', createdAt: 1001 })
    await seedSession(electronApp, { id: 'many-2', taskId: t.id, conv: 'CONV-B', createdAt: 2000 })
    await seedPrompt(electronApp, { id: 'many-p2', taskId: t.id, conv: 'CONV-B', text: 'newer session', createdAt: 2001 })
    await s.refreshData()
    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Many sessions' })

    const toggleSel = '[data-testid="session-history-toggle"]:visible'
    const toggle = mainWindow.locator(toggleSel).first()
    await expect(toggle).toBeVisible()

    // Open the sidebar; both sessions render, newest (CONV-B) first.
    await toggle.click()
    const sidebar = mainWindow.locator('[data-testid="agent-sessions-sidebar"]:visible').first()
    await expect(sidebar).toBeVisible()
    const items = sidebar.locator('[data-testid="agent-session-item"]')
    await expect(items).toHaveCount(2)
    await expect(sidebar.getByText('newer session')).toBeVisible()
    await expect(sidebar.getByText('older session')).toBeVisible()
    await expect(items.first()).toContainText('newer session')

    // Sessions + Messages can BOTH be open side-by-side (not mutually exclusive).
    await mainWindow.locator('[data-testid="agent-prompts-toggle"]:visible').first().click()
    await expect(mainWindow.locator('[data-testid="agent-prompts-sidebar"]:visible')).toHaveCount(1)
    await expect(mainWindow.locator('[data-testid="agent-sessions-sidebar"]:visible')).toHaveCount(1)

    // The header X closes the sessions sidebar; the toggle returns to the tab bar.
    await sidebar.locator('[aria-label="Close sessions sidebar"]').click()
    await expect(mainWindow.locator('[data-testid="agent-sessions-sidebar"]:visible')).toHaveCount(0)
    await expect(mainWindow.locator(toggleSel)).toHaveCount(1)
  })
})

function seedSession(
  electronApp: ElectronApplication,
  row: { id: string; taskId: string; conv: string; createdAt: number }
): Promise<void> {
  return electronApp.evaluate(async ({}, r) => {
    const db = (globalThis as Record<string, unknown>).__db as {
      run: (sql: string, params?: unknown[]) => Promise<unknown>
    }
    await db.run(
      `INSERT INTO agent_sessions (id, mode, cwd, task_id, conversation_id, origin, status, created_at, bound_at)
       VALUES (?, 'claude-code', '/p', ?, ?, 'slay-spawned-fresh', 'dead', ?, ?)`,
      [r.id, r.taskId, r.conv, r.createdAt, r.createdAt]
    )
  }, row)
}

function seedPrompt(
  electronApp: ElectronApplication,
  row: { id: string; taskId: string; conv: string; text: string; createdAt: number }
): Promise<void> {
  return electronApp.evaluate(async ({}, r) => {
    const db = (globalThis as Record<string, unknown>).__db as {
      run: (sql: string, params?: unknown[]) => Promise<unknown>
    }
    await db.run(
      `INSERT INTO agent_prompts (id, task_id, agent_id, cli_session_id, text, created_at)
       VALUES (?, ?, 'claude-code', ?, ?, ?)`,
      [r.id, r.taskId, r.conv, r.text, r.createdAt]
    )
  }, row)
}

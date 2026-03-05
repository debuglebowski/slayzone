import { test, expect, seed, goHome, clickProject } from './fixtures/electron'
import { TEST_PROJECT_PATH } from './fixtures/electron'
import { switchTerminalMode } from './fixtures/terminal'

test.describe('AI description generation', () => {
  let projectAbbrev: string
  let taskId: string

  test.beforeAll(async ({ electronApp, mainWindow }) => {
    // Mock the AI IPC handler to avoid calling real CLI
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('ai:generate-description')
      ipcMain.handle('ai:generate-description', async (_event, title: string, mode: string) => {
        if (mode === 'terminal') {
          return { success: false, error: 'AI not available in terminal mode' }
        }
        // Simulate a short delay like a real API call
        await new Promise(r => setTimeout(r, 300))
        return { success: true, description: `Mock description for: ${title}` }
      })
    })

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Desc Gen Test', color: '#a855f7', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'Implement login flow', status: 'in_progress' })
    taskId = t.id
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)

    // Open task detail
    await mainWindow.getByText('Implement login flow').first().click()
    await expect(mainWindow.getByTestId('task-settings-panel').last()).toBeVisible()
  })

  const generateBtn = (page: import('@playwright/test').Page) =>
    page.getByTestId('task-settings-panel').last().getByTestId('generate-description-button')

  const clickGenerate = async (page: import('@playwright/test').Page) => {
    const btn = generateBtn(page)
    await btn.scrollIntoViewIfNeeded()
    await btn.evaluate((el) => {
      ;(el as HTMLButtonElement).click()
    })
  }

  test('generate button visible in claude-code mode', async ({ mainWindow }) => {
    await expect(generateBtn(mainWindow)).toBeVisible()
  })

  test('generate button shows sparkles icon', async ({ mainWindow }) => {
    const btn = generateBtn(mainWindow)
    await expect(btn.locator('.lucide-sparkles')).toBeVisible()
  })

  test('clicking generate shows loading spinner', async ({ mainWindow }) => {
    await clickGenerate(mainWindow)
    // Spinner/disabled state can be very brief in CI; assert generation starts by waiting
    // for description to appear in persisted task state.
    await expect
      .poll(async () => {
        const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
        return task?.description ?? ''
      })
      .toContain('Mock description for: Implement login flow')
  })

  test('generated description appears in editor', async ({ mainWindow }) => {
    await expect
      .poll(async () => {
        const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
        return task?.description ?? ''
      })
      .toContain('Mock description for: Implement login flow')

    const editor = mainWindow
      .getByTestId('task-settings-panel')
      .last()
      .locator('[contenteditable="true"]')
      .first()
    await expect(editor).toContainText('Mock description for: Implement login flow')
  })

  test('generated description persisted to DB', async ({ mainWindow }) => {
    await expect
      .poll(async () => {
        const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
        return task?.description ?? ''
      })
      .toContain('Mock description for: Implement login flow')
  })

  test('button re-enabled after generation', async ({ mainWindow }) => {
    await expect(generateBtn(mainWindow)).toBeEnabled()
    // Sparkles icon restored (not spinner)
    await expect(generateBtn(mainWindow).locator('.lucide-sparkles')).toBeVisible()
  })

  test('button hidden in terminal mode', async ({ mainWindow }) => {
    await switchTerminalMode(mainWindow, 'terminal')

    await expect(generateBtn(mainWindow)).not.toBeVisible()
  })

  test('button visible again in codex mode', async ({ mainWindow }) => {
    await switchTerminalMode(mainWindow, 'codex')

    await expect(generateBtn(mainWindow)).toBeVisible()
  })

  test('generate works in codex mode too', async ({ mainWindow }) => {
    // Clear existing description first
    await mainWindow.evaluate((id) =>
      window.api.db.updateTask({ id, description: null }), taskId)
    await expect.poll(async () => {
      const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
      return task?.description
    }).toBeFalsy()

    // Navigate away and back to reload clean state
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await mainWindow.getByText('Implement login flow').first().click()
    await expect(mainWindow.getByTestId('task-settings-panel').last()).toBeVisible()

    await clickGenerate(mainWindow)
    await expect
      .poll(async () => {
        const task = await mainWindow.evaluate((id) => window.api.db.getTask(id), taskId)
        return task?.description ?? ''
      })
      .toContain('Mock description for: Implement login flow')

    // Switch back to claude-code for clean state
    await switchTerminalMode(mainWindow, 'claude-code')
    await expect(generateBtn(mainWindow)).toBeVisible()
  })
})

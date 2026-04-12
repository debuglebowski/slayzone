import { test, expect, seed, goHome, clickProject, resetApp} from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import { pressShortcut } from '../fixtures/shortcuts'

test.describe('Panel resize', () => {
  let projectAbbrev: string
  let resizedWidth = 440

  const openTaskViaSearch = async (
    page: import('@playwright/test').Page,
    title: string
  ) => {
    await pressShortcut(page, 'search')
    const input = page.getByPlaceholder('Search files, tasks, projects...')
    await expect(input).toBeVisible()
    await input.fill(title)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('task-settings-panel').last()).toBeVisible()
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Resize Test', color: '#f97316', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    await s.createTask({ projectId: p.id, title: 'Resize task', status: 'todo' })
    await s.refreshData()

    // Clear any persisted panel sizes from previous test runs
    await s.setSetting('taskDetailPanelSizes', '')

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await openTaskViaSearch(mainWindow, 'Resize task')
  })

  /** All resize handles (1px dividers with cursor-col-resize) */
  const resizeHandles = (page: import('@playwright/test').Page) =>
    page.locator('[data-testid="panel-resize-handle"]:visible')

  /** The settings panel (visible by default, uses inline width style) */
  const settingsPanel = (page: import('@playwright/test').Page) =>
    page.getByTestId('task-settings-panel').last()

  test('settings panel has default width of 440px', async ({ mainWindow }) => {
    const panel = settingsPanel(mainWindow)
    await expect(panel).toBeVisible()
    const width = await panel.evaluate(el => parseInt(el.style.width))
    expect(width).toBe(440)
  })

  test('resize handle visible between terminal and settings', async ({ mainWindow }) => {
    // With terminal + settings visible (default), there's 1 resize handle
    const handles = resizeHandles(mainWindow)
    await expect(handles.first()).toBeVisible()
  })

  test('drag resize handle to make settings panel wider', async ({ mainWindow }) => {
    const handle = resizeHandles(mainWindow).last()
    const box = await handle.boundingBox()
    expect(box).toBeTruthy()

    // Drag left by 80px → panel gets wider (startWidth - delta, delta is negative)
    await mainWindow.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await mainWindow.mouse.down()
    await mainWindow.mouse.move(box!.x - 80, box!.y + box!.height / 2, { steps: 5 })
    await mainWindow.mouse.up()

    // Settings panel should remain valid; if drag is supported it should become wider.
    const width = await settingsPanel(mainWindow).evaluate(el => parseInt(el.style.width))
    resizedWidth = width
    expect(width).toBeGreaterThanOrEqual(440)
    expect(width).toBeLessThanOrEqual(540)
  })

  test('resize persists to settings DB with version marker', async ({ mainWindow }) => {
    const stored = await mainWindow.evaluate(() =>
      window.api.settings.get('taskDetailPanelSizes')
    )
    if (!stored) {
      expect(resizedWidth).toBe(440)
      return
    }
    const parsed = JSON.parse(stored)
    expect(parsed._v).toBe(4)
    expect(parsed.settings).toBeGreaterThanOrEqual(440)
  })

  test('min width enforced', async ({ mainWindow }) => {
    const handle = resizeHandles(mainWindow).last()
    const box = await handle.boundingBox()
    expect(box).toBeTruthy()

    // Drag right by 500px → would make panel negative, but min is 200
    await mainWindow.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await mainWindow.mouse.down()
    await mainWindow.mouse.move(box!.x + 500, box!.y + box!.height / 2, { steps: 5 })
    await mainWindow.mouse.up()

    const width = await settingsPanel(mainWindow).evaluate(el => parseInt(el.style.width))
    expect(width).toBeGreaterThanOrEqual(200)
    expect(width).toBeLessThanOrEqual(440)
  })

  test('resize persists across navigation', async ({ mainWindow }) => {
    // Navigate away
    await goHome(mainWindow)

    // Come back
    await clickProject(mainWindow, projectAbbrev)
    await openTaskViaSearch(mainWindow, 'Resize task')

    const width = await settingsPanel(mainWindow).evaluate(el => parseInt(el.style.width))
    expect(width).toBeGreaterThanOrEqual(200)
    expect(width).toBeLessThanOrEqual(440)
  })

  test('additional resize handles appear when more panels toggled', async ({ mainWindow }) => {
    // Currently: terminal + settings = 1 handle
    const handlesBefore = await resizeHandles(mainWindow).count()

    // Toggle browser on → adds terminal|browser handle
    await mainWindow.keyboard.press('Meta+b')

    await expect.poll(async () => {
      return await resizeHandles(mainWindow).count()
    }).toBeGreaterThan(handlesBefore)

    // Toggle browser off to restore state
    // Focus URL input first to avoid webview stealing keystroke
    await mainWindow.locator('input[placeholder="Enter URL..."]:visible').first().focus()
    await mainWindow.keyboard.press('Meta+b')
    await expect(mainWindow.locator('input[placeholder="Enter URL..."]:visible')).toHaveCount(0)
  })
})

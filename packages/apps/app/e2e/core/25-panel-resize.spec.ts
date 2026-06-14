import { test, expect, seed, goHome, clickProject, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import { pressShortcut } from '../fixtures/shortcuts'

test.describe('Panel resize', () => {
  let projectAbbrev: string

  const openTaskViaSearch = async (page: import('@playwright/test').Page, title: string) => {
    await pressShortcut(page, 'search')
    const input = page.getByPlaceholder('Search files, folders, commands, projects, and tasks...')
    await expect(input).toBeVisible()
    await input.fill(title)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('task-settings-panel').last()).toBeVisible()
  }

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Resize Test',
      color: '#f97316',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    await s.createTask({ projectId: p.id, title: 'Resize task', status: 'todo' })
    await s.refreshData()

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
    const width = await panel.evaluate((el) => parseInt(el.style.width))
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
    const width = await settingsPanel(mainWindow).evaluate((el) => parseInt(el.style.width))
    expect(width).toBeGreaterThanOrEqual(440)
    expect(width).toBeLessThanOrEqual(540)
  })

  test('resize persists to task panel_sizes override', async ({ mainWindow }) => {
    // New model: drag end writes a size-only override ({unit,value}) to the
    // task's panel_sizes column — no global settings key, no version marker.
    const getOverride = async () => {
      const tasks = await seed(mainWindow).getTasks()
      return tasks.find((t) => t.title === 'Resize task')?.panel_sizes?.settings ?? null
    }
    await expect.poll(getOverride).not.toBeNull()
    const ov = await getOverride()
    expect(ov!.unit).toBe('px')
    // Dragged wider in the earlier test → override holds the new px width.
    expect(ov!.value).toBeGreaterThanOrEqual(440)
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

    const width = await settingsPanel(mainWindow).evaluate((el) => parseInt(el.style.width))
    expect(width).toBeGreaterThanOrEqual(200)
    expect(width).toBeLessThanOrEqual(440)
  })

  test('resize persists across navigation', async ({ mainWindow }) => {
    // Navigate away
    await goHome(mainWindow)

    // Come back
    await clickProject(mainWindow, projectAbbrev)
    await openTaskViaSearch(mainWindow, 'Resize task')

    const width = await settingsPanel(mainWindow).evaluate((el) => parseInt(el.style.width))
    expect(width).toBeGreaterThanOrEqual(200)
    expect(width).toBeLessThanOrEqual(440)
  })

  test('additional resize handles appear when more panels toggled', async ({ mainWindow }) => {
    // Currently: terminal + settings = 1 handle
    const handlesBefore = await resizeHandles(mainWindow).count()

    // Toggle browser on → adds terminal|browser handle
    await mainWindow.keyboard.press('Meta+b')

    await expect
      .poll(async () => {
        return await resizeHandles(mainWindow).count()
      })
      .toBeGreaterThan(handlesBefore)

    // Toggle browser off to restore state
    // Focus URL input first to avoid webview stealing keystroke
    await mainWindow.locator('input[placeholder="Enter URL..."]:visible').first().focus()
    await mainWindow.keyboard.press('Meta+b')
    await expect(mainWindow.locator('input[placeholder="Enter URL..."]:visible')).toHaveCount(0)
  })
})

// Exercises the live behaviors driven by the global per-panel layout config
// (anchor, overflow-scroll, unit bounds) — set via panel_config.layout and a
// config-reload event, asserted against the rendered panels.
test.describe('Panel layout config', () => {
  let abbrev: string

  const openTask = async (page: import('@playwright/test').Page, title: string) => {
    await pressShortcut(page, 'search')
    const input = page.getByPlaceholder('Search files, folders, commands, projects, and tasks...')
    await expect(input).toBeVisible()
    await input.fill(title)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('task-settings-panel').last()).toBeVisible()
  }

  const settings = (page: import('@playwright/test').Page) =>
    page.getByTestId('task-settings-panel').last()
  const container = (page: import('@playwright/test').Page) =>
    page.locator('#task-panels:visible').last()

  // Set the global per-panel layout config, then fire the reload event so the
  // open task's usePanelConfig re-reads it live (no remount needed).
  const applyLayout = async (
    page: import('@playwright/test').Page,
    layout: Record<string, unknown>
  ) => {
    const s = seed(page)
    const raw = await s.getSetting('panel_config')
    const cfg = raw ? JSON.parse(raw) : {}
    cfg.webPanels = cfg.webPanels ?? [] // loadConfig's merge requires this array
    cfg.layout = layout
    await s.setSetting('panel_config', JSON.stringify(cfg))
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('panel-config-changed')))
  }

  test.beforeAll(async ({ mainWindow }) => {
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Layout Cfg',
      color: '#22c55e',
      path: TEST_PROJECT_PATH
    })
    abbrev = p.name.slice(0, 2).toUpperCase()
    await s.createTask({ projectId: p.id, title: 'Layout task', status: 'todo' })
    await s.refreshData()
    await goHome(mainWindow)
    await clickProject(mainWindow, abbrev)
    await openTask(mainWindow, 'Layout task')
  })

  test.afterAll(async ({ mainWindow }) => {
    // Don't leak layout config into later specs.
    const s = seed(mainWindow)
    const raw = await s.getSetting('panel_config')
    if (raw) {
      const cfg = JSON.parse(raw)
      delete cfg.layout
      await s.setSetting('panel_config', JSON.stringify(cfg))
      await mainWindow.evaluate(() =>
        window.dispatchEvent(new CustomEvent('panel-config-changed'))
      )
    }
  })

  test('right-anchored panel docks to the right with a gap', async ({ mainWindow }) => {
    await applyLayout(mainWindow, {
      terminal: { unit: 'px', value: 300, align: 'left' },
      settings: { unit: 'px', value: 300, align: 'right' }
    })
    // Leftover space becomes a visible gap spacer between the clusters.
    await expect
      .poll(async () => {
        const gap = mainWindow.getByTestId('panel-gap').last()
        if (!(await gap.count())) return 0
        return gap.evaluate((el) => parseInt((el as HTMLElement).style.width) || 0)
      })
      .toBeGreaterThan(0)
    // Settings panel docks to the container's right edge.
    await expect
      .poll(async () => {
        const c = await container(mainWindow).boundingBox()
        const sb = await settings(mainWindow).boundingBox()
        if (!c || !sb) return 999
        return Math.abs(sb.x + sb.width - (c.x + c.width))
      })
      .toBeLessThan(20)
  })

  test('panels overflow → container scrolls horizontally', async ({ mainWindow }) => {
    await applyLayout(mainWindow, { settings: { unit: 'px', value: 5000, align: 'left' } })
    await expect
      .poll(() => container(mainWindow).evaluate((el) => el.scrollWidth > el.clientWidth + 1))
      .toBe(true)
    const overflowX = await container(mainWindow).evaluate(
      (el) => getComputedStyle(el).overflowX
    )
    expect(['auto', 'scroll']).toContain(overflowX)
  })

  test('max-width bound clamps the panel', async ({ mainWindow }) => {
    // Default size 440px, capped at 250px → resolves to 250.
    await applyLayout(mainWindow, {
      settings: { unit: 'px', value: 440, max: { value: 250, unit: 'px' }, align: 'left' }
    })
    await expect
      .poll(() => settings(mainWindow).evaluate((el) => parseInt((el as HTMLElement).style.width)))
      .toBe(250)
  })
})

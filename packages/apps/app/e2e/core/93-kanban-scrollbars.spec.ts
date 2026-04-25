import { test, expect, seed, goHome, clickProject, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'

test.describe('Kanban scrollbars', () => {
  let projectAbbrev: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Kanban Scroll', color: '#0ea5e9', path: TEST_PROJECT_PATH })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()

    for (let i = 1; i <= 24; i++) {
      await s.createTask({ projectId: p.id, title: `Inbox overflow ${i}`, status: 'inbox' })
    }

    await s.refreshData()
    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.locator('h3').getByText('Inbox', { exact: true })).toBeVisible({ timeout: 5_000 })
  })

  test.afterAll(async ({ electronApp }) => {
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setSize(1920, 1200)
      win.center()
    })
  })

  test('board shows usable horizontal overflow only when columns exceed width', async ({ mainWindow, electronApp }) => {
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setSize(900, 800)
    })
    await expect.poll(async () => {
      return await electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        return win.getSize()
      })
    }, { timeout: 2000 }).toEqual([900, 800])

    const boardScroller = mainWindow.locator('div.overflow-x-auto').filter({
      has: mainWindow.locator('h3').getByText('Inbox', { exact: true })
    }).first()

    const state = await boardScroller.evaluate((el) => {
      const node = el as HTMLDivElement
      const before = node.scrollLeft
      node.scrollLeft = 240
      return {
        className: node.className,
        overflowX: window.getComputedStyle(node).overflowX,
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        scrollLeftBefore: before,
        scrollLeftAfter: node.scrollLeft
      }
    })

    expect(state.className).toContain('scrollbar-thin')
    expect(state.className).not.toContain('scrollbar-hide')
    expect(['auto', 'scroll']).toContain(state.overflowX)
    expect(state.scrollWidth).toBeGreaterThan(state.clientWidth)
    expect(state.scrollLeftAfter).toBeGreaterThan(state.scrollLeftBefore)
  })

  test('column shows usable vertical overflow only when cards exceed height', async ({ mainWindow, electronApp }) => {
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setSize(900, 650)
    })
    await expect.poll(async () => {
      return await electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        return win.getSize()
      })
    }, { timeout: 2000 }).toEqual([900, 650])

    const inboxColumn = mainWindow.locator('[data-testid="kanban-column"]').filter({
      has: mainWindow.locator('h3').getByText('Inbox', { exact: true })
    }).first()
    const inboxScroller = inboxColumn.locator('div.overflow-y-auto').first()

    const state = await inboxScroller.evaluate((el) => {
      const node = el as HTMLDivElement
      const before = node.scrollTop
      node.scrollTop = 320
      return {
        className: node.className,
        overflowY: window.getComputedStyle(node).overflowY,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        scrollTopBefore: before,
        scrollTopAfter: node.scrollTop
      }
    })

    expect(state.className).toContain('scrollbar-thin')
    expect(state.className).not.toContain('scrollbar-hide')
    expect(['auto', 'scroll']).toContain(state.overflowY)
    expect(state.scrollHeight).toBeGreaterThan(state.clientHeight)
    expect(state.scrollTopAfter).toBeGreaterThan(state.scrollTopBefore)
  })
})

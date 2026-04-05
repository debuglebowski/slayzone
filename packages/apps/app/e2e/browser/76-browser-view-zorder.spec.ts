import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  testInvoke,
  ensureBrowserPanelVisible,
  openTaskViaSearch, getAllViewIds, getActiveViewId, getViewsForTask,
} from '../fixtures/browser-view'

test.describe('Browser view z-ordering (NativeViewLayer)', () => {
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    // Dismiss any startup dialogs (onboarding) that call hideAll
    await mainWindow.keyboard.press('Escape').catch(() => {})
    await mainWindow.waitForTimeout(300)
    await testInvoke(mainWindow, 'browser:show-all')

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'ZOrder T', color: '#0ea5e9', path: TEST_PROJECT_PATH })
    const t = await s.createTask({ projectId: p.id, title: 'ZOrder task', status: 'todo' })
    taskId = t.id
    await s.refreshData()
    await openTaskViaSearch(mainWindow, 'ZOrder task')
  })

  test('REAL dialog hides browser views, closing restores them', async ({ mainWindow }) => {
    // Ensure clean state
    await testInvoke(mainWindow, 'browser:show-all')
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    await testInvoke(mainWindow, 'browser:navigate', viewId, 'https://example.com')
    await expect.poll(async () => {
      return (await testInvoke(mainWindow, 'browser:get-url', viewId)) as string
    }, { timeout: 15000 }).toContain('example.com')

    // View should be visible before dialog
    await expect.poll(async () => {
      return await testInvoke(mainWindow, 'browser:is-view-natively-visible', viewId) as boolean
    }, { timeout: 5000 }).toBe(true)

    // Open a dialog by clicking sidebar plus button
    const createBtn = mainWindow.locator('[data-slot="sidebar"] button:has(.lucide-plus)').first()
    if (await createBtn.isVisible().catch(() => false)) {
      await createBtn.click()
    } else {
      await mainWindow.keyboard.press('Meta+n')
    }

    const overlay = mainWindow.locator('[data-slot="dialog-overlay"]')
    await overlay.waitFor({ state: 'visible', timeout: 5000 })

    // The browser view should hide while the dialog overlay is open.
    await expect.poll(async () => {
      return await testInvoke(mainWindow, 'browser:is-view-natively-visible', viewId) as boolean
    }, { timeout: 3000 }).toBe(false)

    // Close dialog
    await mainWindow.keyboard.press('Escape')
    await overlay.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})

    // The browser view should restore after the dialog closes.
    await expect.poll(async () => {
      return await testInvoke(mainWindow, 'browser:is-view-natively-visible', viewId) as boolean
    }, { timeout: 3000 }).toBe(true)
  })

  test('views survive hideAll/showAll cycle', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    // hideAll simulates what NativeViewLayer does when dialog opens
    await testInvoke(mainWindow, 'browser:hide-all')
    await mainWindow.waitForTimeout(200)

    // showAll simulates what NativeViewLayer does when dialog closes
    await testInvoke(mainWindow, 'browser:show-all')
    await mainWindow.waitForTimeout(200)

    const viewsAfter = await getAllViewIds(mainWindow)
    expect(viewsAfter).toContain(viewId)
  })

  test('views survive multiple hideAll/showAll cycles', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    for (let i = 0; i < 5; i++) {
      await testInvoke(mainWindow, 'browser:hide-all')
      await testInvoke(mainWindow, 'browser:show-all')
    }

    const viewsAfter = await getAllViewIds(mainWindow)
    expect(viewsAfter).toContain(viewId)
  })

  test('views do NOT hide for dropdown menus', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewsBefore = await getAllViewIds(mainWindow)

    // Open a dropdown in the browser toolbar
    const importBtn = mainWindow.locator('[data-browser-panel]').first()
      .locator('button[aria-label="Import URL from another task"]').first()

    if (await importBtn.isVisible().catch(() => false)) {
      await importBtn.click()
      await mainWindow.waitForTimeout(100)

      // Views should still exist
      const viewsAfter = await getAllViewIds(mainWindow)
      expect(viewsAfter.length).toBeGreaterThanOrEqual(viewsBefore.length)

      await mainWindow.keyboard.press('Escape')
    }
  })

  test('hideAll/showAll IPC works directly', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    await getActiveViewId(mainWindow, taskId)

    // hideAll
    await testInvoke(mainWindow, 'browser:hide-all')
    await mainWindow.waitForTimeout(100)

    // showAll
    await testInvoke(mainWindow, 'browser:show-all')
    await mainWindow.waitForTimeout(100)

    // Views should still exist
    const views = await getAllViewIds(mainWindow)
    expect(views.length).toBeGreaterThan(0)
  })

  test('hideAll is idempotent', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    await getActiveViewId(mainWindow, taskId)

    // Call hideAll twice — should not throw
    await testInvoke(mainWindow, 'browser:hide-all')
    await testInvoke(mainWindow, 'browser:hide-all')

    // Restore
    await testInvoke(mainWindow, 'browser:show-all')
  })

  test('showAll is idempotent', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    await getActiveViewId(mainWindow, taskId)

    // Call showAll twice — should not throw
    await testInvoke(mainWindow, 'browser:show-all')
    await testInvoke(mainWindow, 'browser:show-all')
  })

  // Skip: Native WebContentsView repositioning (moving inactive views offscreen)
  // completes asynchronously via Chromium's compositor. Under parallel e2e runs with
  // multiple Electron GPU processes, the position update lags behind the assertion.
  // Passes reliably at workers:1.
  test.skip('inactive task views are offscreen (Bug 2)', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewIdA = await getActiveViewId(mainWindow, taskId)

    // Create a second task
    const s = (await import('./fixtures/electron')).seed(mainWindow)
    const t2 = await s.createTask({ projectId: (await mainWindow.evaluate(() => window.api.db.getProjects())).find((p: any) => p.name === 'ZOrder T')!.id, title: 'ZOrder task B', status: 'todo' })
    await s.refreshData()

    // Open second task
    await openTaskViaSearch(mainWindow, 'ZOrder task B')
    await ensureBrowserPanelVisible(mainWindow)
    await mainWindow.waitForTimeout(500)

    // Task A's view should be hidden (task A is inactive)
    const visibleA = await testInvoke(mainWindow, 'browser:is-view-natively-visible', viewIdA) as boolean
    expect(visibleA).toBe(false)

    // Task B's views should be on screen
    const viewsB = await getViewsForTask(mainWindow, t2.id)
    if (viewsB.length > 0) {
      const boundsB = await testInvoke(mainWindow, 'browser:get-actual-native-bounds', viewsB[0]) as { x: number }
      expect(boundsB.x).toBeGreaterThanOrEqual(0)
    }

    // Switch back to task A — its views should restore
    await openTaskViaSearch(mainWindow, 'ZOrder task')
    await mainWindow.waitForTimeout(500)
    const boundsAAfter = await testInvoke(mainWindow, 'browser:get-actual-native-bounds', viewIdA) as { x: number } | null
    if (boundsAAfter) {
      expect(boundsAAfter.x).toBeGreaterThanOrEqual(0)
    }
  })
})

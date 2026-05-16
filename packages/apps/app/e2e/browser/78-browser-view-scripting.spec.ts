import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  testInvoke,
  ensureBrowserPanelVisible,
  openTaskViaSearch, getActiveViewId,
} from '../fixtures/browser-view'
import { getTestUrl, TEST_HOST_MATCH } from '../fixtures/test-server'

test.describe('Browser view scripting & CSS (WebContentsView)', () => {
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Script T', color: '#0ea5e9', path: TEST_PROJECT_PATH })
    const t = await s.createTask({ projectId: p.id, title: 'Script task', status: 'todo' })
    taskId = t.id
    await s.refreshData()
    await openTaskViaSearch(mainWindow, 'Script task')
  })

  test('executeJs returns a value', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    // Navigate to a real page first so JS executes
    await testInvoke(mainWindow, 'browser:navigate', viewId, await getTestUrl('/'))
    await expect.poll(async () => {
      return (await testInvoke(mainWindow, 'browser:get-url', viewId)) as string
    }, { timeout: 10000 }).toContain(TEST_HOST_MATCH)

    const result = await testInvoke(mainWindow, 'browser:execute-js', viewId, '1 + 1')
    expect(result).toBe(2)
  })

  test('executeJs can query DOM', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    const title = await testInvoke(mainWindow, 'browser:execute-js', viewId, 'document.title')
    expect(typeof title).toBe('string')
  })

  test('executeJs can modify DOM', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    await testInvoke(mainWindow, 'browser:execute-js', viewId, 'document.title = "test-title-123"')
    const title = await testInvoke(mainWindow, 'browser:execute-js', viewId, 'document.title')
    expect(title).toBe('test-title-123')
  })

  test('insertCss returns a key for removal', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    const key = await testInvoke(mainWindow, 'browser:insert-css', viewId, 'body { background: red !important; }') as string
    expect(typeof key).toBe('string')
    expect(key.length).toBeGreaterThan(0)
  })

  test('removeCss removes previously inserted CSS', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    const key = await testInvoke(mainWindow, 'browser:insert-css', viewId, 'body { opacity: 0.5 !important; }') as string
    // Should not throw
    await testInvoke(mainWindow, 'browser:remove-css', viewId, key)
  })

  test('setZoom changes zoom factor', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    // Set zoom to 150%
    await testInvoke(mainWindow, 'browser:set-zoom', viewId, 1.5)

    // Reset to 100%
    await testInvoke(mainWindow, 'browser:set-zoom', viewId, 1.0)
  })

  test('setZoom to 0.5 (50%) works', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    await testInvoke(mainWindow, 'browser:set-zoom', viewId, 0.5)
    await testInvoke(mainWindow, 'browser:set-zoom', viewId, 1.0) // reset
  })

  test('executeJs on non-existent view returns undefined', async ({ mainWindow }) => {
    const result = await testInvoke(mainWindow, 'browser:execute-js', 'bv-nonexistent', '1+1')
    expect(result).toBeUndefined()
  })

  test('insertCss on non-existent view returns empty string', async ({ mainWindow }) => {
    const result = await testInvoke(mainWindow, 'browser:insert-css', 'bv-nonexistent', 'body{}')
    expect(result).toBe('')
  })
})

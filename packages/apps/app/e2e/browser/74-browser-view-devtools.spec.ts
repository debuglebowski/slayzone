import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  testInvoke,
  ensureBrowserPanelVisible,
  ensureBrowserPanelHidden,
  openTaskViaSearch,
  getActiveViewId
} from '../fixtures/browser-view'

// isDevToolsOpened flips before the old inspector WebContents is destroyed.
// Reopening another dock mode must wait for that native teardown too.
async function closeDevTools(page: Page, app: ElectronApplication, viewId: string) {
  const id = (await testInvoke(page, 'browser:get-web-contents-id', viewId)) as number
  const inspectorId = await app.evaluate(
    ({ webContents }, id) => webContents.fromId(id)?.devToolsWebContents?.id ?? null,
    id
  )
  await testInvoke(page, 'browser:close-devtools', viewId)
  await expect.poll(() => testInvoke(page, 'browser:is-devtools-open', viewId)).toBe(false)
  if (inspectorId !== null) {
    await expect
      .poll(() =>
        app.evaluate(({ webContents }, id) => {
          const inspector = webContents.fromId(id)
          return !inspector || inspector.isDestroyed()
        }, inspectorId)
      )
      .toBe(true)
  }
}

/**
 * Open the view's DevTools and wait for Electron's `devtools-opened`: armed in main
 * BEFORE asking, so a fast open is not missed. Polling isDevToolsOpened for 5 s timed
 * out while a loaded machine was still booting the inspector.
 */
async function openDevTools(page: Page, app: ElectronApplication, viewId: string, mode: string) {
  const id = (await testInvoke(page, 'browser:get-web-contents-id', viewId)) as number
  await app.evaluate(({ webContents }, id) => {
    const wc = webContents.fromId(id)
    const g = globalThis as { __e2eDevtoolsOpened?: Promise<void> }
    g.__e2eDevtoolsOpened = new Promise<void>((resolve) => {
      if (!wc) return
      wc.once('devtools-opened', () => resolve())
    })
  }, id)
  await testInvoke(page, 'browser:open-devtools', viewId, mode)
  await app.evaluate(
    () => (globalThis as { __e2eDevtoolsOpened?: Promise<void> }).__e2eDevtoolsOpened
  )
  expect(await testInvoke(page, 'browser:is-devtools-open', viewId)).toBe(true)
}

test.describe('Browser view DevTools (WebContentsView)', () => {
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'DevTool T',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    const t = await s.createTask({ projectId: p.id, title: 'DevTools task', status: 'todo' })
    taskId = t.id
    await s.refreshData()
    await openTaskViaSearch(mainWindow, 'DevTools task')
  })

  test('devtools starts closed', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)
    const isOpen = (await testInvoke(mainWindow, 'browser:is-devtools-open', viewId)) as boolean
    expect(isOpen).toBe(false)
  })

  test('open devtools docked bottom', async ({ mainWindow, electronApp }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    await openDevTools(mainWindow, electronApp, viewId, 'bottom')

    await closeDevTools(mainWindow, electronApp, viewId)
    await expect.poll(() => testInvoke(mainWindow, 'browser:is-devtools-open', viewId)).toBe(false)
  })

  test('open devtools docked right', async ({ mainWindow, electronApp }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    await openDevTools(mainWindow, electronApp, viewId, 'right')

    await closeDevTools(mainWindow, electronApp, viewId)
    await expect.poll(() => testInvoke(mainWindow, 'browser:is-devtools-open', viewId)).toBe(false)
  })

  test('open devtools undocked', async ({ mainWindow, electronApp }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    await openDevTools(mainWindow, electronApp, viewId, 'undocked')

    await closeDevTools(mainWindow, electronApp, viewId)
    await expect.poll(() => testInvoke(mainWindow, 'browser:is-devtools-open', viewId)).toBe(false)
  })

  test('open devtools detached', async ({ mainWindow, electronApp }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    await openDevTools(mainWindow, electronApp, viewId, 'detach')

    await closeDevTools(mainWindow, electronApp, viewId)
    await expect.poll(() => testInvoke(mainWindow, 'browser:is-devtools-open', viewId)).toBe(false)
  })

  test('close devtools is idempotent', async ({ mainWindow, electronApp }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    // Close when already closed — should not throw
    await closeDevTools(mainWindow, electronApp, viewId)
    await expect.poll(() => testInvoke(mainWindow, 'browser:is-devtools-open', viewId)).toBe(false)
    const isOpen = (await testInvoke(mainWindow, 'browser:is-devtools-open', viewId)) as boolean
    expect(isOpen).toBe(false)
  })

  test('open devtools toggle cycle', async ({ mainWindow, electronApp }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    // Open
    await openDevTools(mainWindow, electronApp, viewId, 'bottom')

    // Close
    await closeDevTools(mainWindow, electronApp, viewId)
    await expect.poll(() => testInvoke(mainWindow, 'browser:is-devtools-open', viewId)).toBe(false)

    // Re-open
    await openDevTools(mainWindow, electronApp, viewId, 'bottom')

    // Final close
    await closeDevTools(mainWindow, electronApp, viewId)
    await expect.poll(() => testInvoke(mainWindow, 'browser:is-devtools-open', viewId)).toBe(false)
  })

  test('devtools on destroyed view returns false (not crash)', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)

    // Create a view, destroy it, then query devtools
    const viewId = await getActiveViewId(mainWindow, taskId)
    await testInvoke(mainWindow, 'browser:destroy-view', viewId)

    const isOpen = (await testInvoke(mainWindow, 'browser:is-devtools-open', viewId)) as boolean
    expect(isOpen).toBe(false)

    // Restore panel
    await ensureBrowserPanelHidden(mainWindow)
    await ensureBrowserPanelVisible(mainWindow)
  })

  test('open devtools on destroyed view does not crash', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)
    await testInvoke(mainWindow, 'browser:destroy-view', viewId)

    // Should not throw
    await testInvoke(mainWindow, 'browser:open-devtools', viewId, 'bottom')

    // Restore panel
    await ensureBrowserPanelHidden(mainWindow)
    await ensureBrowserPanelVisible(mainWindow)
  })
})

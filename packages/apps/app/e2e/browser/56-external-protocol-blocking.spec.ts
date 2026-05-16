/**
 * Verifies that external protocol URLs (figma://, slack://, etc.) triggered inside
 * browser views do not escape to the OS via shell.openExternal.
 *
 * The browser panel now uses managed WebContentsView instances, not renderer-owned
 * <webview> DOM nodes, so this spec exercises the current IPC/browser-view surface.
 */
import { test, expect, seed, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  testInvoke,
  ensureBrowserPanelVisible,
  openTaskViaSearch,
  getViewsForTask,
  newTabBtn,
} from '../fixtures/browser-view'
import { getTestUrl, TEST_HOST_MATCH } from '../fixtures/test-server'

type ElectronApp = import('playwright').ElectronApplication
type Page = import('@playwright/test').Page

test.describe('External protocol blocking', () => {
  let taskId: string

  const clearOpenExternalCalls = async (electronApp: ElectronApp) => {
    await electronApp.evaluate(() => {
      const globalState = globalThis as unknown as {
        __externalProtocolOpenExternalCalls?: Array<{ url: string }>
      }
      globalState.__externalProtocolOpenExternalCalls = []
    })
  }

  const getOpenExternalCalls = async (electronApp: ElectronApp) =>
    electronApp.evaluate(() => {
      const globalState = globalThis as unknown as {
        __externalProtocolOpenExternalCalls?: Array<{ url: string }>
      }
      return globalState.__externalProtocolOpenExternalCalls ?? []
    })

  const prepareBrowserView = async (page: Page): Promise<string> => {
    await ensureBrowserPanelVisible(page)
    const existingViewIds = await getViewsForTask(page, taskId)
    await newTabBtn(page).click()

    let viewId = ''
    await expect.poll(async () => {
      const nextViewIds = await getViewsForTask(page, taskId)
      viewId = nextViewIds.find((candidate) => !existingViewIds.includes(candidate)) ?? ''
      return viewId
    }, { timeout: 10000 }).toBeTruthy()

    await testInvoke(page, 'browser:navigate', viewId, await getTestUrl('/'))
    await expect.poll(async () => {
      return String(await testInvoke(page, 'browser:get-url', viewId) ?? '')
    }, { timeout: 15000 }).toContain(TEST_HOST_MATCH)

    await expect.poll(async () => {
      const readyState = await testInvoke(page, 'browser:execute-js', viewId, 'document.readyState')
      return readyState === 'complete' || readyState === 'interactive'
    }, { timeout: 10000 }).toBe(true)

    return viewId
  }

  const expectViewStillQueryable = async (page: Page, viewId: string) => {
    const readyState = await testInvoke(page, 'browser:execute-js', viewId, 'document.readyState')
    expect(typeof readyState).toBe('string')

    const currentUrl = await testInvoke(page, 'browser:get-url', viewId)
    expect(typeof currentUrl).toBe('string')
  }

  test.beforeAll(async ({ electronApp, mainWindow }) => {
    await resetApp(mainWindow)

    const patchResult = await electronApp.evaluate(({ shell }) => {
      const globalState = globalThis as unknown as {
        __externalProtocolOpenExternalCalls?: Array<{ url: string }>
        __externalProtocolOriginalOpenExternal?: typeof shell.openExternal
        __externalProtocolPatchError?: string | null
      }
      globalState.__externalProtocolOpenExternalCalls = []
      globalState.__externalProtocolPatchError = null

      if (!globalState.__externalProtocolOriginalOpenExternal) {
        globalState.__externalProtocolOriginalOpenExternal = shell.openExternal.bind(shell)
      }

      try {
        Object.defineProperty(shell, 'openExternal', {
          configurable: true,
          writable: true,
          value: async (url: string) => {
            globalState.__externalProtocolOpenExternalCalls?.push({ url })
          },
        })
        return { ok: true as const, error: null }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        globalState.__externalProtocolPatchError = message
        return { ok: false as const, error: message }
      }
    })
    expect(patchResult.ok, patchResult.error ?? 'Failed to patch shell.openExternal').toBe(true)

    const s = seed(mainWindow)
    const project = await s.createProject({
      name: 'ProtoBlock',
      color: '#6366f1',
      path: TEST_PROJECT_PATH,
    })
    const task = await s.createTask({
      projectId: project.id,
      title: 'Protocol blocking task',
      status: 'todo',
    })
    taskId = task.id
    await s.refreshData()

    await openTaskViaSearch(mainWindow, 'Protocol blocking task')
  })

  test.afterAll(async ({ electronApp }) => {
    await electronApp.evaluate(({ shell }) => {
      const globalState = globalThis as unknown as {
        __externalProtocolOriginalOpenExternal?: typeof shell.openExternal
        __externalProtocolOpenExternalCalls?: Array<{ url: string }>
      }

      if (globalState.__externalProtocolOriginalOpenExternal) {
        Object.defineProperty(shell, 'openExternal', {
          configurable: true,
          writable: true,
          value: globalState.__externalProtocolOriginalOpenExternal,
        })
      }

      delete globalState.__externalProtocolOriginalOpenExternal
      delete globalState.__externalProtocolOpenExternalCalls
    })
  })

  test.beforeEach(async ({ electronApp }) => {
    await clearOpenExternalCalls(electronApp)
  })

  const schemes = ['figma', 'notion', 'slack', 'linear', 'vscode', 'cursor'] as const

  for (const scheme of schemes) {
    test(`blocks ${scheme}:// via window.open`, async ({ electronApp, mainWindow }) => {
      const viewId = await prepareBrowserView(mainWindow)

      const result = await testInvoke(mainWindow, 'browser:execute-js', viewId, `
        new Promise((resolve) => {
          const popup = window.open('${scheme}://blocked-by-slayzone', '_blank')
          if (!popup) {
            resolve(JSON.stringify({ popupIsNull: true, popupHref: null }))
            return
          }
          setTimeout(() => {
            let popupHref = null
            try {
              popupHref = popup.location.href
              popup.close()
            } catch {
              popupHref = 'cross-origin'
            }
            resolve(JSON.stringify({ popupIsNull: false, popupHref }))
          }, 400)
        })
      `)

      const parsed = JSON.parse(String(result))
      expect(parsed.popupIsNull).toBe(true)
      expect(await getOpenExternalCalls(electronApp)).toHaveLength(0)
      await expectViewStillQueryable(mainWindow, viewId)
    })

    test(`blocks ${scheme}:// via anchor click`, async ({ electronApp, mainWindow }) => {
      const viewId = await prepareBrowserView(mainWindow)

      await testInvoke(mainWindow, 'browser:execute-js', viewId, `
        new Promise((resolve) => {
          const a = document.createElement('a')
          a.href = '${scheme}://blocked-by-slayzone'
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          setTimeout(() => resolve(window.location.href), 1000)
        })
      `)

      expect(await getOpenExternalCalls(electronApp)).toHaveLength(0)
      await expectViewStillQueryable(mainWindow, viewId)
    })

    test(`blocks ${scheme}:// via window.location`, async ({ electronApp, mainWindow }) => {
      const viewId = await prepareBrowserView(mainWindow)

      await testInvoke(mainWindow, 'browser:execute-js', viewId, `
        window.location.href = '${scheme}://blocked-by-slayzone'
        window.location.href
      `)

      expect(await getOpenExternalCalls(electronApp)).toHaveLength(0)
      await expectViewStillQueryable(mainWindow, viewId)
    })

    test(`blocks ${scheme}:// via hidden iframe`, async ({ electronApp, mainWindow }) => {
      const viewId = await prepareBrowserView(mainWindow)

      await testInvoke(mainWindow, 'browser:execute-js', viewId, `
        new Promise((resolve) => {
          const iframe = document.createElement('iframe')
          iframe.onload = () => resolve(window.location.href)
          iframe.onerror = () => resolve(window.location.href)
          iframe.src = '${scheme}://blocked-by-slayzone'
          document.body.appendChild(iframe)
          setTimeout(() => resolve(window.location.href), 1000)
        })
      `)

      expect(await getOpenExternalCalls(electronApp)).toHaveLength(0)
      await expectViewStillQueryable(mainWindow, viewId)
    })
  }
})

import { test, expect, seed, goHome, clickProject, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'

test.describe('Web panel handoff routing', () => {
    const PANEL_ID = 'web:handoff-e2e'
    const PANEL_NAME = 'Handoff Panel'
    const PANEL_SHORTCUT = 'o'
    let projectAbbrev: string

    const clearOpenExternalCalls = async (
      electronApp: import('playwright').ElectronApplication
    ) => {
      await electronApp.evaluate(() => {
        const globalState = globalThis as unknown as {
          __handoffOpenExternalCalls?: Array<{ url: string }>
        }
        globalState.__handoffOpenExternalCalls = []
      })
    }

    const getOpenExternalCalls = async (electronApp: import('playwright').ElectronApplication) => {
      return await electronApp.evaluate(() => {
        const globalState = globalThis as unknown as {
          __handoffOpenExternalCalls?: Array<{ url: string }>
        }
        return globalState.__handoffOpenExternalCalls ?? []
      })
    }

    // Web panels migrated from <webview> to WebContentsView. Query main-process
    // BrowserViewManager via test-only IPC instead of DOM.
    const getWebPanelViewId = async (mainWindow: import('@playwright/test').Page) => {
      return await mainWindow.evaluate(async () => {
        type V = { viewId: string; partition: string; kind: string }
        const views = (await window.getTrpcVanillaClient().app.browser.listViews.query()) as V[]
        const wp = views.find((v) => v.partition === 'persist:web-panels' && v.kind === 'web-panel')
        return wp?.viewId ?? null
      })
    }

    // NOTE: a WCV that never loaded a page reports getURL() === '' —
    // BrowserViewManager.createView deliberately skips loading 'about:blank'.
    // getWebPanelUrl normalizes '' to 'about:blank' ("blank panel" either way),
    // but resetWebPanelToAboutBlank must force a REAL about:blank load for '':
    // executeJavaScript on a never-loaded frame queues forever (popup helpers hang).
    const getWebPanelUrl = async (mainWindow: import('@playwright/test').Page) => {
      return await mainWindow.evaluate(async () => {
        type V = { viewId: string; partition: string; kind: string; url: string }
        const views = (await window.getTrpcVanillaClient().app.browser.listViews.query()) as V[]
        const wp = views.find((v) => v.partition === 'persist:web-panels' && v.kind === 'web-panel')
        if (!wp) return 'no-webview'
        return wp.url === '' ? 'about:blank' : wp.url
      })
    }

    const resetWebPanelToAboutBlank = async (mainWindow: import('@playwright/test').Page) => {
      return await mainWindow.evaluate(async () => {
        type V = { viewId: string; partition: string; kind: string; url: string }
        const views = (await window.getTrpcVanillaClient().app.browser.listViews.query()) as V[]
        const wp = views.find((v) => v.partition === 'persist:web-panels' && v.kind === 'web-panel')
        if (!wp) return 'no-webview'
        // '' = never loaded — must still navigate so the frame gets a real document.
        if (wp.url === 'about:blank') return 'about:blank'
        await window
          .getTrpcVanillaClient()
          .app.browser.navigate.mutate({ viewId: wp.viewId, url: 'about:blank' })
        await new Promise((resolve) => setTimeout(resolve, 700))
        const after = (await window.getTrpcVanillaClient().app.browser.listViews.query()) as V[]
        const url = after.find((v) => v.viewId === wp.viewId)?.url
        if (url === undefined) return 'no-webview'
        return url
      })
    }

    const triggerPopupFromWebPanel = async (
      mainWindow: import('@playwright/test').Page,
      popupUrl: string
    ) => {
      return await mainWindow.evaluate(async (targetUrl) => {
        type V = { viewId: string; partition: string; kind: string; url: string }
        const views = (await window.getTrpcVanillaClient().app.browser.listViews.query()) as V[]
        const wp = views.find((v) => v.partition === 'persist:web-panels' && v.kind === 'web-panel')
        if (!wp) return 'no-webview'
        // Inject a synthetic window.open via executeJs to provoke the popup handler.
        // `void` so executeJavaScript never tries to serialize a WindowProxy result.
        await window.getTrpcVanillaClient().app.browser.executeJs.mutate({
          viewId: wp.viewId,
          code: `void window.open(${JSON.stringify(targetUrl)}, '_blank')`
        })
        await new Promise((resolve) => setTimeout(resolve, 900))
        const after = (await window.getTrpcVanillaClient().app.browser.listViews.query()) as V[]
        const url = after.find((v) => v.viewId === wp.viewId)?.url
        if (url === undefined) return 'no-webview'
        return url === '' ? 'about:blank' : url
      }, popupUrl)
    }

    test.beforeAll(async ({ electronApp, mainWindow }) => {
      await resetApp(mainWindow)
      const patchResult = await electronApp.evaluate(({ shell }) => {
        const globalState = globalThis as unknown as {
          __handoffOpenExternalCalls?: Array<{ url: string }>
          __handoffOriginalOpenExternal?: typeof shell.openExternal
          __handoffPatchError?: string | null
        }
        globalState.__handoffOpenExternalCalls = []
        globalState.__handoffPatchError = null
        if (!globalState.__handoffOriginalOpenExternal) {
          globalState.__handoffOriginalOpenExternal = shell.openExternal.bind(shell)
        }

        try {
          Object.defineProperty(shell, 'openExternal', {
            configurable: true,
            writable: true,
            value: async (url: string) => {
              globalState.__handoffOpenExternalCalls?.push({ url })
            }
          })
          return { ok: true as const, error: null }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          globalState.__handoffPatchError = message
          return { ok: false as const, error: message }
        }
      })
      expect(patchResult.ok, patchResult.error ?? 'Failed to patch shell.openExternal').toBe(true)

      const panelConfig = {
        viewEnabled: {
          task: {
            terminal: true,
            browser: true,
            editor: true,
            diff: true,
            settings: true,
            processes: true,
            [PANEL_ID]: true
          }
        },
        webPanels: [
          {
            id: PANEL_ID,
            name: PANEL_NAME,
            baseUrl: 'https://figma.com',
            shortcut: PANEL_SHORTCUT,
            blockDesktopHandoff: true,
            handoffProtocol: 'figma',
            handoffHostScope: 'figma.com'
          }
        ]
      }

      const s = seed(mainWindow)
      await s.setSetting('panel_config', JSON.stringify(panelConfig))

      const project = await s.createProject({
        name: 'HandoffRouting',
        color: '#14b8a6',
        path: TEST_PROJECT_PATH
      })
      projectAbbrev = project.name.slice(0, 2).toUpperCase()
      const task = await s.createTask({
        projectId: project.id,
        title: 'Handoff routing task',
        status: 'todo'
      })

      await mainWindow.evaluate(
        ({ taskId, panelId }) =>
          window.getTrpcVanillaClient().task.update.mutate({
            id: taskId,
            webPanelUrls: { [panelId]: 'about:blank' }
          }),
        { taskId: task.id, panelId: PANEL_ID }
      )
      await s.refreshData()

      await goHome(mainWindow)
      await clickProject(mainWindow, projectAbbrev)
      await expect(mainWindow.getByText('Handoff routing task').first()).toBeVisible({
        timeout: 5_000
      })
      await mainWindow.getByText('Handoff routing task').first().click()
      await expect(
        mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()
      ).toBeVisible({
        timeout: 5_000
      })

      // Open the web panel via its header toggle button. Don't use the seeded
      // keyboard shortcut: built-in panel bindings (e.g. panel-terminal = Cmd+O)
      // are matched first in TaskDetailPage's keydown chain, so a colliding
      // letter silently toggles the wrong panel.
      const panelToggle = mainWindow.locator('button').filter({ hasText: PANEL_NAME }).last()
      await expect(panelToggle).toBeVisible({ timeout: 5_000 })
      await panelToggle.click()
      // Wait for the WCV to register, then force a REAL about:blank load
      // (createView skips loading 'about:blank', leaving the frame document-less).
      await expect.poll(() => getWebPanelViewId(mainWindow), { timeout: 10_000 }).not.toBeNull()
      await expect
        .poll(() => resetWebPanelToAboutBlank(mainWindow), { timeout: 10_000 })
        .toBe('about:blank')
    })

    test.afterAll(async ({ electronApp }) => {
      await electronApp.evaluate(({ shell }) => {
        const globalState = globalThis as unknown as {
          __handoffOriginalOpenExternal?: typeof shell.openExternal
          __handoffOpenExternalCalls?: Array<{ url: string }>
        }
        if (globalState.__handoffOriginalOpenExternal) {
          Object.defineProperty(shell, 'openExternal', {
            configurable: true,
            writable: true,
            value: globalState.__handoffOriginalOpenExternal
          })
        }
        delete globalState.__handoffOriginalOpenExternal
        delete globalState.__handoffOpenExternalCalls
      })
    })

    test.beforeEach(async ({ electronApp, mainWindow }) => {
      await clearOpenExternalCalls(electronApp)
      await expect
        .poll(() => resetWebPanelToAboutBlank(mainWindow), { timeout: 5_000 })
        .toBe('about:blank')
    })

    test('shell.openExternal blocks loopback URLs when desktop handoff policy is provided', async ({
      electronApp,
      mainWindow
    }) => {
      const result = await mainWindow.evaluate(async () => {
        try {
          await window.getTrpcVanillaClient().app.shell.openExternal.mutate({
            url: 'http://127.0.0.1:38495/open',
            options: {
              desktopHandoff: { protocol: 'figma', hostScope: 'figma.com' }
            }
          })
          return { blocked: false, error: null }
        } catch (error) {
          return { blocked: true, error: error instanceof Error ? error.message : String(error) }
        }
      })

      expect(result.blocked).toBe(true)
      expect(result.error).toContain('Blocked external app handoff URL')
      const calls = await getOpenExternalCalls(electronApp)
      expect(calls).toHaveLength(0)
    })

    test('same-host popups stay in-panel and do not call shell.openExternal', async ({
      electronApp,
      mainWindow
    }) => {
      await triggerPopupFromWebPanel(
        mainWindow,
        'https://www.figma.com/oauth/authorize?client_id=slayzone-e2e'
      )

      // Poll: navigating the WCV to an external URL (figma.com) can outlast the
      // helper's fixed post-trigger wait when the machine is loaded.
      await expect
        .poll(() => getWebPanelUrl(mainWindow), { timeout: 15_000 })
        .not.toBe('about:blank')
      const calls = await getOpenExternalCalls(electronApp)
      expect(calls).toHaveLength(0)
    })

    test('cross-host popups call shell.openExternal and keep panel URL unchanged', async ({
      electronApp,
      mainWindow
    }) => {
      const targetUrl = 'https://example.com/slayzone-cross-host-popup'
      const currentUrl = await triggerPopupFromWebPanel(mainWindow, targetUrl)

      expect(currentUrl).toBe('about:blank')
      const calls = await getOpenExternalCalls(electronApp)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe(targetUrl)
    })

    test('loopback popups are blocked in blocked panels and not opened externally', async ({
      electronApp,
      mainWindow
    }) => {
      const currentUrl = await triggerPopupFromWebPanel(
        mainWindow,
        'http://127.0.0.1:38495/open-handoff'
      )

      expect(currentUrl).toBe('about:blank')
      const calls = await getOpenExternalCalls(electronApp)
      expect(calls).toHaveLength(0)
    })
  })

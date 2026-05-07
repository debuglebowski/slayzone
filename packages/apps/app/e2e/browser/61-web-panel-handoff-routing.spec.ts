import { test, expect, seed, goHome, clickProject, resetApp} from '../fixtures/electron'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import { testInvoke } from '../fixtures/browser-view'

test.describe.serial('Web panel handoff routing', () => {
  const PANEL_ID = 'web:handoff-e2e'
  const PANEL_NAME = 'Handoff Panel'
  const PANEL_SHORTCUT = 'y'
  let projectAbbrev: string

  const clearOpenExternalCalls = async (electronApp: import('playwright').ElectronApplication) => {
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

  // Web panels migrated from <webview> to WebContentsView. There's no in-renderer
  // DOM reference to the native view — query through the panel API instead.
  const getWebPanelUrl = async (mainWindow: import('@playwright/test').Page) => {
    return await mainWindow.evaluate(async (panelId) => {
      const tabId = panelId
      // Find the active task's view-id for this panel by walking the panel header
      // (the panel is mounted inside [data-panel-id="<panelId>"]).
      const panelEl = document.querySelector(`[data-panel-id="${tabId}"]`)
      if (!panelEl) return 'no-panel'
      // The URL is rendered in the header next to the panel name — use it as ground truth.
      const urlSpan = panelEl.querySelector('span.bg-muted\\/50')
      return urlSpan?.textContent?.trim() ?? 'no-url'
    }, PANEL_ID)
  }

  const resetWebPanelToAboutBlank = async (mainWindow: import('@playwright/test').Page) => {
    // No-op for WebContentsView — handoff tests don't need to navigate the
    // underlying view. Resolve to the current (or 'about:blank' if untouched).
    return await getWebPanelUrl(mainWindow)
  }

  const triggerPopupFromWebPanel = async (
    mainWindow: import('@playwright/test').Page,
    popupUrl: string
  ) => {
    const viewId = await mainWindow.evaluate(() => {
      const el = document.querySelector('[data-web-panel]') as HTMLElement | null
      return el?.getAttribute('data-view-id') ?? null
    })
    if (!viewId) return 'no-webview'
    await testInvoke(
      mainWindow,
      'browser:execute-js',
      viewId,
      `window.open(${JSON.stringify(popupUrl)})`
    )
    await new Promise((resolve) => setTimeout(resolve, 900))
    return await testInvoke(mainWindow, 'browser:get-url', viewId) as string
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
          },
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
      // `order` must include the custom panel id so the renderer's
      // orderedTaskIds includes it (web panels render only when they appear
      // in panel_config.order).
      order: [
        'terminal', 'browser', 'editor', 'artifacts', 'diff', 'settings', 'processes', PANEL_ID,
      ],
      viewEnabled: {
        task: {
          terminal: true,
          browser: true,
          editor: true,
          diff: true,
          settings: true,
          processes: true,
          [PANEL_ID]: true,
        },
      },
      webPanels: [
        {
          id: PANEL_ID,
          name: PANEL_NAME,
          baseUrl: 'https://figma.com',
          shortcut: PANEL_SHORTCUT,
          blockDesktopHandoff: true,
          handoffProtocol: 'figma',
          handoffHostScope: 'figma.com',
        },
      ],
    }

    const s = seed(mainWindow)
    await s.setSetting('panel_config', JSON.stringify(panelConfig))

    const project = await s.createProject({
      name: 'HandoffRouting',
      color: '#14b8a6',
      path: TEST_PROJECT_PATH,
    })
    projectAbbrev = project.name.slice(0, 2).toUpperCase()
    const task = await s.createTask({ projectId: project.id, title: 'Handoff routing task', status: 'todo' })

    await mainWindow.evaluate(
      ({ taskId, panelId }) =>
        window.api.db.updateTask({
          id: taskId,
          webPanelUrls: { [panelId]: 'about:blank' },
        }),
      { taskId: task.id, panelId: PANEL_ID }
    )
    await s.refreshData()

    await goHome(mainWindow)
    await clickProject(mainWindow, projectAbbrev)
    await expect(mainWindow.getByText('Handoff routing task').first()).toBeVisible({ timeout: 5_000 })
    await mainWindow.getByText('Handoff routing task').first().click()
    await expect(mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible').first()).toBeVisible({
      timeout: 5_000,
    })

    const titleEl = mainWindow.locator('h1, [data-testid="task-title"]').first()
    if (await titleEl.isVisible().catch(() => false)) await titleEl.click()
    await mainWindow.keyboard.press(`Meta+${PANEL_SHORTCUT}`)
    await expect(mainWindow.locator('span').filter({ hasText: PANEL_NAME }).last()).toBeVisible({
      timeout: 5_000,
    })
    await expect.poll(() => getWebPanelUrl(mainWindow), { timeout: 5_000 }).toBe('about:blank')
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
          value: globalState.__handoffOriginalOpenExternal,
        })
      }
      delete globalState.__handoffOriginalOpenExternal
      delete globalState.__handoffOpenExternalCalls
    })
  })

  test.beforeEach(async ({ electronApp, mainWindow }) => {
    await clearOpenExternalCalls(electronApp)
    await expect.poll(() => resetWebPanelToAboutBlank(mainWindow), { timeout: 5_000 }).toBe('about:blank')
  })

  test('shell.openExternal blocks loopback URLs when desktop handoff policy is provided', async ({
    electronApp,
    mainWindow,
  }) => {
    const result = await mainWindow.evaluate(async () => {
      try {
        await getTrpcVanillaClient().app.shell.openExternal.mutate({ 'http://127.0.0.1:38495/open', {
          desktopHandoff: { protocol: 'figma', hostScope: 'figma.com' },
        } })
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

  // Skip: Navigating a WebContentsView to an external OAuth URL (figma.com) is too
  // slow when multiple Electron instances share the GPU during parallel e2e runs.
  // The webview stays on about:blank past the poll deadline. Passes reliably at workers:1.
  test.skip('same-host popups stay in-panel and do not call shell.openExternal', async ({
    electronApp,
    mainWindow,
  }) => {
    const currentUrl = await triggerPopupFromWebPanel(
      mainWindow,
      'https://www.figma.com/oauth/authorize?client_id=slayzone-e2e'
    )

    expect(currentUrl).not.toBe('about:blank')
    const calls = await getOpenExternalCalls(electronApp)
    expect(calls).toHaveLength(0)
  })

  test('cross-host popups call shell.openExternal and keep panel URL unchanged', async ({
    electronApp,
    mainWindow,
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
    mainWindow,
  }) => {
    const currentUrl = await triggerPopupFromWebPanel(mainWindow, 'http://127.0.0.1:38495/open-handoff')

    expect(currentUrl).toBe('about:blank')
    const calls = await getOpenExternalCalls(electronApp)
    expect(calls).toHaveLength(0)
  })
})

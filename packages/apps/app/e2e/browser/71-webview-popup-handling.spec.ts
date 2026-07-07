/**
 * Tests that webview popup/new-window handling works correctly:
 * - OAuth popups (window.open with features) create real BrowserWindows
 * - Regular links (target="_blank") create new browser tabs, not windows
 * - Web panels (WebContentsView): window.open WITH features is allowed (real
 *   BrowserWindow on the panel session so OAuth cookies propagate), while
 *   featureless popups are denied in main and routed through the renderer's
 *   handoff-aware popup handler (in-panel / openExternal / suppressed)
 * - Child popup windows cannot spawn grandchildren
 * - Popup windows are cleaned up when parent webview is destroyed
 * - Popup windows share session with parent webview
 */
import { test, expect, seed, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  ensureBrowserPanelVisible,
  focusForAppShortcut,
  openTaskViaSearch,
  getActiveViewId,
  testInvoke,
  tabEntries,
  urlInput
} from '../fixtures/browser-view'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ElectronApp = import('playwright').ElectronApplication
type Page = import('@playwright/test').Page

/** Snapshot all BrowserWindow IDs. */
const getWindowIds = async (electronApp: ElectronApp): Promise<number[]> =>
  electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed())
      .map((w) => w.id)
  )

/** Return IDs of windows that appeared since a baseline snapshot. */
const getNewWindowIds = async (
  electronApp: ElectronApp,
  baselineIds: number[]
): Promise<number[]> => {
  const current = await getWindowIds(electronApp)
  return current.filter((id) => !baselineIds.includes(id))
}

/** Close specific windows by ID. */
const closeWindowsByIds = async (electronApp: ElectronApp, ids: number[]) =>
  electronApp.evaluate(({ BrowserWindow }, idsToClose: number[]) => {
    for (const id of idsToClose) {
      const w = BrowserWindow.fromId(id)
      if (w && !w.isDestroyed()) w.close()
    }
  }, ids)

/** Close ALL windows that weren't in the baseline. */
const closeNewWindows = async (electronApp: ElectronApp, baselineIds: number[]) => {
  const newIds = await getNewWindowIds(electronApp, baselineIds)
  if (newIds.length > 0) await closeWindowsByIds(electronApp, newIds)
}

/** Execute JavaScript inside the active browser view for a task. */
const execInBrowserWebview = async (mainWindow: Page, taskId: string, code: string) => {
  const viewId = await getActiveViewId(mainWindow, taskId)
  return testInvoke(mainWindow, 'browser:execute-js', viewId, code)
}

/** Execute JavaScript inside a web panel's WebContentsView (main world, user gesture). */
const execInWebPanelView = async (mainWindow: Page, panelId: string, code: string) =>
  mainWindow.evaluate(
    async ({ pid, js }) => {
      type V = { viewId: string; tabId: string; kind: string }
      const client = window.getTrpcVanillaClient()
      const views = (await client.app.browser.listViews.query()) as V[]
      const matches = views.filter((v) => v.kind === 'web-panel' && v.tabId === pid)
      const wp = matches[matches.length - 1]
      if (!wp) return 'no-webview'
      return client.app.browser.executeJs.mutate({ viewId: wp.viewId, code: js })
    },
    { pid: panelId, js: code }
  )

/** Count visible browser panel tabs (exclude the "+" button). */
const getBrowserTabCount = async (mainWindow: Page) => tabEntries(mainWindow).count()

const ensureBrowserPanel = ensureBrowserPanelVisible

// ---------------------------------------------------------------------------
// Web panel helpers — WCV era (pattern from 61-web-panel-handoff-routing)
// ---------------------------------------------------------------------------
// Web panels migrated from <webview> to WebContentsView: there is no DOM
// element to query — target the main-process BrowserViewManager via the
// app.browser tRPC router instead. Views are matched by tabId (= panel id)
// so a stale panel from an earlier describe can never be picked up.

const clearOpenExternalCalls = async (electronApp: ElectronApp) => {
  await electronApp.evaluate(() => {
    const g = globalThis as unknown as { __popupTestOpenExternalCalls?: Array<{ url: string }> }
    g.__popupTestOpenExternalCalls = []
  })
}

const getOpenExternalCalls = async (electronApp: ElectronApp) =>
  electronApp.evaluate(() => {
    const g = globalThis as unknown as { __popupTestOpenExternalCalls?: Array<{ url: string }> }
    return g.__popupTestOpenExternalCalls ?? []
  })

/** Resolve the WCV viewId for a web panel (by panel id). */
const getWebPanelViewId = async (mainWindow: Page, panelId: string) =>
  mainWindow.evaluate(async (pid) => {
    type V = { viewId: string; tabId: string; kind: string }
    const views = (await window.getTrpcVanillaClient().app.browser.listViews.query()) as V[]
    const matches = views.filter((v) => v.kind === 'web-panel' && v.tabId === pid)
    return matches.length > 0 ? matches[matches.length - 1].viewId : null
  }, panelId)

// NOTE: a WCV that never loaded a page reports getURL() === '' —
// BrowserViewManager.createView deliberately skips loading 'about:blank'.
// getWebPanelUrl normalizes '' to 'about:blank' ("blank panel" either way),
// but resetWebPanelToAboutBlank must force a REAL about:blank load for '':
// executeJavaScript on a never-loaded frame queues forever (popup helpers hang).
const getWebPanelUrl = async (mainWindow: Page, panelId: string) =>
  mainWindow.evaluate(async (pid) => {
    type V = { viewId: string; tabId: string; kind: string; url: string }
    const views = (await window.getTrpcVanillaClient().app.browser.listViews.query()) as V[]
    const matches = views.filter((v) => v.kind === 'web-panel' && v.tabId === pid)
    const wp = matches[matches.length - 1]
    if (!wp) return 'no-webview'
    return wp.url === '' ? 'about:blank' : wp.url
  }, panelId)

const resetWebPanelToAboutBlank = async (mainWindow: Page, panelId: string) =>
  mainWindow.evaluate(async (pid) => {
    type V = { viewId: string; tabId: string; kind: string; url: string }
    const client = window.getTrpcVanillaClient()
    const views = (await client.app.browser.listViews.query()) as V[]
    const matches = views.filter((v) => v.kind === 'web-panel' && v.tabId === pid)
    const wp = matches[matches.length - 1]
    if (!wp) return 'no-webview'
    // '' = never loaded — must still navigate so the frame gets a real document.
    if (wp.url === 'about:blank') return 'about:blank'
    await client.app.browser.navigate.mutate({ viewId: wp.viewId, url: 'about:blank' })
    await new Promise((resolve) => setTimeout(resolve, 700))
    const after = (await client.app.browser.listViews.query()) as V[]
    const url = after.find((v) => v.viewId === wp.viewId)?.url
    if (url === undefined) return 'no-webview'
    return url
  }, panelId)

/**
 * Trigger a REAL `window.open(url)` (no features → 'foreground-tab' disposition)
 * inside the web panel WCV, wait for routing to settle, and return the panel URL.
 * Featureless popups are denied in main and emitted as 'web-panel:popup-request'
 * for the renderer's handoff-aware routing — this replaces the dead synthetic
 * <webview> 'new-window' CustomEvent path.
 * `void` so executeJavaScript never tries to serialize a WindowProxy result.
 */
const triggerPopupFromWebPanel = async (mainWindow: Page, panelId: string, popupUrl: string) =>
  mainWindow.evaluate(
    async ({ pid, targetUrl }) => {
      type V = { viewId: string; tabId: string; kind: string; url: string }
      const client = window.getTrpcVanillaClient()
      const views = (await client.app.browser.listViews.query()) as V[]
      const matches = views.filter((v) => v.kind === 'web-panel' && v.tabId === pid)
      const wp = matches[matches.length - 1]
      if (!wp) return 'no-webview'
      await client.app.browser.executeJs.mutate({
        viewId: wp.viewId,
        code: `void window.open(${JSON.stringify(targetUrl)}, '_blank')`
      })
      await new Promise((resolve) => setTimeout(resolve, 900))
      const after = (await client.app.browser.listViews.query()) as V[]
      const url = after.find((v) => v.viewId === wp.viewId)?.url
      if (url === undefined) return 'no-webview'
      return url === '' ? 'about:blank' : url
    },
    { pid: panelId, targetUrl: popupUrl }
  )

/** Patch shell.openExternal to record calls instead of opening. */
const patchOpenExternal = async (electronApp: ElectronApp) => {
  const result = await electronApp.evaluate(({ shell }) => {
    const g = globalThis as unknown as {
      __popupTestOpenExternalCalls?: Array<{ url: string }>
      __popupTestOriginalOpenExternal?: typeof shell.openExternal
    }
    g.__popupTestOpenExternalCalls = []
    if (!g.__popupTestOriginalOpenExternal) {
      g.__popupTestOriginalOpenExternal = shell.openExternal.bind(shell)
    }
    try {
      Object.defineProperty(shell, 'openExternal', {
        configurable: true,
        writable: true,
        value: async (url: string) => {
          g.__popupTestOpenExternalCalls?.push({ url })
        }
      })
      return { ok: true as const, error: null }
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
    }
  })
  return result
}

/** Restore original shell.openExternal. */
const restoreOpenExternal = async (electronApp: ElectronApp) => {
  await electronApp.evaluate(({ shell }) => {
    const g = globalThis as unknown as {
      __popupTestOriginalOpenExternal?: typeof shell.openExternal
      __popupTestOpenExternalCalls?: Array<{ url: string }>
    }
    if (g.__popupTestOriginalOpenExternal) {
      Object.defineProperty(shell, 'openExternal', {
        configurable: true,
        writable: true,
        value: g.__popupTestOriginalOpenExternal
      })
    }
    delete g.__popupTestOriginalOpenExternal
    delete g.__popupTestOpenExternalCalls
  })
}

/** Navigate to task + open a web panel via its header toggle button. */
const openWebPanel = async (
  mainWindow: Page,
  taskTitle: string,
  panelName: string,
  panelId: string
) => {
  await openTaskViaSearch(mainWindow, taskTitle)

  await mainWindow
    .locator('[data-testid="terminal-mode-trigger"]:visible')
    .first()
    .waitFor({ timeout: 5_000 })

  // Open via the header toggle button, NOT the seeded keyboard shortcut:
  // built-in panel bindings are matched first in TaskDetailPage's keydown
  // chain, so a colliding letter silently toggles the wrong panel.
  const panelToggle = mainWindow.locator('button').filter({ hasText: panelName }).last()
  await expect(panelToggle).toBeVisible({ timeout: 5_000 })
  await panelToggle.click()

  // Wait for the WCV to register, then force a REAL about:blank load —
  // createView skips loading 'about:blank', and executeJavaScript on a
  // document-less frame queues forever.
  await expect
    .poll(() => getWebPanelViewId(mainWindow, panelId), { timeout: 10_000 })
    .not.toBeNull()
  await expect
    .poll(() => resetWebPanelToAboutBlank(mainWindow, panelId), { timeout: 10_000 })
    .toBe('about:blank')
}

// ===========================================================================
// Group 1: Browser Panel — popup disposition handling
// ===========================================================================

test.describe
  .serial('Webview popup handling — Browser panel', () => {
    let taskId: string
    let baselineWindowIds: number[]

    test.beforeAll(async ({ electronApp, mainWindow }) => {
      await resetApp(mainWindow)
      const s = seed(mainWindow)
      const p = await s.createProject({
        name: 'PopupTest',
        color: '#8b5cf6',
        path: TEST_PROJECT_PATH
      })
      const task = await s.createTask({
        projectId: p.id,
        title: 'Popup handling task',
        status: 'todo'
      })
      taskId = task.id
      await s.refreshData()

      await openTaskViaSearch(mainWindow, 'Popup handling task')
      await ensureBrowserPanel(mainWindow)

      const viewId = await getActiveViewId(mainWindow, taskId)
      await testInvoke(mainWindow, 'browser:navigate', viewId, 'https://example.com')
      await expect
        .poll(
          async () => {
            return (await testInvoke(mainWindow, 'browser:get-url', viewId)) as string
          },
          { timeout: 10_000 }
        )
        .toContain('example.com')
      await expect
        .poll(
          async () => {
            return (await testInvoke(
              mainWindow,
              'browser:execute-js',
              viewId,
              'document.readyState'
            )) as string
          },
          { timeout: 10_000 }
        )
        .toBe('complete')

      baselineWindowIds = await getWindowIds(electronApp)
    })

    test.afterEach(async ({ electronApp }) => {
      await closeNewWindows(electronApp, baselineWindowIds)
    })

    test('window.open() with features creates real BrowserWindow', async ({
      electronApp,
      mainWindow
    }) => {
      const result = await execInBrowserWebview(
        mainWindow,
        taskId,
        `new Promise((resolve) => {
        const popup = window.open('https://example.com/oauth', 'auth', 'width=500,height=600')
        resolve(JSON.stringify({ popupIsNull: popup === null }))
      })`
      )
      const parsed = JSON.parse(result as string)
      expect(parsed.popupIsNull).toBe(false)

      await expect
        .poll(() => getNewWindowIds(electronApp, baselineWindowIds), { timeout: 5_000 })
        .toHaveLength(1)
    })

    test('window.open() with features does NOT create new browser tab', async ({
      electronApp,
      mainWindow
    }) => {
      const baselineTabs = await getBrowserTabCount(mainWindow)

      await execInBrowserWebview(
        mainWindow,
        taskId,
        `window.open('https://example.com/oauth2', 'auth2', 'width=500,height=600')`
      )

      // Wait for popup window to confirm the open completed
      await expect
        .poll(() => getNewWindowIds(electronApp, baselineWindowIds), { timeout: 5_000 })
        .toHaveLength(1)

      // Tab count should NOT have changed
      const tabsAfter = await getBrowserTabCount(mainWindow)
      expect(tabsAfter).toBe(baselineTabs)
    })

    test('target="_blank" link creates tab, not BrowserWindow', async ({
      electronApp,
      mainWindow
    }) => {
      const baselineTabs = await getBrowserTabCount(mainWindow)

      await execInBrowserWebview(
        mainWindow,
        taskId,
        `new Promise((resolve) => {
        const a = document.createElement('a')
        a.href = 'https://example.com/linked-page'
        a.target = '_blank'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => resolve('done'), 500)
      })`
      )

      // Wait for tab to appear
      await expect
        .poll(() => getBrowserTabCount(mainWindow), { timeout: 5_000 })
        .toBe(baselineTabs + 1)

      // No popup window should have been created
      const newWindows = await getNewWindowIds(electronApp, baselineWindowIds)
      expect(newWindows).toHaveLength(0)
    })

    test('window.open() without features creates tab, not BrowserWindow', async ({
      electronApp,
      mainWindow
    }) => {
      const baselineTabs = await getBrowserTabCount(mainWindow)

      await execInBrowserWebview(
        mainWindow,
        taskId,
        `window.open('https://example.com/no-features')`
      )

      await expect
        .poll(() => getBrowserTabCount(mainWindow), { timeout: 5_000 })
        .toBe(baselineTabs + 1)

      const newWindows = await getNewWindowIds(electronApp, baselineWindowIds)
      expect(newWindows).toHaveLength(0)
    })

    test('window.open() with blocked scheme returns null', async ({ electronApp, mainWindow }) => {
      const result = await execInBrowserWebview(
        mainWindow,
        taskId,
        `new Promise((resolve) => {
        const popup = window.open('figma://blocked-test', 'x', 'width=500,height=600')
        resolve(JSON.stringify({ popupIsNull: popup === null }))
      })`
      )

      const parsed = JSON.parse(result as string)
      expect(parsed.popupIsNull).toBe(true)

      const newWindows = await getNewWindowIds(electronApp, baselineWindowIds)
      expect(newWindows).toHaveLength(0)
    })

    test('child popup cannot open grandchild (chain prevention)', async ({
      electronApp,
      mainWindow
    }) => {
      await execInBrowserWebview(
        mainWindow,
        taskId,
        `window.open('https://example.com/parent-popup', 'parent', 'width=500,height=600')`
      )
      await expect
        .poll(() => getNewWindowIds(electronApp, baselineWindowIds), { timeout: 5_000 })
        .toHaveLength(1)
      const newIds = await getNewWindowIds(electronApp, baselineWindowIds)

      // From main process: find the child window and try to open a grandchild
      const grandchildResult = await electronApp.evaluate(({ BrowserWindow }, childId: number) => {
        const child = BrowserWindow.fromId(childId)
        if (!child || child.isDestroyed()) return { error: 'no-child-window' }

        return child.webContents
          .executeJavaScript(
            `JSON.stringify({ popupIsNull: window.open('https://example.com/grandchild', 'gc', 'width=300,height=300') === null })`
          )
          .then((r: string) => JSON.parse(r))
          .catch((e: Error) => ({ error: e.message }))
      }, newIds[0])

      expect(grandchildResult.popupIsNull ?? grandchildResult.error).toBeTruthy()

      // Should still be exactly 1 new window (the parent), no grandchild
      const finalNewWindows = await getNewWindowIds(electronApp, baselineWindowIds)
      expect(finalNewWindows).toHaveLength(1)
    })

    test('popup shares session with parent webview (persist:browser-tabs)', async ({
      electronApp,
      mainWindow
    }) => {
      await execInBrowserWebview(
        mainWindow,
        taskId,
        `window.open('https://example.com/session-test', 'sess', 'width=500,height=600')`
      )
      await expect
        .poll(() => getNewWindowIds(electronApp, baselineWindowIds), { timeout: 5_000 })
        .toHaveLength(1)
      const newIds = await getNewWindowIds(electronApp, baselineWindowIds)

      const storagePath = await electronApp.evaluate(({ BrowserWindow }, childId: number) => {
        const child = BrowserWindow.fromId(childId)
        if (!child || child.isDestroyed()) return 'no-child'
        return child.webContents.session.storagePath ?? 'no-storage-path'
      }, newIds[0])

      expect(storagePath).toContain('browser-tabs')
    })

    // This test toggles the browser panel off which destroys the webview — keep it last.
    test('popup windows closed when parent webview destroyed (panel toggle)', async ({
      electronApp,
      mainWindow
    }) => {
      await ensureBrowserPanel(mainWindow)

      await execInBrowserWebview(
        mainWindow,
        taskId,
        `window.open('https://example.com/destroy-test', 'dest', 'width=500,height=600')`
      )
      await expect
        .poll(() => getNewWindowIds(electronApp, baselineWindowIds), { timeout: 5_000 })
        .toHaveLength(1)

      // Toggle browser panel OFF → webview destroyed → child cleanup fires
      await focusForAppShortcut(mainWindow)
      await mainWindow.keyboard.press('Meta+b')

      // Popup should be closed
      await expect
        .poll(() => getNewWindowIds(electronApp, baselineWindowIds), { timeout: 5_000 })
        .toHaveLength(0)

      // Re-open browser panel for any tests that follow
      await focusForAppShortcut(mainWindow)
      await mainWindow.keyboard.press('Meta+b')
      await expect(urlInput(mainWindow)).toBeVisible({ timeout: 5_000 })
    })
  })

// ===========================================================================
// Group 2: Web Panel WITH handoff policy (Figma)
// ===========================================================================

// MIGRATED 2026-07-03 (webview → WebContentsView):
// - Helpers target the main-process WCV via app.browser tRPC (DOM <webview> is
//   gone) and force a real about:blank load before any executeJavaScript.
// - window.open() WITH features is now ALLOWED for web panels regardless of
//   handoff policy (real BrowserWindow on the panel session so OAuth cookies
//   propagate back) — the old "with features denied in handoff webview"
//   expectation asserted a dead <webview> behavior.
// - The synthetic <webview> 'new-window' CustomEvent path is dead; renderer
//   routing now hangs off main's 'web-panel:popup-request' event, exercised
//   here via real featureless window.open() calls.
test.describe('Webview popup handling — Web panel with handoff policy', () => {
    const PANEL_ID = 'web:popup-handoff'
    const PANEL_NAME = 'Popup Handoff'
    const PANEL_SHORTCUT = 'y'
    let baselineWindowIds: number[]

    test.beforeAll(async ({ electronApp, mainWindow }) => {
      await resetApp(mainWindow)

      const patchResult = await patchOpenExternal(electronApp)
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
        name: 'PopupHandoff',
        color: '#14b8a6',
        path: TEST_PROJECT_PATH
      })
      const task = await s.createTask({
        projectId: project.id,
        title: 'Popup handoff task',
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

      await openWebPanel(mainWindow, 'Popup handoff task', PANEL_NAME, PANEL_ID)
      baselineWindowIds = await getWindowIds(electronApp)
    })

    test.afterAll(async ({ electronApp }) => {
      await restoreOpenExternal(electronApp)
    })

    test.afterEach(async ({ electronApp }) => {
      await closeNewWindows(electronApp, baselineWindowIds)
    })

    test.beforeEach(async ({ electronApp, mainWindow }) => {
      await clearOpenExternalCalls(electronApp)
      await expect
        .poll(() => resetWebPanelToAboutBlank(mainWindow, PANEL_ID), { timeout: 5_000 })
        .toBe('about:blank')
    })

    // --- Main process tests (real window.open via executeJavaScript) ---

    test('window.open() with features creates real BrowserWindow (handoff panel, OAuth allowed)', async ({
      electronApp,
      mainWindow
    }) => {
      const result = await execInWebPanelView(
        mainWindow,
        PANEL_ID,
        `new Promise((resolve) => {
        const popup = window.open('https://example.com/oauth-handoff', 'auth', 'width=500,height=600')
        resolve(JSON.stringify({ popupIsNull: popup === null }))
      })`
      )
      const parsed = JSON.parse(result as string)
      expect(parsed.popupIsNull).toBe(false)

      await expect
        .poll(() => getNewWindowIds(electronApp, baselineWindowIds), { timeout: 10_000 })
        .toHaveLength(1)

      // new-window popups never route through the renderer popup handler
      const calls = await getOpenExternalCalls(electronApp)
      expect(calls).toHaveLength(0)
    })

    test('window.open() without features denied in handoff panel (main process)', async ({
      electronApp,
      mainWindow
    }) => {
      const result = await execInWebPanelView(
        mainWindow,
        PANEL_ID,
        `new Promise((resolve) => {
        const popup = window.open('https://example.com/nofeatures')
        resolve(JSON.stringify({ popupIsNull: popup === null }))
      })`
      )
      const parsed = JSON.parse(result as string)
      expect(parsed.popupIsNull).toBe(true)

      // Denied in main, routed to the renderer: cross-host (outside figma.com
      // scope) → openExternal. Polling this also drains the async routing so
      // it can't leak into the next test's openExternal call log.
      await expect
        .poll(() => getOpenExternalCalls(electronApp), { timeout: 5_000 })
        .toHaveLength(1)

      const newWindows = await getNewWindowIds(electronApp, baselineWindowIds)
      expect(newWindows).toHaveLength(0)
    })

    // --- Renderer routing tests (web-panel:popup-request via real window.open) ---

    test('same-host popup loads in-panel (renderer)', async ({ electronApp, mainWindow }) => {
      await triggerPopupFromWebPanel(
        mainWindow,
        PANEL_ID,
        'https://www.figma.com/oauth/authorize?client_id=popup-test'
      )

      // Poll: navigating the WCV to an external URL (figma.com) can outlast the
      // helper's fixed post-trigger wait when the machine is loaded.
      await expect
        .poll(() => getWebPanelUrl(mainWindow, PANEL_ID), { timeout: 15_000 })
        .toContain('figma.com')

      const calls = await getOpenExternalCalls(electronApp)
      expect(calls).toHaveLength(0)
    })

    test('cross-host popup opens externally (renderer)', async ({ electronApp, mainWindow }) => {
      const targetUrl = 'https://example.com/popup-cross-host'
      const currentUrl = await triggerPopupFromWebPanel(mainWindow, PANEL_ID, targetUrl)

      expect(currentUrl).toBe('about:blank')

      const calls = await getOpenExternalCalls(electronApp)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe(targetUrl)
    })

    test('loopback popup suppressed (renderer)', async ({ electronApp, mainWindow }) => {
      const currentUrl = await triggerPopupFromWebPanel(
        mainWindow,
        PANEL_ID,
        'http://127.0.0.1:38495/handoff-popup'
      )

      expect(currentUrl).toBe('about:blank')

      const calls = await getOpenExternalCalls(electronApp)
      expect(calls).toHaveLength(0)
    })
  })

// ===========================================================================
// Group 3: Web Panel WITHOUT handoff policy
// ===========================================================================

// MIGRATED 2026-07-03 (webview → WebContentsView): see note on the
// with-handoff describe above — same WCV helper migration; dispositions are
// now produced by real window.open() calls (with features → 'new-window',
// featureless → 'foreground-tab') instead of synthetic <webview> events.
test.describe('Webview popup handling — Web panel without handoff policy', () => {
    const PANEL_ID = 'web:popup-nohandoff'
    const PANEL_NAME = 'NoHandoff Panel'
    const PANEL_SHORTCUT = 'y'
    let baselineWindowIds: number[]

    test.beforeAll(async ({ electronApp, mainWindow }) => {
      await resetApp(mainWindow)

      const patchResult = await patchOpenExternal(electronApp)
      expect(patchResult.ok, patchResult.error ?? 'Failed to patch').toBe(true)

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
            baseUrl: 'https://example.com',
            shortcut: PANEL_SHORTCUT
            // No blockDesktopHandoff, no handoffProtocol — no handoff policy
          }
        ]
      }

      const s = seed(mainWindow)
      await s.setSetting('panel_config', JSON.stringify(panelConfig))

      const project = await s.createProject({
        name: 'PopupNoHandoff',
        color: '#f59e0b',
        path: TEST_PROJECT_PATH
      })
      const task = await s.createTask({
        projectId: project.id,
        title: 'No-handoff popup task',
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

      await openWebPanel(mainWindow, 'No-handoff popup task', PANEL_NAME, PANEL_ID)
      baselineWindowIds = await getWindowIds(electronApp)
    })

    test.afterAll(async ({ electronApp }) => {
      await restoreOpenExternal(electronApp)
    })

    test.afterEach(async ({ electronApp }) => {
      await closeNewWindows(electronApp, baselineWindowIds)
    })

    test.beforeEach(async ({ electronApp, mainWindow }) => {
      await clearOpenExternalCalls(electronApp)
      await expect
        .poll(() => resetWebPanelToAboutBlank(mainWindow, PANEL_ID), { timeout: 5_000 })
        .toBe('about:blank')
    })

    // --- Main process tests (real window.open via executeJavaScript) ---

    test('window.open() with features creates real BrowserWindow (no handoff)', async ({
      electronApp,
      mainWindow
    }) => {
      const result = await execInWebPanelView(
        mainWindow,
        PANEL_ID,
        `new Promise((resolve) => {
        const popup = window.open('https://example.com/oauth-no-handoff', 'auth', 'width=500,height=600')
        resolve(JSON.stringify({ popupIsNull: popup === null }))
      })`
      )
      const parsed = JSON.parse(result as string)
      expect(parsed.popupIsNull).toBe(false)

      await expect
        .poll(() => getNewWindowIds(electronApp, baselineWindowIds), { timeout: 10_000 })
        .toHaveLength(1)
    })

    test('window.open() without features denied (no handoff, foreground-tab disposition)', async ({
      electronApp,
      mainWindow
    }) => {
      const result = await execInWebPanelView(
        mainWindow,
        PANEL_ID,
        `new Promise((resolve) => {
        const popup = window.open('https://example.com/no-features-no-handoff')
        resolve(JSON.stringify({ popupIsNull: popup === null }))
      })`
      )
      const parsed = JSON.parse(result as string)
      // Without features → disposition 'foreground-tab' → denied by main process
      expect(parsed.popupIsNull).toBe(true)

      // Routed to the renderer: no handoff policy → openExternal. Polling this
      // also drains the async routing before the next test clears the call log.
      await expect
        .poll(() => getOpenExternalCalls(electronApp), { timeout: 5_000 })
        .toHaveLength(1)

      const newWindows = await getNewWindowIds(electronApp, baselineWindowIds)
      expect(newWindows).toHaveLength(0)
    })

    // --- Renderer routing tests (web-panel:popup-request via real window.open) ---

    test('disposition new-window skips renderer handler (no openExternal)', async ({
      electronApp,
      mainWindow
    }) => {
      await execInWebPanelView(
        mainWindow,
        PANEL_ID,
        `void window.open('https://example.com/auth-popup', 'auth-nw', 'width=500,height=600')`
      )

      // Wait for the popup BrowserWindow — proves the open was fully processed
      // before asserting the renderer handler was skipped.
      await expect
        .poll(() => getNewWindowIds(electronApp, baselineWindowIds), { timeout: 10_000 })
        .toHaveLength(1)

      const calls = await getOpenExternalCalls(electronApp)
      expect(calls).toHaveLength(0)
    })

    test('disposition foreground-tab opens externally', async ({ electronApp, mainWindow }) => {
      const targetUrl = 'https://example.com/foreground-tab-link'
      const currentUrl = await triggerPopupFromWebPanel(mainWindow, PANEL_ID, targetUrl)

      expect(currentUrl).toBe('about:blank')

      await expect
        .poll(() => getOpenExternalCalls(electronApp), { timeout: 5_000 })
        .toHaveLength(1)
      const calls = await getOpenExternalCalls(electronApp)
      expect(calls[0]?.url).toBe(targetUrl)

      const newWindows = await getNewWindowIds(electronApp, baselineWindowIds)
      expect(newWindows).toHaveLength(0)
    })
  })

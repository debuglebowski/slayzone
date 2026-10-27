import { test, expect, resetApp } from '../fixtures/electron'

/**
 * The app window shows the app, never a website. Measured trigger: a plain click
 * on a PDF link that beats main's link bridge makes Chromium's PDF viewer call
 * `chrome.tabs.update`, which navigated the WHOLE app window to the link. That
 * arrives as a main-frame `will-navigate` — the same event a page-side
 * `location.href = …` raises, which is what this spec drives deterministically.
 */
test.describe('App window navigation guard', () => {
  test.beforeAll(async ({ electronApp, mainWindow }) => {
    await resetApp(mainWindow)
    await electronApp.evaluate(({ shell }) => {
      const g = globalThis as Record<string, unknown>
      g.__navGuardCalls = [] as string[]
      g.__navGuardOriginal = shell.openExternal.bind(shell)
      Object.defineProperty(shell, 'openExternal', {
        configurable: true,
        writable: true,
        value: async (url: string) => {
          ;(g.__navGuardCalls as string[]).push(url)
        }
      })
    })
  })

  test.afterAll(async ({ electronApp, mainWindow }) => {
    // Re-sync Playwright's page after the cancelled navigation (see the test),
    // so the next spec in this worker starts from a settled page.
    await mainWindow.reload({ waitUntil: 'domcontentloaded' })
    await mainWindow.waitForSelector('#root', { timeout: 10_000 })
    await electronApp.evaluate(({ shell }) => {
      const g = globalThis as Record<string, unknown>
      if (g.__navGuardOriginal) {
        Object.defineProperty(shell, 'openExternal', {
          configurable: true,
          writable: true,
          value: g.__navGuardOriginal
        })
      }
      delete g.__navGuardCalls
      delete g.__navGuardOriginal
    })
  })

  test('a website load aimed at the app window opens externally instead', async ({
    electronApp,
    mainWindow
  }) => {
    const appUrl = mainWindow.url()
    await mainWindow
      .evaluate(() => {
        window.location.href = 'https://example.com/nav-guard'
      })
      .catch(() => {
        // Without the guard the evaluate's context dies with the navigation.
      })
    await expect
      .poll(() =>
        electronApp.evaluate(() => (globalThis as Record<string, unknown>).__navGuardCalls)
      )
      .toEqual(['https://example.com/nav-guard'])
    // Still the app: same document, UI intact.
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .map((w) => w.webContents.getURL())
          .some((u) => u.includes('example.com'))
      )
    ).toBe(false)
    expect(mainWindow.url()).toBe(appUrl)
    // Checked from main: Playwright keeps the page's locators "waiting for
    // navigation to finish" after a navigation the guard cancelled.
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
          "document.getElementById('root') !== null"
        )
      )
    ).toBe(true)
  })
})

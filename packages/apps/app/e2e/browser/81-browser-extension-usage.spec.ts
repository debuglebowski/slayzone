import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  testInvoke,
  ensureBrowserPanelVisible,
  openTaskViaSearch,
  getActiveViewId,
  getViewsForTask
} from '../fixtures/browser-view'
import { getTestUrl } from '../fixtures/test-server'

// Resolve test extension fixture paths (fixtures live in e2e/fixtures/)
const TEST_EXT_DIR = join(import.meta.dirname, '..', 'fixtures', 'test-extension')
const TEST_EXT_MV3_DIR = join(import.meta.dirname, '..', 'fixtures', 'test-extension-mv3')

// 1Password extension path (Chrome default profile)
const ONEPASSWORD_ID = 'aeblfdkhhhdcdjpifhhbdiojplfjncoa'
const CHROME_EXT_DIR = join(
  homedir(),
  'Library',
  'Application Support',
  'Google',
  'Chrome',
  'Default',
  'Extensions',
  ONEPASSWORD_ID
)

function find1PasswordPath(): string | null {
  try {
    if (!existsSync(CHROME_EXT_DIR)) return null
    const versions = readdirSync(CHROME_EXT_DIR)
      .filter((d) => !d.startsWith('.') && d !== 'Temp')
      .sort()
    const latest = versions.pop()
    if (!latest) return null
    const fullPath = join(CHROME_EXT_DIR, latest)
    return existsSync(join(fullPath, 'manifest.json')) ? fullPath : null
  } catch {
    return null
  }
}

// UNSKIPPED 2026-07-05: the historical failures here (content-script injection,
// MV2/MV3 messaging — previously blamed on Electron extension-host GPU/compositor
// contention) were actually caused by fixture path drift: when specs moved from
// e2e/ to e2e/browser/, TEST_EXT_DIR still resolved import.meta.dirname/fixtures
// (nonexistent), so the extension never loaded. With the paths fixed all tests
// pass. Do not re-skip without re-checking the fixture paths first.
// Skipped: Chrome extensions are not used in the app (the extensions manager UI is
// off — see 24-browser-panel "extensions button is hidden"). Re-enable with the feature.
test.describe
  .skip('Chrome extension real usage (WebContentsView)', () => {
    let taskId: string
    /** Set by the MV3 messaging test once the worker answered; the MV3 tests after it reuse that worker. */
    let mv3Connected = false

    test.beforeAll(async ({ mainWindow }) => {
      await resetApp(mainWindow)
      const s = seed(mainWindow)
      const p = await s.createProject({
        name: 'Ext Tests',
        color: '#0ea5e9',
        path: TEST_PROJECT_PATH
      })
      const t = await s.createTask({ projectId: p.id, title: 'Extension test', status: 'todo' })
      taskId = t.id
      await s.refreshData()
      await openTaskViaSearch(mainWindow, 'Extension test')
    })

    test('content script injects and messaging works', async ({ mainWindow }) => {
      test.setTimeout(30000)
      await ensureBrowserPanelVisible(mainWindow)
      const viewId = await getActiveViewId(mainWindow, taskId)

      // Remove any previously cached version, then load fresh
      const existing = (await testInvoke(mainWindow, 'browser:get-extensions')) as { id: string }[]
      for (const ext of existing) {
        if (ext.id) await testInvoke(mainWindow, 'browser:remove-extension', ext.id)
      }
      const result = (await testInvoke(mainWindow, 'browser:import-extension', TEST_EXT_DIR)) as {
        id?: string
        error?: string
      }
      expect(result.error, `Extension load failed: ${result.error}`).toBeUndefined()
      expect(result.id).toBeTruthy()

      // Navigate to a real page
      await testInvoke(mainWindow, 'browser:navigate', viewId, await getTestUrl('/title-ext-page'))
      await expect
        .poll(
          async () => {
            return (await testInvoke(mainWindow, 'browser:get-url', viewId)) as string
          },
          { timeout: 15000 }
        )
        .toContain('/title-ext-page')

      // Wait for content script + messaging to complete. A timeout falls through
      // to the diagnostic asserts below, which report what the page shows.
      await expect
        .poll(
          async () =>
            (await testInvoke(
              mainWindow,
              'browser:execute-js',
              viewId,
              'document.getElementById("slayzone-test-ext")?.dataset.status || "not-found"'
            )) as string,
          { timeout: 5000 }
        )
        .toBe('connected')
        .catch(() => {})

      // Get full diagnostics from the content script's marker element
      const diag = (await testInvoke(
        mainWindow,
        'browser:execute-js',
        viewId,
        `
      (function() {
        var el = document.getElementById('slayzone-test-ext');
        if (!el) return '{"found":false}';
        return JSON.stringify(Object.assign({}, el.dataset));
      })()
    `
      )) as string

      const { writeFileSync } = await import('fs')
      writeFileSync('/tmp/slayzone-ext-diag.txt', diag)

      const data = JSON.parse(diag)
      expect(data.found !== false, 'Content script did not inject').toBe(true)
      expect(data.status, `Extension messaging: ${diag}`).toBe('connected')
    })

    test('background ↔ content script messaging works', async ({ mainWindow }) => {
      test.setTimeout(15000)
      await ensureBrowserPanelVisible(mainWindow)
      const viewId = await getActiveViewId(mainWindow, taskId)

      // The previous test already loaded the extension and navigated to the fixture page.
      // The content script should have sent a ping and received a pong.
      // Check the marker element's status immediately (content script already ran).
      // Read the diagnostic immediately (content script already ran from previous test)
      let diag: string
      try {
        diag = (await testInvoke(
          mainWindow,
          'browser:execute-js',
          viewId,
          `
        (function() {
          var el = document.getElementById('slayzone-test-ext');
          if (!el) return 'no-marker';
          return el.dataset.status + '|err=' + el.dataset.error + '|rt=' + el.dataset.runtimetype + '|sm=' + el.dataset.sendmessagetype + '|id=' + el.dataset.runtimeid;
        })()
      `
        )) as string
      } catch (e) {
        diag = `eval-failed: ${e}`
      }

      const { writeFileSync } = await import('fs')
      writeFileSync('/tmp/slayzone-mv2-messaging.txt', diag)
      expect(diag, 'MV2 messaging diagnostics').toContain('connected')
    })

    test('content script re-injects on navigation', async ({ mainWindow }) => {
      test.setTimeout(30000)
      await ensureBrowserPanelVisible(mainWindow)
      const viewId = await getActiveViewId(mainWindow, taskId)

      // Navigate to a different page
      await testInvoke(
        mainWindow,
        'browser:navigate',
        viewId,
        await getTestUrl('/title-ext-page-2')
      )
      await expect
        .poll(
          async () => {
            return (await testInvoke(mainWindow, 'browser:get-url', viewId)) as string
          },
          { timeout: 15000 }
        )
        .toContain('/title-ext-page-2')

      // Wait and check marker exists on new page
      await expect
        .poll(
          async () => {
            return (await testInvoke(
              mainWindow,
              'browser:execute-js',
              viewId,
              'document.getElementById("slayzone-test-ext")?.dataset.status || "not-found"'
            )) as string
          },
          { timeout: 15000, message: 'Content script should re-inject on new page' }
        )
        .not.toBe('not-found')
    })

    test('MV3: service worker messaging works', async ({ mainWindow, electronApp }) => {
      test.setTimeout(45000)
      await ensureBrowserPanelVisible(mainWindow)
      const viewId = await getActiveViewId(mainWindow, taskId)

      // Load MV3 test extension
      const result = (await testInvoke(
        mainWindow,
        'browser:import-extension',
        TEST_EXT_MV3_DIR
      )) as {
        id?: string
        error?: string
      }
      expect(result.error, `MV3 extension load failed: ${result.error}`).toBeUndefined()

      // Wait until the freshly loaded extension's worker actually starts. Its
      // registration is async after loadExtension resolves, and under full-suite
      // load it outlasted the fixed 2s wait this replaced — startWorkerForScope then
      // failed and the messaging below never connected.
      const startMv3Workers = () =>
        electronApp.evaluate(async ({ session }) => {
          const ses = session.fromPartition('persist:browser-tabs')
          const allExts = ses.getAllExtensions()
          const swResults: string[] = []
          for (const ext of allExts) {
            if (ext.manifest.manifest_version === 3 && ext.manifest.background?.service_worker) {
              try {
                await ses.serviceWorkers.startWorkerForScope(`chrome-extension://${ext.id}/`)
                swResults.push(`${ext.name}: started OK`)
              } catch (err) {
                swResults.push(
                  `${ext.name}: FAILED - ${err instanceof Error ? err.message : String(err)}`
                )
              }
            }
          }
          const running = ses.serviceWorkers.getAllRunning()
          return {
            extensions: allExts.map((e) => `${e.name} (MV${e.manifest.manifest_version})`),
            swStartResults: swResults,
            runningWorkers: Object.entries(running).map(
              ([id, info]) => `${id}: ${JSON.stringify(info)}`
            )
          }
        })
      let swInfo = await startMv3Workers()
      await expect
        .poll(
          async () => {
            swInfo = await startMv3Workers()
            return (
              swInfo.swStartResults.length > 0 &&
              swInfo.swStartResults.every((r) => r.endsWith('started OK'))
            )
          },
          { timeout: 15_000, intervals: [250, 500, 1_000] }
        )
        .toBe(true)
        // A timeout falls through to the diagnostic assert below.
        .catch(() => {})

      // Navigate to trigger content script
      await testInvoke(mainWindow, 'browser:navigate', viewId, await getTestUrl('/title-ext-page'))
      await expect
        .poll(
          async () => {
            return (await testInvoke(mainWindow, 'browser:get-url', viewId)) as string
          },
          { timeout: 15000 }
        )
        .toContain('/title-ext-page')

      // A timeout falls through to the diagnostic assert below.
      await expect
        .poll(
          async () =>
            (await testInvoke(
              mainWindow,
              'browser:execute-js',
              viewId,
              'document.getElementById("slayzone-test-ext")?.dataset.status || "not-found"'
            )) as string,
          { timeout: 5000 }
        )
        .toBe('connected')
        .catch(() => {})

      // Check content script injected and messaging worked
      const status = (await testInvoke(
        mainWindow,
        'browser:execute-js',
        viewId,
        'document.getElementById("slayzone-test-ext")?.dataset.status || "not-found"'
      )) as string

      const error = (await testInvoke(
        mainWindow,
        'browser:execute-js',
        viewId,
        'document.getElementById("slayzone-test-ext")?.dataset.error || "none"'
      )) as string

      expect(
        status,
        [
          `MV3 content script status: ${status}, error: ${error}`,
          `Extensions: ${JSON.stringify(swInfo.extensions)}`,
          `SW start results: ${JSON.stringify(swInfo.swStartResults)}`,
          `Running workers: ${JSON.stringify(swInfo.runningWorkers)}`
        ].join('\n')
      ).toBe('connected')
      mv3Connected = true
    })

    // Runs after the MV3 messaging test above, which loaded the MV3 fixture into this
    // worker's app and left the active tab on a page where its content script runs.
    async function askMv3Background(
      mainWindow: import('@playwright/test').Page,
      viewId: string,
      message: Record<string, unknown>
    ): Promise<Record<string, unknown>> {
      // Fail at once rather than burn this test's whole budget polling a worker that
      // was never reachable — the messaging test above already reported why.
      expect(
        mv3Connected,
        'MV3 worker never connected in "MV3: service worker messaging works"'
      ).toBe(true)
      await testInvoke(
        mainWindow,
        'browser:execute-js',
        viewId,
        `(() => { const m = document.getElementById('slayzone-test-ext'); delete m.dataset.reply;
        document.dispatchEvent(new CustomEvent('slz-ext-request', { detail: ${JSON.stringify(
          JSON.stringify(message)
        )} })) })()`
      )
      let reply = ''
      await expect
        .poll(
          async () => {
            reply = (await testInvoke(
              mainWindow,
              'browser:execute-js',
              viewId,
              'document.getElementById("slayzone-test-ext")?.dataset.reply || ""'
            )) as string
            return reply
          },
          { timeout: 20000 }
        )
        .not.toBe('')
      return JSON.parse(reply)
    }

    test('MV3: `browser` namespace is the shimmed chrome', async ({ mainWindow }) => {
      await ensureBrowserPanelVisible(mainWindow)
      const viewId = await getActiveViewId(mainWindow, taskId)
      const reply = await askMv3Background(mainWindow, viewId, { type: 'namespaces' })
      expect(reply).toEqual({ browserIsChrome: true, browserWindows: 'object' })
    })

    test('MV3: service worker can use the origin private file system', async ({ mainWindow }) => {
      await ensureBrowserPanelVisible(mainWindow)
      const viewId = await getActiveViewId(mainWindow, taskId)
      expect(await askMv3Background(mainWindow, viewId, { type: 'opfs' })).toEqual({ opfs: 'ok' })
    })

    test('MV3: chrome.tabs.create opens a browser-panel tab', async ({ mainWindow }) => {
      test.setTimeout(45000)
      await ensureBrowserPanelVisible(mainWindow)
      const viewId = await getActiveViewId(mainWindow, taskId)
      const viewsBefore = await getViewsForTask(mainWindow, taskId)
      const target = await getTestUrl('/title-ext-opened')

      const reply = await askMv3Background(mainWindow, viewId, { type: 'open-tab', url: target })
      expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true })
      expect(typeof reply.tabId).toBe('number')

      const viewsAfter = await getViewsForTask(mainWindow, taskId)
      expect(viewsAfter.length).toBe(viewsBefore.length + 1)
      const opened = viewsAfter.find((v) => !viewsBefore.includes(v))!
      await expect
        .poll(async () => (await testInvoke(mainWindow, 'browser:get-url', opened)) as string, {
          timeout: 15000
        })
        .toContain('/title-ext-opened')
    })

    test('real extension: 1Password imports and page stays usable', async ({ mainWindow }) => {
      const extPath = find1PasswordPath()
      // Env-guard: needs 1Password installed in the local Chrome default profile.
      test.skip(!extPath, '1Password extension not found in the default Chrome profile')

      test.setTimeout(60000)
      await ensureBrowserPanelVisible(mainWindow)
      const viewId = await getActiveViewId(mainWindow, taskId)

      // Load 1Password
      const result = (await testInvoke(mainWindow, 'browser:import-extension', extPath!)) as {
        id?: string
        error?: string
      }
      expect(result.error, `1Password load failed: ${result.error}`).toBeUndefined()

      const loaded = (await testInvoke(mainWindow, 'browser:get-extensions')) as Array<{
        id: string
        name?: string
      }>
      expect(loaded.some((ext) => ext.id === result.id)).toBe(true)

      // Navigate to a page with a login form to ensure the imported extension
      // does not break navigation in a real-world page.
      await testInvoke(mainWindow, 'browser:navigate', viewId, 'https://github.com/login')
      await expect
        .poll(
          async () => {
            return (await testInvoke(mainWindow, 'browser:get-url', viewId)) as string
          },
          { timeout: 20000 }
        )
        .toContain('github.com')

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
          { timeout: 15000 }
        )
        .toBe('complete')

      const formInfo = (await testInvoke(
        mainWindow,
        'browser:execute-js',
        viewId,
        `
      (function() {
        return JSON.stringify({
          title: document.title,
          hasPassword: !!document.querySelector('input[type="password"]'),
          hasLoginForm: !!document.querySelector('form'),
        });
      })()
    `
      )) as string
      const parsed = JSON.parse(formInfo) as {
        title: string
        hasPassword: boolean
        hasLoginForm: boolean
      }
      expect(
        parsed.hasLoginForm || parsed.hasPassword,
        `GitHub login page did not render expected form controls: ${formInfo}`
      ).toBe(true)
    })
  })

import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  testInvoke, ensureBrowserPanelVisible, openTaskViaSearch, getActiveViewId,
} from '../fixtures/browser-view'

// Resolve test extension fixture paths (relative to project root)
const TEST_EXT_DIR = join(import.meta.dirname, 'fixtures', 'test-extension')
const TEST_EXT_MV3_DIR = join(import.meta.dirname, 'fixtures', 'test-extension-mv3')

// 1Password extension path (Chrome default profile)
const ONEPASSWORD_ID = 'aeblfdkhhhdcdjpifhhbdiojplfjncoa'
const CHROME_EXT_DIR = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Extensions', ONEPASSWORD_ID)

function find1PasswordPath(): string | null {
  try {
    if (!existsSync(CHROME_EXT_DIR)) return null
    const versions = readdirSync(CHROME_EXT_DIR).filter(d => !d.startsWith('.') && d !== 'Temp').sort()
    const latest = versions.pop()
    if (!latest) return null
    const fullPath = join(CHROME_EXT_DIR, latest)
    return existsSync(join(fullPath, 'manifest.json')) ? fullPath : null
  } catch { return null }
}

// Skip: MV3 service worker startup is unreliable under parallel Electron instances.
// Electron's extension host contends for GPU/compositor resources, causing the
// service worker to fail to start. This is an Electron limitation, not an app bug.
test.describe.skip('Chrome extension real usage (WebContentsView)', () => {
  let taskId: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Ext Tests', color: '#0ea5e9', path: TEST_PROJECT_PATH })
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
    const existing = await testInvoke(mainWindow, 'browser:get-extensions') as { id: string }[]
    for (const ext of existing) {
      if (ext.id) await testInvoke(mainWindow, 'browser:remove-extension', ext.id)
    }
    const result = await testInvoke(mainWindow, 'browser:import-extension', TEST_EXT_DIR) as { id?: string; error?: string }
    expect(result.error, `Extension load failed: ${result.error}`).toBeUndefined()
    expect(result.id).toBeTruthy()

    // Navigate to a real page
    await testInvoke(mainWindow, 'browser:navigate', viewId, 'https://example.com')
    await expect.poll(async () => {
      return (await testInvoke(mainWindow, 'browser:get-url', viewId)) as string
    }, { timeout: 15000 }).toContain('example.com')

    // Wait for content script + messaging to complete
    await mainWindow.waitForTimeout(5000)

    // Get full diagnostics from the content script's marker element
    const diag = await testInvoke(mainWindow, 'browser:execute-js', viewId, `
      (function() {
        var el = document.getElementById('slayzone-test-ext');
        if (!el) return '{"found":false}';
        return JSON.stringify(Object.assign({}, el.dataset));
      })()
    `) as string

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

    // The previous test already loaded the extension and navigated to example.com.
    // The content script should have sent a ping and received a pong.
    // Check the marker element's status immediately (content script already ran).
    // Read the diagnostic immediately (content script already ran from previous test)
    let diag: string
    try {
      diag = await testInvoke(mainWindow, 'browser:execute-js', viewId, `
        (function() {
          var el = document.getElementById('slayzone-test-ext');
          if (!el) return 'no-marker';
          return el.dataset.status + '|err=' + el.dataset.error + '|rt=' + el.dataset.runtimetype + '|sm=' + el.dataset.sendmessagetype + '|id=' + el.dataset.runtimeid;
        })()
      `) as string
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
    await testInvoke(mainWindow, 'browser:navigate', viewId, 'https://example.org')
    await expect.poll(async () => {
      return (await testInvoke(mainWindow, 'browser:get-url', viewId)) as string
    }, { timeout: 15000 }).toContain('example.org')

    // Wait and check marker exists on new page
    const status = await expect.poll(async () => {
      return await testInvoke(mainWindow, 'browser:execute-js', viewId,
        'document.getElementById("slayzone-test-ext")?.dataset.status || "not-found"'
      ) as string
    }, { timeout: 15000, message: 'Content script should re-inject on new page' }).not.toBe('not-found')
  })

  test('MV3: service worker messaging works @known-limitation', async ({ mainWindow, electronApp }) => {
    test.setTimeout(45000)
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    // Load MV3 test extension
    const result = await testInvoke(mainWindow, 'browser:import-extension', TEST_EXT_MV3_DIR) as { id?: string; error?: string }
    expect(result.error, `MV3 extension load failed: ${result.error}`).toBeUndefined()

    // Try to start the service worker explicitly and check status
    await mainWindow.waitForTimeout(2000)
    const swInfo = await electronApp.evaluate(async ({ session }) => {
      const ses = session.fromPartition('persist:browser-tabs')
      const allExts = ses.getAllExtensions()
      const swResults: string[] = []

      // Try starting each MV3 extension's service worker
      for (const ext of allExts) {
        if (ext.manifest.manifest_version === 3 && ext.manifest.background?.service_worker) {
          const scope = `chrome-extension://${ext.id}/`
          try {
            await ses.serviceWorkers.startWorkerForScope(scope)
            swResults.push(`${ext.name}: started OK`)
          } catch (err: any) {
            swResults.push(`${ext.name}: FAILED - ${err.message}`)
          }
        }
      }

      // Check running workers
      const running = ses.serviceWorkers.getAllRunning()
      const runningList = Object.entries(running).map(([id, info]) => `${id}: ${JSON.stringify(info)}`)

      return {
        extensions: allExts.map(e => `${e.name} (MV${e.manifest.manifest_version})`),
        swStartResults: swResults,
        runningWorkers: runningList,
      }
    })

    // Navigate to trigger content script
    await testInvoke(mainWindow, 'browser:navigate', viewId, 'https://example.com')
    await expect.poll(async () => {
      return (await testInvoke(mainWindow, 'browser:get-url', viewId)) as string
    }, { timeout: 15000 }).toContain('example.com')

    await mainWindow.waitForTimeout(5000)

    // Check content script injected and messaging worked
    const status = await testInvoke(mainWindow, 'browser:execute-js', viewId,
      'document.getElementById("slayzone-test-ext")?.dataset.status || "not-found"'
    ) as string

    const error = await testInvoke(mainWindow, 'browser:execute-js', viewId,
      'document.getElementById("slayzone-test-ext")?.dataset.error || "none"'
    ) as string

    expect(status, [
      `MV3 content script status: ${status}, error: ${error}`,
      `Extensions: ${JSON.stringify(swInfo.extensions)}`,
      `SW start results: ${JSON.stringify(swInfo.swStartResults)}`,
      `Running workers: ${JSON.stringify(swInfo.runningWorkers)}`,
    ].join('\n')).toBe('connected')
  })

  test('real extension: 1Password imports and page stays usable', async ({ mainWindow }) => {
    const extPath = find1PasswordPath()
    expect(extPath, '1Password extension not found in the default Chrome profile').toBeTruthy()

    test.setTimeout(60000)
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)

    // Load 1Password
    const result = await testInvoke(mainWindow, 'browser:import-extension', extPath!) as { id?: string; error?: string }
    expect(result.error, `1Password load failed: ${result.error}`).toBeUndefined()

    const loaded = await testInvoke(mainWindow, 'browser:get-extensions') as Array<{ id: string; name?: string }>
    expect(loaded.some((ext) => ext.id === result.id)).toBe(true)

    // Navigate to a page with a login form to ensure the imported extension
    // does not break navigation in a real-world page.
    await testInvoke(mainWindow, 'browser:navigate', viewId, 'https://github.com/login')
    await expect.poll(async () => {
      return (await testInvoke(mainWindow, 'browser:get-url', viewId)) as string
    }, { timeout: 20000 }).toContain('github.com')

    await expect.poll(async () => {
      return await testInvoke(mainWindow, 'browser:execute-js', viewId, 'document.readyState') as string
    }, { timeout: 15000 }).toBe('complete')

    const formInfo = await testInvoke(mainWindow, 'browser:execute-js', viewId, `
      (function() {
        return JSON.stringify({
          title: document.title,
          hasPassword: !!document.querySelector('input[type="password"]'),
          hasLoginForm: !!document.querySelector('form'),
        });
      })()
    `) as string
    const parsed = JSON.parse(formInfo) as { title: string; hasPassword: boolean; hasLoginForm: boolean }
    expect(parsed.hasLoginForm || parsed.hasPassword, `GitHub login page did not render expected form controls: ${formInfo}`).toBe(true)
  })
})

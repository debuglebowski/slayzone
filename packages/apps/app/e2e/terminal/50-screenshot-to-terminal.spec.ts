import { test, expect, seed, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  openTaskTerminal,
  switchTerminalMode,
  getMainSessionId,
  waitForPtySession,
  waitForBufferContains,
  readFullBuffer
} from '../fixtures/terminal'
import {
  ensureBrowserPanelVisible,
  focusForAppShortcut,
  getActiveViewId,
  testInvoke
} from '../fixtures/browser-view'
import { getTestUrl, TEST_HOST_MATCH } from '../fixtures/test-server'
import path from 'path'
import fs from 'fs'

test.describe('Screenshot browser to terminal', () => {
  const projectName = 'ScreenshotTest'
  let projectAbbrev: string
  let taskId: string
  let sessionId: string

  const cameraButton = (mainWindow: import('@playwright/test').Page) =>
    mainWindow.locator('[data-testid="browser-screenshot"]:visible').first()

  test.beforeAll(async ({ electronApp, mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: projectName,
      color: '#06b6d4',
      path: TEST_PROJECT_PATH
    })
    projectAbbrev = p.name.slice(0, 2).toUpperCase()
    const t = await s.createTask({ projectId: p.id, title: 'Screenshot task', status: 'todo' })
    taskId = t.id
    sessionId = getMainSessionId(taskId)
    await s.refreshData()

    await openTaskTerminal(mainWindow, { projectAbbrev, taskTitle: 'Screenshot task' })
    await switchTerminalMode(mainWindow, 'terminal')
    await waitForPtySession(mainWindow, sessionId)
    await expect(mainWindow.locator('.xterm-screen:visible')).toBeVisible({ timeout: 5_000 })
  })

  test('camera button not visible when browser panel closed', async ({ mainWindow }) => {
    await focusForAppShortcut(mainWindow)
    const btn = cameraButton(mainWindow)
    await expect(btn).not.toBeVisible({ timeout: 3_000 })
  })

  test('screenshot captures browser view and injects path into terminal', async ({
    electronApp,
    mainWindow
  }) => {
    // Open browser panel
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)
    await testInvoke(mainWindow, 'browser:navigate', viewId, await getTestUrl('/'))
    await expect
      .poll(
        async () => {
          return (await testInvoke(mainWindow, 'browser:get-url', viewId)) as string
        },
        { timeout: 15_000 }
      )
      .toContain(TEST_HOST_MATCH)

    // Wait for the active webview to become ready before expecting screenshot support.
    const btn = cameraButton(mainWindow)
    await expect(btn).toBeEnabled({ timeout: 10_000 })

    // Post-cutover the camera button uses tRPC `app.screenshot.captureView`
    // (renderer→sidecar→capability-bridge→host), NOT the legacy IPC handler. Spy
    // on the HOST AppDeps method through the bridge with a deterministic path.
    const fakeScreenshotPath = path.join(TEST_PROJECT_PATH, 'browser-screenshot.png')
    fs.writeFileSync(fakeScreenshotPath, 'fake-png-data')

    await mainWindow.evaluate(
      (fakePath) =>
        (
          window as unknown as { __testInvoke: (c: string, ...a: unknown[]) => Promise<unknown> }
        ).__testInvoke('e2e:spy-app-dep', 'screenshotCaptureView', {
          success: true,
          path: fakePath
        }),
      fakeScreenshotPath
    )

    await btn.click()

    // The file path should appear in the terminal buffer
    await waitForBufferContains(mainWindow, sessionId, 'browser-screenshot.png', 10_000)

    const buffer = await readFullBuffer(mainWindow, sessionId)
    expect(buffer).toContain('browser-screenshot.png')
  })
})

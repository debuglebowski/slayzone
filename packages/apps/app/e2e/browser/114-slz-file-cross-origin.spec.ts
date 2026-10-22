/**
 * slz-file:// responses must not be readable cross-origin by web content in
 * the browser panel. Opening a file as a top-level navigation must keep
 * working — that is how the browser panel shows local files.
 */
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  testInvoke,
  ensureBrowserPanelVisible,
  openTaskViaSearch,
  getActiveViewId
} from '../fixtures/browser-view'
import { getTestUrl, TEST_HOST_MATCH } from '../fixtures/test-server'
import { toSlzFileUrl } from '@slayzone/platform/slz-file-url'
import fs from 'fs'
import os from 'os'
import path from 'path'

const SECRET = 'slz-e2e-cross-origin-secret'

test.describe('slz-file:// cross-origin reads', () => {
  let taskId: string
  let secretDir: string
  let secretUrl: string

  test.beforeAll(async ({ mainWindow }) => {
    // Under $HOME: the handler refuses everything outside it.
    secretDir = fs.mkdtempSync(path.join(os.homedir(), '.slz-e2e-cors-'))
    const secretFile = path.join(secretDir, 'secret.txt')
    fs.writeFileSync(secretFile, SECRET)
    secretUrl = toSlzFileUrl(secretFile)

    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'CORS T', color: '#0ea5e9', path: TEST_PROJECT_PATH })
    const t = await s.createTask({ projectId: p.id, title: 'CORS task', status: 'todo' })
    taskId = t.id
    await s.refreshData()
    await openTaskViaSearch(mainWindow, 'CORS task')
  })

  test.afterAll(() => {
    fs.rmSync(secretDir, { recursive: true, force: true })
  })

  test('a web page cannot fetch() a local file', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)
    await testInvoke(mainWindow, 'browser:navigate', viewId, await getTestUrl('/'))
    await expect
      .poll(async () => (await testInvoke(mainWindow, 'browser:get-url', viewId)) as string, {
        timeout: 10000
      })
      .toContain(TEST_HOST_MATCH)

    const result = await testInvoke(
      mainWindow,
      'browser:execute-js',
      viewId,
      `fetch(${JSON.stringify(secretUrl)}).then((r) => r.text()).then((t) => 'READ:' + t, () => 'BLOCKED')`
    )
    expect(result).toBe('BLOCKED')
  })

  test('navigating to the local file still shows it', async ({ mainWindow }) => {
    await ensureBrowserPanelVisible(mainWindow)
    const viewId = await getActiveViewId(mainWindow, taskId)
    await testInvoke(mainWindow, 'browser:navigate', viewId, secretUrl)
    await expect
      .poll(
        async () =>
          (await testInvoke(
            mainWindow,
            'browser:execute-js',
            viewId,
            'document.body ? document.body.innerText : ""'
          )) as string,
        { timeout: 10000 }
      )
      .toContain(SECRET)
  })
})

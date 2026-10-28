/**
 * Find-in-page highlights live in the page find ran in. Switching browser tab with
 * the find bar open must clear THAT page — not the page of the tab switched to,
 * which left the old tab's matches highlighted when you came back.
 *
 * Observed in the main process: every webContents' findInPage / stopFindInPage is
 * wrapped to record which webContents it hit, so the spec needs no tab→view mapping.
 */
import { test, expect, seed, resetApp, TEST_PROJECT_PATH } from '../fixtures/electron'
import {
  testInvoke,
  newTabBtn,
  tabEntries,
  ensureBrowserPanelVisible,
  openTaskViaSearch,
  getViewsForTask
} from '../fixtures/browser-view'

interface FindLog {
  finds: number[]
  clears: number[]
}

test.describe('Browser find — tab switch', () => {
  let taskId = ''

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Find Tabs',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    const t = await s.createTask({ projectId: p.id, title: 'Find tabs task', status: 'todo' })
    taskId = t.id
    await s.refreshData()
    await openTaskViaSearch(mainWindow, 'Find tabs task')
    await ensureBrowserPanelVisible(mainWindow)
    await newTabBtn(mainWindow).click()
    await expect
      .poll(async () => (await getViewsForTask(mainWindow, taskId)).length, { timeout: 10_000 })
      .toBe(2)
  })

  test('switching tab clears the highlights of the tab find ran in', async ({
    mainWindow,
    electronApp
  }) => {
    const entries = tabEntries(mainWindow)
    await expect(entries).toHaveCount(2)
    await entries.nth(0).click()

    await electronApp.evaluate(({ webContents }) => {
      const log: FindLog = { finds: [], clears: [] }
      ;(globalThis as unknown as { __findLog: FindLog }).__findLog = log
      for (const wc of webContents.getAllWebContents()) {
        const find = wc.findInPage.bind(wc)
        const stop = wc.stopFindInPage.bind(wc)
        wc.findInPage = (text, opts) => {
          log.finds.push(wc.id)
          return find(text, opts)
        }
        wc.stopFindInPage = (action) => {
          log.clears.push(wc.id)
          stop(action)
        }
      }
    })
    const readLog = (): Promise<FindLog> =>
      electronApp.evaluate(() => (globalThis as unknown as { __findLog: FindLog }).__findLog)

    // Open find on the active (first) tab and search. The shortcut routes to the
    // focused browser panel, whichever view id it carries.
    const [anyView] = await getViewsForTask(mainWindow, taskId)
    await testInvoke(mainWindow, 'browser:__test-emit-shortcut', {
      viewId: anyView,
      key: 'f',
      shift: false,
      alt: false,
      meta: true,
      control: false,
      kind: 'browser-tab'
    })
    const findInput = mainWindow.getByPlaceholder('Find in page...')
    await expect(findInput).toBeVisible({ timeout: 3_000 })
    await findInput.fill('example')
    await expect.poll(async () => (await readLog()).finds.length, { timeout: 5_000 }).toBe(1)
    const findPage = (await readLog()).finds[0]

    // Switch to the second tab: find closes and the clear hits the first tab's page.
    await entries.nth(1).click()
    await expect(findInput).not.toBeVisible({ timeout: 3_000 })
    await expect.poll(async () => (await readLog()).clears, { timeout: 5_000 }).toContain(findPage)
    expect((await readLog()).clears.filter((id) => id !== findPage)).toEqual([])
  })
})

import { test, expect, seed, goHome, clickProject, resetApp } from '../fixtures/electron'
import { TEST_PROJECT_PATH } from '../fixtures/electron'
import type { Page } from '@playwright/test'

/**
 * The desktop tab bar and the hub's open tabs (`openTabs`, shared with the user's
 * other clients — the iPad) agree: a task opened here is listed on the hub, and one
 * another client opens or closes there opens or closes here.
 */
type TabStoreWindow = {
  __slayzone_tabStore?: { getState?: () => { tabs: { type: string; taskId?: string }[] } }
}

const hubList = (page: Page) =>
  page.evaluate(() => window.getTrpcVanillaClient().openTabs.list.query())

const desktopTabs = (page: Page) =>
  page.evaluate(() =>
    ((window as unknown as TabStoreWindow).__slayzone_tabStore?.getState?.()?.tabs ?? [])
      .filter((t) => t.type === 'task')
      .map((t) => t.taskId)
  )

test.describe('Open tabs shared with the hub', () => {
  let a: string
  let b: string

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Shared Tabs',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    a = (await s.createTask({ projectId: p.id, title: 'Shared A', status: 'in_progress' })).id
    b = (await s.createTask({ projectId: p.id, title: 'Shared B', status: 'in_progress' })).id
    await s.refreshData()
    await goHome(mainWindow)
    await clickProject(mainWindow, p.name.slice(0, 2).toUpperCase())
    await expect(mainWindow.getByText('Shared A').first()).toBeVisible({ timeout: 5_000 })
  })

  test('a task opened on the desktop is listed on the hub', async ({ mainWindow }) => {
    await mainWindow.getByText('Shared A').first().click()
    await expect(async () => expect(await hubList(mainWindow)).toContain(a)).toPass({
      timeout: 5_000
    })
  })

  test('opened by another client: opens here; closed by another client: closes here', async ({
    mainWindow
  }) => {
    await mainWindow.evaluate(
      (taskId) => window.getTrpcVanillaClient().openTabs.open.mutate({ taskId }),
      b
    )
    await expect(async () => expect(await desktopTabs(mainWindow)).toContain(b)).toPass({
      timeout: 5_000
    })
    await mainWindow.evaluate(
      (taskId) => window.getTrpcVanillaClient().openTabs.close.mutate({ taskId }),
      a
    )
    await expect(async () => expect(await desktopTabs(mainWindow)).not.toContain(a)).toPass({
      timeout: 5_000
    })
    // The desktop does not push its stale copy back.
    expect(await hubList(mainWindow)).toEqual([b])
  })
})

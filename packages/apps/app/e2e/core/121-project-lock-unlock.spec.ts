import {
  test,
  expect,
  seed,
  resetApp,
  TEST_PROJECT_PATH,
  goHome,
  clickProject
} from '../fixtures/electron'

/**
 * A project lock must clear on screen the moment it ends — by expiry or by
 * "Unlock early" — and come back on "Re-lock". Lock state depends on the clock
 * and session-only overrides that React cannot see; App used to read it through
 * a plain call during render, which the React Compiler memoized on the project
 * object, so the lock screen stayed up after the lock had ended.
 */
test.describe('Project lock clears and re-locks on screen', () => {
  let projectId = ''

  const setLock = (page: import('@playwright/test').Page, msFromNow: number | null) =>
    page.evaluate(
      async ({ id, ms }) => {
        await window.getTrpcVanillaClient().projects.update.mutate({
          id,
          lockConfig: {
            locked_until: ms === null ? null : new Date(Date.now() + ms).toISOString(),
            rate_limit: null,
            schedule: null
          }
        })
        await (
          window as unknown as { __slayzone_refreshData?: () => Promise<void> }
        ).__slayzone_refreshData?.()
      },
      { id: projectId, ms: msFromNow }
    )

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Lock Probe',
      color: '#0ea5e9',
      path: TEST_PROJECT_PATH
    })
    projectId = p.id
    await s.createTask({ projectId: p.id, title: 'Lock probe task', status: 'todo' })
    await s.refreshData()
    await goHome(mainWindow)
    await clickProject(mainWindow, 'LO')
  })

  test.afterEach(async ({ mainWindow }) => {
    await setLock(mainWindow, null)
  })

  test('a duration lock clears on its own when it expires', async ({ mainWindow: page }) => {
    await setLock(page, 3_000)
    const lockScreen = page.getByText('Lock Probe locked')
    await expect(lockScreen).toBeVisible({ timeout: 5_000 })
    await expect(lockScreen).toBeHidden({ timeout: 6_000 })
    await expect(page.getByText('Lock probe task').first()).toBeVisible()
  })

  test('Unlock early clears the lock screen; Re-lock brings it back', async ({
    mainWindow: page
  }) => {
    await setLock(page, 60 * 60_000)
    const lockScreen = page.getByText('Lock Probe locked')
    await expect(lockScreen).toBeVisible({ timeout: 5_000 })
    await page.getByRole('button', { name: 'Unlock early' }).click()
    await expect(lockScreen).toBeHidden({ timeout: 3_000 })
    await page.getByRole('button', { name: 'Re-lock' }).click()
    await expect(lockScreen).toBeVisible({ timeout: 3_000 })
  })
})

/**
 * Backup restore from Settings restarts the HUB, not the app (decision D2): the hub
 * stages the restore, exits 75, the desktop supervisor starts it again, and it swaps
 * the backup in before opening its database. The window waits for the new hub, then
 * reloads onto the restored data. The app process is the same one throughout — it
 * used to relaunch.
 */
import {
  expect,
  openSettingsRoute,
  resetApp,
  seed,
  test,
  TEST_PROJECT_PATH
} from '../fixtures/electron'

type Vanilla = {
  app: { backup: { create: { mutate: (i: { name: string }) => Promise<{ filename: string }> } } }
  projects: { list: { query: () => Promise<Array<{ name: string }>> } }
}

test('restore from Settings: hub restarts, the window reloads onto the backup, the app stays up', async ({
  electronApp,
  mainWindow
}) => {
  test.setTimeout(120_000)
  await resetApp(mainWindow)
  const s = seed(mainWindow)
  await s.createProject({ name: 'Before backup', color: '#6366f1', path: TEST_PROJECT_PATH })
  await mainWindow.evaluate(() =>
    (window as unknown as { getTrpcVanillaClient: () => Vanilla })
      .getTrpcVanillaClient()
      .app.backup.create.mutate({ name: 'e2e restore point' })
  )
  await s.createProject({ name: 'After backup', color: '#22c55e', path: TEST_PROJECT_PATH })

  const appPid = await electronApp.evaluate(() => process.pid)
  // Survives only until the window reloads.
  await mainWindow.evaluate(() => {
    ;(window as unknown as { __beforeRestore?: boolean }).__beforeRestore = true
  })

  await openSettingsRoute(mainWindow, 'backup')
  const row = mainWindow
    .locator('div')
    .filter({ hasText: 'e2e restore point' })
    .filter({
      has: mainWindow.getByRole('button', { name: 'Restore' })
    })
  await row.last().getByRole('button', { name: 'Restore' }).click()
  await mainWindow.getByRole('button', { name: 'Restore & restart hub' }).click()

  await expect
    .poll(
      () =>
        mainWindow
          .evaluate(
            () => (window as unknown as { __beforeRestore?: boolean }).__beforeRestore !== true
          )
          .catch(() => false),
      { timeout: 90_000, message: 'the window reloaded after the hub came back' }
    )
    .toBe(true)
  expect(await electronApp.evaluate(() => process.pid), 'the app was not relaunched').toBe(appPid)

  const names = async (): Promise<string[]> =>
    (
      await mainWindow
        .evaluate(() =>
          (window as unknown as { getTrpcVanillaClient: () => Vanilla })
            .getTrpcVanillaClient()
            .projects.list.query()
        )
        .catch(() => [] as Array<{ name: string }>)
    ).map((p) => p.name)
  await expect.poll(names, { timeout: 30_000 }).toContain('Before backup')
  expect(await names(), 'made after the backup: gone').not.toContain('After backup')
})

test('a window that did not restore anything reloads too, once the hub data was replaced', async ({
  electronApp,
  mainWindow
}) => {
  test.setTimeout(120_000)
  await resetApp(mainWindow)
  const s = seed(mainWindow)
  await s.createProject({ name: 'Elsewhere before', color: '#6366f1', path: TEST_PROJECT_PATH })
  const backup = await mainWindow.evaluate(() =>
    (window as unknown as { getTrpcVanillaClient: () => Vanilla })
      .getTrpcVanillaClient()
      .app.backup.create.mutate({ name: 'restored elsewhere' })
  )
  await s.createProject({ name: 'Elsewhere after', color: '#22c55e', path: TEST_PROJECT_PATH })
  const appPid = await electronApp.evaluate(() => process.pid)
  await mainWindow.evaluate(() => {
    ;(window as unknown as { __beforeRestore?: boolean }).__beforeRestore = true
  })
  // Restored by someone else (another admin's client): this window's Settings is not
  // involved, only the hub's data generation (`hub.describe`).
  await mainWindow.evaluate(
    (filename) =>
      (
        window as unknown as {
          getTrpcVanillaClient: () => {
            app: { backup: { restore: { mutate: (i: { filename: string }) => Promise<unknown> } } }
          }
        }
      )
        .getTrpcVanillaClient()
        .app.backup.restore.mutate({ filename }),
    backup.filename
  )
  await expect
    .poll(
      () =>
        mainWindow
          .evaluate(
            () => (window as unknown as { __beforeRestore?: boolean }).__beforeRestore !== true
          )
          .catch(() => false),
      { timeout: 60_000, message: 'the window reloaded on the new data generation' }
    )
    .toBe(true)
  expect(await electronApp.evaluate(() => process.pid)).toBe(appPid)
  await expect
    .poll(
      async () =>
        (
          await mainWindow
            .evaluate(() =>
              (window as unknown as { getTrpcVanillaClient: () => Vanilla })
                .getTrpcVanillaClient()
                .projects.list.query()
            )
            .catch(() => [] as Array<{ name: string }>)
        ).map((p) => p.name),
      { timeout: 30_000 }
    )
    .toContain('Elsewhere before')
})

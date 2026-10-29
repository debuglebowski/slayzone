import {
  test,
  expect,
  seed,
  resetApp,
  clickSettings,
  openTaskById,
  TEST_PROJECT_PATH
} from '../fixtures/electron'

// An already-open task picks up the Loop command lab flag as soon as it's turned
// on. The task view used to read the flag once when it mounted, so the Loop
// button only appeared after the task was closed and reopened.

const setLoopModeLab = (page: import('@playwright/test').Page, on: boolean) =>
  page.evaluate(
    (v) =>
      window.getTrpcVanillaClient().app.meta.setLabFlag.mutate({ key: 'labs_loop_mode', on: v }),
    on
  )

test.describe('Loop command lab flag reaches an open task', () => {
  let taskId = ''

  test.beforeAll(async ({ mainWindow }) => {
    // The flag lives in the client store (not the DB): set it before the reset's reload.
    await setLoopModeLab(mainWindow, false)
    await resetApp(mainWindow)
    const s = seed(mainWindow)
    const p = await s.createProject({
      name: 'Loop Labs',
      color: '#f97316',
      path: TEST_PROJECT_PATH
    })
    // Not a plain `terminal` task: the Loop button only shows for agent modes.
    const t = await s.createTask({
      projectId: p.id,
      title: 'Loop labs task',
      status: 'todo',
      terminalMode: 'claude-code'
    })
    taskId = t.id
    await s.refreshData()
  })

  test.afterAll(async ({ mainWindow }) => {
    await setLoopModeLab(mainWindow, false)
  })

  test('turning Loop command on in Labs shows its button in the open task', async ({
    mainWindow
  }) => {
    await openTaskById(mainWindow, taskId)
    const loopButton = mainWindow.locator('button[aria-label="Loop command"]:visible')
    await expect(mainWindow.locator('[data-testid="terminal-mode-trigger"]:visible')).toBeVisible({
      timeout: 10_000
    })
    await expect(loopButton).toHaveCount(0)

    // The user path, with the task still open behind Settings.
    await clickSettings(mainWindow)
    const dialog = mainWindow.getByRole('dialog').last()
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await dialog.locator('aside button').filter({ hasText: 'Labs' }).first().click()
    const toggle = dialog.locator('#labs_loop_mode')
    await expect(toggle).toBeVisible({ timeout: 5_000 })
    await toggle.click()
    await expect(toggle).toHaveAttribute('data-state', 'checked')
    await mainWindow.keyboard.press('Escape')
    await expect(dialog).toBeHidden({ timeout: 5_000 })

    await expect(loopButton).toBeVisible({ timeout: 5_000 })
  })
})

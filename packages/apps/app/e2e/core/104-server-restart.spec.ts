import { test, expect, clickSettings, resetApp } from '../fixtures/electron'

declare global {
  interface Window {
    __testInvoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  }
}

type SidecarStatus = {
  health: 'starting' | 'ready' | 'restarting' | 'failed'
  pid: number | null
  port: number | null
  totalRespawns: number
}

/**
 * Server settings — the "Restart server" button cycles the embedded side-car
 * in place: new child pid, same sticky port, healthy again. The IPC resolves
 * only after the new child answers /health, so the success toast is the
 * completion signal.
 */
test.describe('Server restart button', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('Restart cycles the embedded server to a new healthy pid on the same port', async ({
    mainWindow
  }) => {
    const status = async (): Promise<SidecarStatus> =>
      (await mainWindow.evaluate(() =>
        window.__testInvoke('app:get-sidecar-status')
      )) as SidecarStatus

    // Sidecar boots off the critical path — wait for the first healthy state.
    await expect.poll(async () => (await status()).health, { timeout: 30_000 }).toBe('ready')
    const before = await status()
    expect(before.pid).toBeTruthy()

    const dialog = mainWindow.getByRole('dialog').last()
    if (!(await dialog.isVisible().catch(() => false))) {
      await clickSettings(mainWindow)
      await expect(dialog).toBeVisible({ timeout: 5_000 })
    }
    await dialog.locator('aside button').filter({ hasText: 'Server' }).first().click()

    const button = dialog.getByTestId('server-restart-button')
    await expect(button).toBeEnabled({ timeout: 5_000 })
    await button.click()

    // Resolves only once the new child is healthy.
    await expect(mainWindow.getByText('Server restarted')).toBeVisible({ timeout: 30_000 })

    const after = await status()
    expect(after.health).toBe('ready')
    expect(after.pid).not.toBe(before.pid)
    expect(after.port).toBe(before.port)
    expect(after.totalRespawns).toBe(before.totalRespawns + 1)

    await mainWindow.keyboard.press('Escape')
  })
})

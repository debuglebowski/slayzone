import http from 'http'
import type { AddressInfo } from 'net'
import { test, expect, clickSettings, resetApp } from '../fixtures/electron'

/**
 * Slice 7 — remote URL /health probe from the Server settings tab.
 *
 * The probe runs in the MAIN process (app:probe-server-health) against a real
 * HTTP server spun up by this spec — success answers GET /health with
 * {ok:true} (the @slayzone/hub health shape), failure is a dead port.
 */
test.describe('Remote server health probe', () => {
  let server: http.Server | null = null
  let port = 0

  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
    server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, port, dbPath: '/x', uptimeMs: 1 }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        port = (server!.address() as AddressInfo).port
        resolve()
      })
    })
  })

  test.afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = null
    }
  })

  const openServerTab = async (mainWindow: import('@playwright/test').Page) => {
    const dialog = mainWindow.getByRole('dialog').last()
    if (!(await dialog.isVisible().catch(() => false))) {
      await clickSettings(mainWindow)
      await expect(dialog).toBeVisible({ timeout: 5_000 })
    }
    await dialog.locator('aside button').filter({ hasText: 'Server' }).first().click()
    await expect(dialog.getByTestId('server-mode-local')).toBeVisible({ timeout: 5_000 })
    return dialog
  }

  test('probe success shows reachable + the normalized ws URL', async ({ mainWindow }) => {
    const dialog = await openServerTab(mainWindow)
    await dialog.getByTestId('server-mode-remote').check()
    await dialog.getByTestId('server-remote-url').fill(`http://127.0.0.1:${port}`)
    await dialog.getByTestId('server-probe-button').click()

    const result = dialog.getByTestId('server-probe-result')
    await expect(result).toContainText('reachable', { timeout: 10_000 })
    await expect(result).toContainText(`ws://127.0.0.1:${port}/trpc`)
  })

  test('probe failure shows an inline error', async ({ mainWindow }) => {
    // Tear the server down — same port now refuses connections.
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null

    const dialog = await openServerTab(mainWindow)
    await dialog.getByTestId('server-mode-remote').check()
    await dialog.getByTestId('server-remote-url').fill(`http://127.0.0.1:${port}`)
    await dialog.getByTestId('server-probe-button').click()

    await expect(dialog.getByTestId('server-probe-result')).toContainText('✗', {
      timeout: 10_000
    })
  })

  test('probe of an invalid URL reports validation error without a request', async ({
    mainWindow
  }) => {
    const dialog = await openServerTab(mainWindow)
    await dialog.getByTestId('server-mode-remote').check()
    await dialog.getByTestId('server-remote-url').fill('garbage')
    await dialog.getByTestId('server-probe-button').click()

    await expect(dialog.getByTestId('server-probe-result')).toContainText('Invalid URL', {
      timeout: 5_000
    })
    await mainWindow.keyboard.press('Escape')
  })
})

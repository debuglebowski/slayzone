import fs from 'fs'
import path from 'path'
import { test as base, expect } from '@playwright/test'
import { launchIsolatedElectron } from '../fixtures/electron'

/**
 * Slice 7 — RemoteConfigScreen boot-fallback path.
 *
 * Boots a fully isolated app instance whose pre-seeded boot-config.json points
 * remote mode at a dead URL. The renderer must show the recovery screen
 * (instead of mounting the app against a dead WS), let the user probe, and
 * write a local fallback via "Switch to local" (+ relaunch, which is a
 * Playwright no-op — the file content is the assertion).
 *
 * Uses the raw Playwright test base: the shared worker fixture (and its
 * resetApp/tRPC helpers) assumes a working server connection, which is exactly
 * what this spec must boot WITHOUT.
 */
base.describe('RemoteConfigScreen fallback', () => {
  base('boots into the recovery screen and can fall back to local', async () => {
    base.setTimeout(120_000)
    const launched = await launchIsolatedElectron({
      name: 'remote-config-screen',
      seedUserData: (userDataDir) => {
        fs.writeFileSync(
          path.join(userDataDir, 'boot-config.json'),
          JSON.stringify(
            // Port 1 is reserved/unassigned — guaranteed connection refused.
            { server_mode: 'remote', remote_server_url: 'ws://127.0.0.1:1/trpc' },
            null,
            2
          )
        )
      }
    })

    try {
      const page = launched.page
      const screen = page.getByTestId('remote-config-screen')
      await expect(screen).toBeVisible({ timeout: 20_000 })
      await expect(page.getByTestId('remote-config-url')).toHaveValue('ws://127.0.0.1:1/trpc')

      // Probing the dead URL fails inline.
      await page.getByTestId('remote-config-validate').click()
      await expect(page.getByTestId('remote-config-probe-result')).toContainText('✗', {
        timeout: 10_000
      })

      // Fall back to local: writes the file; relaunch is a Playwright no-op.
      await page.getByTestId('remote-config-switch-local').click()
      await expect
        .poll(
          () => {
            try {
              const raw = fs.readFileSync(
                path.join(launched.userDataDir, 'boot-config.json'),
                'utf8'
              )
              return (JSON.parse(raw) as { server_mode?: string }).server_mode
            } catch {
              return null
            }
          },
          { timeout: 10_000 }
        )
        .toBe('local')
    } finally {
      await launched.close()
    }
  })
})

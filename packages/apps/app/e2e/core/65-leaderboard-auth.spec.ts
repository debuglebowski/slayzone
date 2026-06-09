import { test, expect, resetApp } from '../fixtures/electron'

const OAUTH_REDIRECT_URI = 'slayzone://auth/callback'

test.describe('Leaderboard auth transport', () => {
  test.beforeAll(async ({ mainWindow }) => {
    await resetApp(mainWindow)
  })

  test('uses system deep-link auth transport', async ({ electronApp, mainWindow }) => {
    await mainWindow.evaluate(async () => {
      await window
        .getTrpcVanillaClient()
        .settings.set.mutate({ key: 'leaderboard_enabled', value: '1' })
    })
    await mainWindow.reload()
    await mainWindow.waitForSelector('#root', { timeout: 10_000 })

    await electronApp.evaluate(({ ipcMain }) => {
      const g = globalThis as Record<string, unknown>
      g.__leaderboardSystemAuthMock = {
        calls: 0,
        lastConvexUrl: null as string | null,
        lastRedirectTo: null as string | null
      }

      ipcMain.removeHandler('auth:github-system-sign-in')
      ipcMain.handle(
        'auth:github-system-sign-in',
        async (_event, input: { convexUrl: string; redirectTo: string }) => {
          const state = g.__leaderboardSystemAuthMock as {
            calls: number
            lastConvexUrl: string | null
            lastRedirectTo: string | null
          }
          state.calls += 1
          state.lastConvexUrl = input.convexUrl
          state.lastRedirectTo = input.redirectTo
          // Keep test deterministic/offline while still exercising transport selection.
          return { ok: false, cancelled: true }
        }
      )
    })

    const leaderboardTabButton = mainWindow.locator('.lucide-trophy').first()
    await expect(leaderboardTabButton).toBeVisible({ timeout: 5_000 })
    await leaderboardTabButton.click()

    await expect(mainWindow.getByRole('heading', { name: 'Leaderboard' })).toBeVisible({
      timeout: 5_000
    })
    await expect(
      mainWindow.getByText('Leaderboard unavailable (Convex not configured)')
    ).not.toBeVisible()

    const clicked = await mainWindow.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button')).filter(
        (button) =>
          button.textContent?.trim() === 'Sign in with GitHub' &&
          button instanceof HTMLButtonElement &&
          button.offsetParent !== null &&
          !button.disabled
      ) as HTMLButtonElement[]
      const button = buttons[0]
      if (!button) return false
      button.click()
      return true
    })
    expect(clicked).toBe(true)

    await expect
      .poll(
        async () => {
          return await electronApp.evaluate(() => {
            const state = (globalThis as Record<string, unknown>).__leaderboardSystemAuthMock as
              | {
                  calls: number
                  lastConvexUrl: string | null
                  lastRedirectTo: string | null
                }
              | undefined
            return {
              calls: state?.calls ?? 0,
              lastConvexUrl: state?.lastConvexUrl ?? null,
              lastRedirectTo: state?.lastRedirectTo ?? null
            }
          })
        },
        { timeout: 10_000 }
      )
      .toEqual({
        calls: 1,
        lastConvexUrl: expect.stringContaining('.convex.cloud'),
        lastRedirectTo: OAUTH_REDIRECT_URI
      })
  })
})

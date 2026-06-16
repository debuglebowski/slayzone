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

    // Post-cutover the renderer's "Sign in with GitHub" uses the tRPC
    // `app.auth.githubSystemSignIn` mutation (NOT the legacy IPC channel), which
    // routes renderer→sidecar→capability-bridge→host. Spy on the HOST AppDeps
    // method through the bridge; the fakeResult keeps it deterministic/offline
    // while still exercising the system-deep-link transport selection.
    await mainWindow.evaluate(() =>
      (
        window as unknown as { __testInvoke: (c: string, ...a: unknown[]) => Promise<unknown> }
      ).__testInvoke('e2e:spy-app-dep', 'authGithubSystemSignIn', { ok: false, cancelled: true })
    )

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
            const spy = (globalThis as Record<string, unknown>).__appDepSpies as
              | Record<string, { calls: number; lastArgs: unknown[] | null }>
              | undefined
            const state = spy?.authGithubSystemSignIn
            const input = state?.lastArgs?.[0] as
              | { convexUrl?: string; redirectTo?: string }
              | undefined
            return {
              calls: state?.calls ?? 0,
              lastConvexUrl: input?.convexUrl ?? null,
              lastRedirectTo: input?.redirectTo ?? null
            }
          })
        },
        { timeout: 10_000 }
      )
      .toEqual({
        calls: 1,
        // The deep-link transport forwards the build's VITE_CONVEX_URL verbatim.
        // Assert it's a real URL rather than a specific host — CI builds with a
        // placeholder (example.invalid), local builds with the real .convex.cloud.
        lastConvexUrl: expect.stringMatching(/^https?:\/\//),
        lastRedirectTo: OAUTH_REDIRECT_URI
      })
  })
})

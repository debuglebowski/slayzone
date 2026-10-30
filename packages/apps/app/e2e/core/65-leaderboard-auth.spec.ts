import { test as base, expect } from '@playwright/test'
import { launchIsolatedElectron, resetApp } from '../fixtures/electron'

const OAUTH_REDIRECT_URI = 'slayzone://auth/callback'
/** `.invalid` (RFC 2606) never resolves: nothing leaves the box. Sign-in is stubbed at the host. */
const CONVEX_ADDRESS = 'example.invalid'

/**
 * The leaderboard — and its sidebar trophy — exists only when the app has a Convex
 * deployment. That is otherwise a BUILD property (`VITE_CONVEX_URL`): baked in by a
 * checkout with the untracked root `.env`, absent from a worktree's build, so this spec
 * used to pass or fail on which checkout built `out/`. (It also set the
 * `leaderboard_enabled` setting, which nothing has read since the toggle was retired.)
 *
 * Isolated instance: it names its own deployment through `SLAYZONE_E2E_CONVEX_ADDRESS`
 * (PLAYWRIGHT-only, app main `convex-deployment.ts`), which main hands to the renderer
 * and to its hub alike — the same one-deployment path a real build takes.
 */
base.describe('Leaderboard auth transport', () => {
  base('uses system deep-link auth transport', async () => {
    base.setTimeout(120_000)
    const launched = await launchIsolatedElectron({
      name: 'leaderboard-auth',
      extraEnv: () => ({ SLAYZONE_E2E_CONVEX_ADDRESS: CONVEX_ADDRESS })
    })
    try {
      const { app: electronApp, page: mainWindow } = launched
      await resetApp(mainWindow)

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
        mainWindow.getByRole('heading', { name: 'Leaderboard unavailable' })
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
          // The app's one deployment, end to end: the renderer sent it, and the hub —
          // handed the same one by main — accepted it and passed it to the host.
          lastConvexUrl: `https://${CONVEX_ADDRESS}`,
          lastRedirectTo: OAUTH_REDIRECT_URI
        })
    } finally {
      await launched.close()
    }
  })
})

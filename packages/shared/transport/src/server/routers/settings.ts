import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { SettingsService, settingsEvents } from '@slayzone/settings/server'
import { router, publicProcedure } from '../trpc'
import { getAppDeps } from '../app-deps'

const themeInput = z.enum(['light', 'dark', 'system'])

/**
 * Theme is Electron `nativeTheme`-backed (host-only), so the theme procedures
 * resolve the injected `AppDeps` — on the Electron host these run the real
 * nativeTheme API; when the renderer talks to the side-car they are forwarded
 * over the capability bridge to the host. The `theme:changed` event streams back
 * on the bridge's `theme` channel into this process's `settingsEvents`, which
 * `onThemeChanged` wraps. settings get/set/getAll stay electron-free (ctx.db).
 */

/**
 * Mirrors the 3 `db:settings:*` + 3 `theme:*` IPC handlers (settings/main) plus
 * the `theme:changed` broadcast. get/set/getAll route through the warmed
 * SettingsService singleton — `forDatabase` is keyed by `ctx.db`, the same handle
 * the app warmed and registered the IPC handlers against, so write-through cache
 * coherence holds across both paths. IPC + tRPC share one impl; renderer cutover
 * + handler deletion are slice 5.
 */
export const settingsRouter = router({
  get: publicProcedure
    .input(z.object({ key: z.string() }))
    .query(async ({ ctx, input }) => (await SettingsService.forDatabase(ctx.db).get(input.key)) ?? null),

  set: publicProcedure
    .input(z.object({ key: z.string(), value: z.string() }))
    .mutation(({ ctx, input }) => SettingsService.forDatabase(ctx.db).set(input.key, input.value)),

  getAll: publicProcedure.query(({ ctx }) => SettingsService.forDatabase(ctx.db).getAll()),

  // --- Theme (Electron nativeTheme — host-only, via injected AppDeps) ---

  getEffectiveTheme: publicProcedure.query(() => getAppDeps().themeGetEffective()),

  getThemeSource: publicProcedure.query(() => getAppDeps().themeGetSource()),

  setTheme: publicProcedure
    .input(themeInput)
    .mutation(({ input }) => getAppDeps().themeSet(input)),

  /**
   * Replaces the `theme:changed` broadcast. Fires when nativeTheme.on('updated')
   * triggers — an OS dark/light toggle while themeSource === 'system', or an
   * explicit setTheme. Renderer subscribes here once it drops IPC (slice 5).
   */
  onThemeChanged: publicProcedure.subscription(() =>
    observable<'dark' | 'light'>((emit) => {
      const handler = (effective: 'dark' | 'light'): void => emit.next(effective)
      settingsEvents.on('theme:changed', handler)
      return () => {
        settingsEvents.off('theme:changed', handler)
      }
    })
  )
})

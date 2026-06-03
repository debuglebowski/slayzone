import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { TRPCError } from '@trpc/server'
import { SettingsService, settingsEvents } from '@slayzone/settings/server'
import { router, publicProcedure } from '../trpc'

const themeInput = z.enum(['light', 'dark', 'system'])

/**
 * Theme procedures dynamically import @slayzone/settings/main because the
 * underlying nativeTheme API is Electron-main-only. In standalone server mode
 * the import fails and they throw a clear error (remote-mode UI hides the theme
 * controls). settings get/set/getAll stay on the electron-free /server import so
 * they work headless too.
 */
async function getThemeModule(): Promise<typeof import('@slayzone/settings/main') | null> {
  try {
    return await import('@slayzone/settings/main')
  } catch {
    return null
  }
}

const themeUnavailable = (): never => {
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: 'Theme unavailable in this server context (Electron-only)'
  })
}

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

  // --- Theme (Electron-only) ---

  getEffectiveTheme: publicProcedure.query(async () => {
    const mod = await getThemeModule()
    return mod ? mod.getEffectiveTheme() : themeUnavailable()
  }),

  getThemeSource: publicProcedure.query(async () => {
    const mod = await getThemeModule()
    return mod ? mod.getThemeSource() : themeUnavailable()
  }),

  setTheme: publicProcedure.input(themeInput).mutation(async ({ ctx, input }) => {
    const mod = await getThemeModule()
    return mod ? mod.setTheme(ctx.db, input) : themeUnavailable()
  }),

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

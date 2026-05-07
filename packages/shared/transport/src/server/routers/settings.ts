import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { TRPCError } from '@trpc/server'
import {
  getSetting,
  setSetting,
  getAllSettings,
  settingsEvents,
} from '@slayzone/settings/server'
import { router, publicProcedure } from '../trpc'

const themeInput = z.enum(['light', 'dark', 'system'])

/**
 * Theme procedures dynamically import @slayzone/settings/electron because
 * the underlying nativeTheme API is Electron-main-only. When running in
 * standalone server mode (Phase 3+), they throw with a clear message.
 * Per master §11d — Electron-only feature; remote-mode UI hides the
 * theme controls.
 */
async function getThemeModule() {
  try {
    return await import('@slayzone/settings/electron')
  } catch {
    return null
  }
}

export const settingsRouter = router({
  get: publicProcedure
    .input(z.object({ key: z.string() }))
    .query(({ ctx, input }) => getSetting(ctx.db, input.key)),

  set: publicProcedure
    .input(z.object({ key: z.string(), value: z.string() }))
    .mutation(({ ctx, input }) => {
      setSetting(ctx.db, input.key, input.value)
    }),

  getAll: publicProcedure.query(({ ctx }) => getAllSettings(ctx.db)),

  // --- Theme (Electron-only) ---

  getEffectiveTheme: publicProcedure.query(async () => {
    const mod = await getThemeModule()
    if (!mod) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Theme unavailable in this server context (Electron-only)' })
    return mod.getEffectiveTheme()
  }),

  getThemeSource: publicProcedure.query(async () => {
    const mod = await getThemeModule()
    if (!mod) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Theme unavailable in this server context (Electron-only)' })
    return mod.getThemeSource()
  }),

  setTheme: publicProcedure
    .input(themeInput)
    .mutation(async ({ ctx, input }) => {
      const mod = await getThemeModule()
      if (!mod) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Theme unavailable in this server context (Electron-only)' })
      return mod.setTheme(ctx.db, input)
    }),

  /**
   * Replaces the theme:changed broadcast. Fires when nativeTheme.on('updated')
   * triggers (OS dark/light mode toggle while themeSource === 'system') OR
   * when the user explicitly sets a theme via setTheme.
   */
  onThemeChanged: publicProcedure.subscription(() =>
    observable<'dark' | 'light'>((emit) => {
      const handler = (effective: 'dark' | 'light'): void => emit.next(effective)
      settingsEvents.on('theme:changed', handler)
      return () => {
        settingsEvents.off('theme:changed', handler)
      }
    }),
  ),
})

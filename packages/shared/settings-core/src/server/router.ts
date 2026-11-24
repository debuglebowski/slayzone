import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { settingScope } from './scope'
import { observable } from '@trpc/server/observable'
import { router, publicProcedure, type TrpcContext } from '@slayzone/trpc-server'
import { settingsWriteProcedure } from './settings-admin'
import { SettingsService } from './service'
import { settingsEvents } from './events'
import { getSettingsHostDeps, notifySettingsWritten } from './settings-host-deps'
import {
  clearProjectOverride,
  isLockedForProjects,
  listOverridesOfKey,
  listProjectOverrides,
  readEffectiveSetting,
  setProjectOverride
} from './project-settings'

const themeInput = z.enum(['light', 'dark', 'system'])

/**
 * Per user (T-16): a request that carries a user (a hub that requires login) sees
 * the hub's shared keys plus its OWN copy of every per-user key (`viewState`,
 * layout, filters …); a request without one (a hub without login) sees the global
 * table as before. Integration credentials are never served. Which key is which:
 * `settingScope` (`./scope`). The client sends nothing new —
 * the user comes from the verified connection.
 */
const settingsFor = (ctx: TrpcContext) =>
  SettingsService.forDatabase(ctx.db).forUser(ctx.principal?.userId ?? null)

/**
 * Theme is Electron `nativeTheme`-backed (host-only), so the theme procedures
 * resolve the injected host deps (`settings-host-deps.ts`) — on the Electron host these run the real
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
    .query(async ({ ctx, input }) => (await settingsFor(ctx).get(input.key)) ?? null),

  // Every write tells every window (`notify.onSettingsChanged`, scoped to the key),
  // so a second window — a secondary task window — picks up panel config, layout
  // and the rest. Consumers refetch only the keys they read; the writing window's
  // own refetch finds the value it already holds and re-renders nothing.
  set: settingsWriteProcedure
    .input(z.object({ key: z.string(), value: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const result = await settingsFor(ctx).set(input.key, input.value)
      notifySettingsWritten({ keys: [input.key] })
      return result
    }),

  getAll: publicProcedure.query(({ ctx }) => settingsFor(ctx).getAll()),

  // --- Project overrides of hub settings (plans/settings-by-scope.md, phase 3) ---

  /** The value of hub setting `key` for work in `projectId`, and where it came from. */
  effective: publicProcedure
    .input(
      z.object({
        key: z.string(),
        projectId: z.string().nullish(),
        /** Instead of `projectId`: the project of this task (what a task view has). */
        taskId: z.string().nullish()
      })
    )
    .query(async ({ ctx, input }) => {
      // Hub keys only: per-user keys live per user (`settings.get`), and internal
      // ones (credentials) are never served.
      if (settingScope(input.key) !== 'hub') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `"${input.key}" is not a hub setting` })
      }
      const projectId =
        input.projectId ??
        (input.taskId
          ? ((
              await ctx.db.get<{ project_id: string }>(
                'SELECT project_id FROM tasks WHERE id = ?',
                [input.taskId]
              )
            )?.project_id ?? null)
          : null)
      return readEffectiveSetting(ctx.db, input.key, projectId)
    }),

  /** Every hub setting a project overrides (key → value). */
  projectOverrides: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ ctx, input }) => listProjectOverrides(ctx.db, input.projectId)),

  /** Which projects on this hub override `key` (the hub page's "N projects override"). */
  overridesOfKey: publicProcedure
    .input(z.object({ key: z.string() }))
    // Locked by the hub (phase 6): no project's own value applies, so none is listed.
    .query(async ({ ctx, input }) =>
      (await isLockedForProjects(ctx.db, input.key)) ? [] : listOverridesOfKey(ctx.db, input.key)
    ),

  setProjectOverride: publicProcedure
    .input(z.object({ projectId: z.string(), key: z.string(), value: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await setProjectOverride(ctx.db, input.projectId, input.key, input.value)
      notifySettingsWritten({ keys: [input.key] })
    }),

  clearProjectOverride: publicProcedure
    .input(z.object({ projectId: z.string(), key: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await clearProjectOverride(ctx.db, input.projectId, input.key)
      notifySettingsWritten({ keys: [input.key] })
    }),

  // --- Theme (Electron nativeTheme — host-only, via injected host deps) ---

  getEffectiveTheme: publicProcedure.query(() => getSettingsHostDeps().themeGetEffective()),

  getThemeSource: publicProcedure.query(() => getSettingsHostDeps().themeGetSource()),

  setTheme: publicProcedure
    .input(themeInput)
    .mutation(({ input }) => getSettingsHostDeps().themeSet(input)),

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

export type SettingsRouter = typeof settingsRouter
export type SettingsMounts = { settings: SettingsRouter }

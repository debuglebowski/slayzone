import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { settingScope } from './scope'
import { observable } from '@trpc/server/observable'
import { router, publicProcedure, type TrpcContext } from '@slayzone/trpc-server'
import { settingsWriteProcedure } from './settings-admin'
import { SettingsService } from './service'
import { notifySettingsWritten } from './settings-host-deps'
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
 * get/set/getAll route through the warmed
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

  // --- Theme mode: RETIRED (task 557ebb72) ---
  //
  // The mode (light / dark / system) is each device's own: the desktop keeps it in
  // client.config.json (Electron main applies it before the first window paints), the
  // shells in their own store — through the client host, never a hub. These paths
  // stay for older desktops and mobile with a hub's own answer: 'system' (each device
  // follows its OS, D2), an echo for a setter that stores nothing, and a change
  // stream that never fires. The palette keys (`app_theme_*`) are ordinary settings.

  getEffectiveTheme: publicProcedure.query((): 'dark' | 'light' => 'dark'),

  getThemeSource: publicProcedure.query((): 'system' | 'light' | 'dark' => 'system'),

  setTheme: publicProcedure
    .input(themeInput)
    .mutation(({ input }): 'dark' | 'light' => (input === 'light' ? 'light' : 'dark')),

  onThemeChanged: publicProcedure.subscription(() =>
    observable<'dark' | 'light'>(() => () => undefined)
  )
})

export type SettingsRouter = typeof settingsRouter
export type SettingsMounts = { settings: SettingsRouter }

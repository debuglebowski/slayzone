// The `usageAnalytics` router. `@slayzone/api` mounts it at `usageAnalytics`.
import { z } from 'zod'
import { router, publicProcedure, type TrpcContext } from '@slayzone/trpc-server'
import { refreshUsageData, queryAnalytics, queryTaskCost } from './cache'
import { getUsageAnalyticsRouterDeps } from './router-deps'

// real validation, mirrors DateRange = '7d'|'30d'|'90d'|'all' (usage-analytics/shared/types.ts)
const dateRangeInput = z.enum(['7d', '30d', '90d', 'all'])

/** On a hub with login, only the caller's projects' records are summed (T-17). */
const scopeOf = async (ctx: TrpcContext) => {
  const projectIds = await getUsageAnalyticsRouterDeps().ownedProjectIds(ctx)
  return projectIds ? { projectIds } : null
}

export const usageAnalyticsRouter = router({
  query: publicProcedure
    .input(dateRangeInput)
    .query(async ({ ctx, input }) => queryAnalytics(ctx.db, input, await scopeOf(ctx))),

  refresh: publicProcedure.input(dateRangeInput).mutation(async ({ ctx, input }) => {
    try {
      await refreshUsageData(ctx.db)
    } catch (err) {
      console.error('[usage-analytics] refresh failed:', err)
    }
    return queryAnalytics(ctx.db, input, await scopeOf(ctx))
  }),

  taskCost: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .query(({ ctx, input }) => queryTaskCost(ctx.db, input.taskId))
})

export type UsageAnalyticsRouter = typeof usageAnalyticsRouter
/** Where `@slayzone/api` mounts it: `usageAnalytics`. */
export type UsageAnalyticsMounts = { usageAnalytics: UsageAnalyticsRouter }

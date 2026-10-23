import { z } from 'zod'
import { refreshUsageData, queryAnalytics, queryTaskCost } from '@slayzone/usage-analytics/server'
import { router, publicProcedure } from '../trpc'
import type { TrpcContext } from '../context'
import { ownedProjectIds } from '../owner-gate'

// real validation, mirrors DateRange = '7d'|'30d'|'90d'|'all' (usage-analytics/shared/types.ts)
const dateRangeInput = z.enum(['7d', '30d', '90d', 'all'])

/** On a hub with login, only the caller's projects' records are summed (T-17). */
const scopeOf = async (ctx: TrpcContext) => {
  const projectIds = await ownedProjectIds(ctx)
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

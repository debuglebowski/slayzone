import { z } from 'zod'
import { refreshUsageData, queryAnalytics, queryTaskCost } from '@slayzone/usage-analytics/main'
import { router, publicProcedure } from '../trpc'

// real validation, mirrors DateRange = '7d'|'30d'|'90d'|'all' (usage-analytics/shared/types.ts)
const dateRangeInput = z.enum(['7d', '30d', '90d', 'all'])

export const usageAnalyticsRouter = router({
  query: publicProcedure
    .input(dateRangeInput)
    .query(({ ctx, input }) => queryAnalytics(ctx.db, input)),

  refresh: publicProcedure
    .input(dateRangeInput)
    .mutation(async ({ ctx, input }) => {
      try {
        await refreshUsageData(ctx.db)
      } catch (err) {
        console.error('[usage-analytics] refresh failed:', err)
      }
      return queryAnalytics(ctx.db, input)
    }),

  taskCost: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .query(({ ctx, input }) => queryTaskCost(ctx.db, input.taskId))
})

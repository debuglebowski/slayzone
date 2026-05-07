import { z } from 'zod'
import { refreshUsageData, queryAnalytics, queryTaskCost } from '@slayzone/usage-analytics/server'
import type { DateRange } from '@slayzone/usage-analytics/shared'
import { router, publicProcedure } from '../trpc'

const dateRangeInput = z.unknown() as unknown as z.ZodType<DateRange>

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
    .query(({ ctx, input }) => queryTaskCost(ctx.db, input.taskId)),
})

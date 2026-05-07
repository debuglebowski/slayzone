import { z } from 'zod'
import { listActivityEventsForTask, listAutomationActionRuns } from '@slayzone/history/server'
import type { ListTaskHistoryOptions } from '@slayzone/history/shared'
import { router, publicProcedure } from '../trpc'

const listOptionsInput = z.object({
  taskId: z.string(),
  options: z.unknown().optional() as unknown as z.ZodOptional<z.ZodType<ListTaskHistoryOptions>>,
})

export const historyRouter = router({
  listForTask: publicProcedure
    .input(listOptionsInput)
    .query(({ ctx, input }) => listActivityEventsForTask(ctx.db, input.taskId, input.options)),

  getAutomationActionRuns: publicProcedure
    .input(z.object({ runId: z.string() }))
    .query(({ ctx, input }) => listAutomationActionRuns(ctx.db, input.runId)),
})

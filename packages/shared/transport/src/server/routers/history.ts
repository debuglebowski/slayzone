import { z } from 'zod'
import { listActivityEventsForTask, listAutomationActionRuns } from '@slayzone/history/main'
import { router, publicProcedure } from '../trpc'

const cursorInput = z.object({ createdAt: z.string(), id: z.string() })

const listForTaskInput = z.object({
  taskId: z.string(),
  options: z
    .object({
      limit: z.number().optional(),
      before: cursorInput.nullish()
    })
    .optional()
})

export const historyRouter = router({
  listForTask: publicProcedure
    .input(listForTaskInput)
    .query(({ ctx, input }) => listActivityEventsForTask(ctx.db, input.taskId, input.options)),

  getAutomationActionRuns: publicProcedure
    .input(z.object({ runId: z.string() }))
    .query(({ ctx, input }) => listAutomationActionRuns(ctx.db, input.runId))
})

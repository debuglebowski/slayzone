import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { agentPromptsEvents, listPromptsForTask } from '@slayzone/agent-turns/server'
import { router, publicProcedure } from '../trpc'

export const agentPromptsRouter = router({
  /**
   * All prompts the user sent to a task's agent of `agentId` (the main agent's
   * current mode), oldest first. Returns [] when never used.
   */
  list: publicProcedure
    .input(z.object({ taskId: z.string(), agentId: z.string() }))
    .query(({ ctx, input }) => listPromptsForTask(ctx.db, input.taskId, input.agentId)),

  /**
   * Fires whenever a prompt is captured for any task. Emits the task id so each
   * subscriber refetches only when its own task changes. Mirrors the
   * `agentTurns.onChanged` pattern.
   */
  onChanged: publicProcedure.subscription(() =>
    observable<string>((emit) => {
      const handler = (taskId: string): void => {
        emit.next(taskId)
      }
      agentPromptsEvents.on('agent-prompts:changed', handler)
      return () => {
        agentPromptsEvents.off('agent-prompts:changed', handler)
      }
    })
  )
})

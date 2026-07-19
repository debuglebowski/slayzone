import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { listTaskSessions, agentSessionsEvents } from '@slayzone/task/server'
import { router, publicProcedure } from '../trpc'

export const agentSessionsRouter = router({
  /**
   * Every agent session tied to a task's agent of `agentId` (the main agent's
   * current mode), newest first. One entry per distinct provider conversation —
   * `--resume` re-spawns collapse into a single session. Returns [] when the
   * task has never run that agent.
   */
  list: publicProcedure
    .input(z.object({ taskId: z.string(), agentId: z.string() }))
    .query(({ ctx, input }) => listTaskSessions(ctx.db, input.taskId, input.agentId)),

  /**
   * Fires whenever a task's session set changes (spawn / confirm / bind /
   * reset). Emits the task id so each subscriber refetches only when its own
   * task changes. Mirrors the `agentPrompts.onChanged` pattern.
   */
  onChanged: publicProcedure.subscription(() =>
    observable<string>((emit) => {
      const handler = (payload: { taskId: string }): void => {
        emit.next(payload.taskId)
      }
      agentSessionsEvents.on('agent-sessions:changed', handler)
      return () => {
        agentSessionsEvents.off('agent-sessions:changed', handler)
      }
    })
  )
})

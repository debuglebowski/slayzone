import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { agentTurnsEvents, listAgentTurnsForWorktree } from '@slayzone/agent-turns/server'
import { router, publicProcedure } from '../trpc'

export const agentTurnsRouter = router({
  list: publicProcedure
    .input(z.object({ worktreePath: z.string() }))
    .query(({ ctx, input }) => listAgentTurnsForWorktree(ctx.db, input.worktreePath)),

  /**
   * Fires whenever a turn boundary is recorded for any worktree. Emits the
   * worktree path so subscribers can refetch their own list. Replaces the
   * `agent-turns:changed` IPC broadcast.
   */
  onChanged: publicProcedure.subscription(() =>
    observable<string>((emit) => {
      const handler = (worktreePath: string): void => {
        emit.next(worktreePath)
      }
      agentTurnsEvents.on('agent-turns:changed', handler)
      return () => {
        agentTurnsEvents.off('agent-turns:changed', handler)
      }
    }),
  ),
})

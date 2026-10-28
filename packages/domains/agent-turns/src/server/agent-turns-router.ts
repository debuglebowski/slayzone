import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { agentTurnsEvents } from './events'
import { listAgentTurnsForWorktree } from './list-turns'
import { router, publicProcedure } from '@slayzone/trpc-server'
import type { AgentPromptsRouter } from './agent-prompts-router'

export const agentTurnsRouter = router({
  list: publicProcedure
    .input(z.object({ worktreePath: z.string() }))
    .query(({ ctx, input }) => listAgentTurnsForWorktree(ctx.db, input.worktreePath)),

  /**
   * Fires whenever a turn boundary is recorded for any worktree. Emits the
   * worktree path so each subscriber refetches its own list. First streaming
   * subscription in the IPC→tRPC migration; mirrors (and in slice 5 replaces)
   * the `agent-turns:changed` IPC broadcast.
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
    })
  )
})

export type AgentTurnsRouter = typeof agentTurnsRouter

/**
 * Where this domain's routers sit in the app router. `@slayzone/api` mounts
 * `agentTurnsRouter` at `agentTurns` and `agentPromptsRouter` at `agentPrompts` (and
 * asserts the slice in its `router.ts`); the domain's client is typed against exactly
 * this (`client/trpc.ts`).
 */
export type AgentTurnsMounts = { agentTurns: AgentTurnsRouter; agentPrompts: AgentPromptsRouter }

import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { agentPromptsEvents } from './events'
import { onComputer } from './history-offline'
import { router, publicProcedure } from '@slayzone/trpc-server'
import type { SlayzoneDb } from '@slayzone/platform'
import type { AgentPrompt } from '../shared/types'

/**
 * Where a task's prompts are read: the computer holding them (robustness plan §9,
 * P0; the hub keeps none since v207). The hub's composition installs it; it throws
 * `AgentHistoryOfflineError` while that computer is offline.
 */
export type AgentPromptReader = (
  db: SlayzoneDb,
  taskId: string,
  agentId?: string
) => Promise<AgentPrompt[]>

let promptReader: AgentPromptReader | null = null
export function setAgentPromptReader(reader: AgentPromptReader | null): void {
  promptReader = reader
}

export const agentPromptsRouter = router({
  /**
   * All prompts the user sent to a task's agent of `agentId` (the main agent's
   * current mode) — or, without `agentId`, to every agent of the task (terminal
   * + chat; the chat composer's prompt history). Oldest first; [] when never used.
   * PRECONDITION_FAILED while the computer holding them is offline.
   */
  list: publicProcedure
    .input(z.object({ taskId: z.string(), agentId: z.string().optional() }))
    .query(({ ctx, input }) =>
      onComputer(() => {
        if (!promptReader) throw new Error('No prompt history is wired on this host')
        return promptReader(ctx.db, input.taskId, input.agentId)
      })
    ),

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

export type AgentPromptsRouter = typeof agentPromptsRouter
export type AgentPromptsMounts = { agentPrompts: AgentPromptsRouter }

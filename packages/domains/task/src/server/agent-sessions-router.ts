import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { observable } from '@trpc/server/observable'
import { listTaskSessions, SessionsOfflineError, taskSessionLedger } from './ops'
import { agentSessionsEvents } from './events'
import { router, publicProcedure } from '@slayzone/trpc-server'

/**
 * Sessions live on the computer running the task's agents (robustness plan §9, P0).
 * With it offline there is nothing to show: a precondition, named so (the sessions
 * list says "computer offline").
 */
async function onComputer<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof SessionsOfflineError)
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message, cause: error })
    throw error
  }
}

export const agentSessionsRouter = router({
  /**
   * Every agent session tied to a task's agent of `agentId` (the main agent's
   * current mode), newest first. One entry per distinct provider conversation —
   * `--resume` re-spawns collapse into a single session. Returns [] when the
   * task has never run that agent. Sessions of every tab are listed (each with
   * its `ownerTabId`); `isCurrent` is the asking `tabId`'s (default: main tab).
   */
  list: publicProcedure
    .input(z.object({ taskId: z.string(), agentId: z.string(), tabId: z.string().optional() }))
    .query(({ ctx, input }) =>
      onComputer(() =>
        listTaskSessions(ctx.db, input.taskId, input.agentId, input.tabId ?? input.taskId)
      )
    ),

  /**
   * The conversation tab `tabId` (default: the main tab) of `agentId` resumes next,
   * as the task's computer decides it; null when there is none. PRECONDITION_FAILED
   * while that computer is offline (the hub holds no copy): "cannot be asked" is
   * not "none" — the UI shows its no-session banners and records a detected id only
   * against a known answer (S8).
   */
  current: publicProcedure
    .input(z.object({ taskId: z.string(), agentId: z.string(), tabId: z.string().optional() }))
    .query(({ input }) =>
      onComputer(async () => {
        const ledger = taskSessionLedger()
        const computerId = await ledger.forTask(input.taskId)
        if (!computerId) throw new SessionsOfflineError()
        return ledger.store.getCurrentConversationId(
          computerId,
          input.taskId,
          input.agentId,
          input.tabId
        )
      })
    ),

  /**
   * Test-only (PLAYWRIGHT): one raw operation on the task's computer's session
   * ledger — e2e specs build and read session state where it lives (§9).
   */
  testLedger: publicProcedure
    .input(
      z.object({ taskId: z.string(), op: z.string(), args: z.record(z.string(), z.unknown()) })
    )
    .mutation(async ({ input }) => {
      if (process.env.PLAYWRIGHT !== '1') throw new Error('test-only handler unavailable')
      const ledger = taskSessionLedger()
      const computerId = await ledger.forTask(input.taskId)
      if (!computerId) throw new SessionsOfflineError()
      return ledger.call<unknown>(computerId, input.op, input.args)
    }),

  /**
   * A session id the renderer discovered from the main agent's own output (`/status`
   * for providers without a SessionStart hook): it becomes the main tab's current
   * session, on the task's computer.
   */
  recordDetected: publicProcedure
    .input(z.object({ taskId: z.string(), agentId: z.string(), conversationId: z.string().min(1) }))
    .mutation(({ input }) =>
      onComputer(async () => {
        const ledger = taskSessionLedger()
        const computerId = await ledger.forTask(input.taskId)
        if (!computerId) throw new SessionsOfflineError()
        await ledger.store.recordConversation(computerId, {
          taskId: input.taskId,
          mode: input.agentId,
          conversationId: input.conversationId,
          origin: 'slay-spawned-fresh'
        })
        agentSessionsEvents.emit('agent-sessions:changed', { taskId: input.taskId })
        return { ok: true as const }
      })
    ),

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

export type AgentSessionsRouter = typeof agentSessionsRouter

/**
 * Where this router sits in the app router. `@slayzone/api` mounts `agentSessionsRouter` at
 * `agentSessions` and asserts the slice in its `router.ts`.
 */
export type AgentSessionsMounts = { agentSessions: AgentSessionsRouter }

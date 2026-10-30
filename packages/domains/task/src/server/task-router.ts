import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { TRPCError } from '@trpc/server'
import { taskEvents, type TaskEventMap } from './events'
import {
  recordPendingSpawn,
  recordConversation,
  switchConversation,
  isHonoredConversation,
  deleteSession
} from './ops'
import { InvalidTaskUpdateError, type OpDeps } from './ops/shared'
import { startMainAgent } from './main-agent'
import type { CreateTaskInput, UpdateTaskInput } from '@slayzone/task-contracts'
import { router, publicProcedure } from '@slayzone/trpc-server'
import { releaseChatConversation } from '@slayzone/terminal/server'
import {
  getTaskBus,
  getTaskOps,
  getTaskOnMutation,
  getTaskReserveWarmTaskId
} from './task-router-deps'

// Mirrors the 16 `db:tasks:*` + 6 `db:taskDependencies:*` + `db:loadBoardData` IPC
// handlers (task/src/main/handlers.ts) plus the `taskEvents` broadcast. The ops are
// electron-coupled (createTaskOp → worktrees → electron), so the Electron-main host
// injects them via `setTaskDeps()`; both the live IPC handlers and these procedures
// call the same instances (coexistence until slice 5). create/update pass their
// shapes through unchecked — the still-live IPC path validates by TypeScript only.
const createInput = z.unknown() as unknown as z.ZodType<CreateTaskInput>
const updateInput = z.unknown() as unknown as z.ZodType<UpdateTaskInput>

const ops = (): ReturnType<typeof getTaskOps> => getTaskOps()

// Per-call OpDeps for the mutating procedures, all injected by the host via
// `setTaskDeps`:
//   - `ipcMain`: the hub's task bus, so the `db:tasks:*:done` events reach their
//     listeners (integration push) for the renderer's mutations as they do for
//     REST and MCP;
//   - `onMutation` (notifyTasksChanged): the `notify.onTasksChanged` renderer
//     refresh. A given renderer call uses one transport (tRPC OR IPC), so each fires
//     exactly once per mutation;
//   - the warm pool's reserve, for `create` (the renderer is the only caller that
//     opens what it creates).
const deps = (): Pick<OpDeps, 'ipcMain' | 'onMutation' | 'reserveWarmTaskId'> => ({
  ipcMain: getTaskBus(),
  onMutation: getTaskOnMutation(),
  reserveWarmTaskId: getTaskReserveWarmTaskId()
})

// An update that breaks a task invariant (unknown status, bad priority) is the
// caller's fault — surface it as BAD_REQUEST, not INTERNAL_SERVER_ERROR.
const asBadRequest = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run()
  } catch (err) {
    if (err instanceof InvalidTaskUpdateError) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err })
    }
    throw err
  }
}

export const taskRouter = router({
  // --- Task CRUD ---
  getAll: publicProcedure.query(({ ctx }) => ops().getAllTasksOp(ctx.db)),

  getByProject: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ ctx, input }) => ops().getByProjectOp(ctx.db, input.projectId)),

  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => ops().getTaskOp(ctx.db, input.id)),

  // Test-only: seed the `pending-spawn` provenance row slay normally writes when
  // it launches an agent (pty-manager.recordPendingSpawn). Specs that fire an
  // agent-hook directly (without spawning a real PTY) need this so the hook's
  // session id is honored (slay-spawned) rather than rejected as foreign-observed
  // — the latter intentionally skips the legacy provider_config dual-write
  // (RC1 clobber guard). PLAYWRIGHT-gated, mirrors menu.testEmit.
  testRecordPendingSpawn: publicProcedure
    .input(
      z.object({
        taskId: z.string(),
        mode: z.string(),
        expectedSessionId: z.string().nullable(),
        usedResume: z.boolean().optional()
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (process.env.PLAYWRIGHT !== '1') throw new Error('test-only handler unavailable')
      await recordPendingSpawn(ctx.db, {
        taskId: input.taskId,
        mode: input.mode,
        expectedSessionId: input.expectedSessionId,
        usedResume: input.usedResume ?? false
      })
      return { ok: true }
    }),

  create: publicProcedure.input(createInput).mutation(async ({ ctx, input }) => {
    let r
    try {
      r = await ops().createTaskOp(ctx.db, input, deps())
    } catch (e) {
      // A project lives in exactly ONE hub's DB, so a create routed to the wrong
      // hub is a missing project, not a server fault. Surfaced by `code` (see
      // PROJECT_NOT_FOUND in task/server/ops/create.ts) — matching on it here
      // keeps this router free of that electron-coupled import.
      if ((e as { code?: string })?.code === 'PROJECT_NOT_FOUND') {
        throw new TRPCError({ code: 'NOT_FOUND', message: (e as Error).message })
      }
      throw e
    }
    if (!r)
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'createTaskOp returned null' })
    return r
  }),

  getSubTasks: publicProcedure
    .input(z.object({ parentId: z.string() }))
    .query(({ ctx, input }) => ops().getSubTasksOp(ctx.db, input.parentId)),

  update: publicProcedure.input(updateInput).mutation(async ({ ctx, input }) => {
    const r = await asBadRequest(() => ops().updateTaskOp(ctx.db, input, deps()))
    if (!r) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' })
    return r
  }),

  // "Start fresh" / reset conversation. Appends a `manual-reset` sentinel to the
  // append-only ledger, which (a) writes a `session_resets` cutoff so the
  // authoritative `currentConversationByMode` / resolver read returns NULL, and
  // (b) clears the legacy `provider_config.{mode}.conversationId` + column. The
  // old renderer path only nulled provider_config, which the ledger-backed read
  // ignored — so a phantom/stale conversation id survived "Start fresh" and came
  // back on reopen. Routing through `recordConversation('manual-reset')` is the
  // one write that actually clears the honored binding. Returns the refreshed task.
  resetConversation: publicProcedure
    .input(z.object({ id: z.string(), mode: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ops().getTaskOp(ctx.db, input.id)
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' })
      await recordConversation(ctx.db, {
        taskId: input.id,
        mode: input.mode,
        conversationId: null,
        origin: 'manual-reset'
      })
      getTaskOnMutation()?.()
      const r = await ops().getTaskOp(ctx.db, input.id)
      if (!r) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' })
      return r
    }),

  // Switch the task's agent back to an EARLIER session (sessions sidebar).
  // Appends a `user-selected` row to the append-only ledger, which becomes the
  // newest honored row → `currentConversationByMode` → the renderer's
  // `existingConversationId` → `--resume <picked>` on the next spawn. Durable by
  // construction: it survives a reopen even if the respawn never confirms (a
  // provider without hooks never does). The caller restarts the terminal after
  // this returns. `isHonoredConversation` is the anti-laundering guard — only a
  // conversation this task+mode already owns can be selected. Returns the
  // refreshed task.
  switchConversation: publicProcedure
    .input(
      z.object({
        id: z.string(),
        mode: z.string(),
        conversationId: z.string(),
        // The mode that ran it. The chat ↔ terminal partner: the conversation
        // moves over (a hand-off, chat A); absent = `mode` itself.
        sourceMode: z.string().optional()
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ops().getTaskOp(ctx.db, input.id)
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' })
      const outcome = await switchConversation(
        ctx.db,
        {
          taskId: input.id,
          mode: input.mode,
          conversationId: input.conversationId,
          ...(input.sourceMode ? { sourceMode: input.sourceMode } : {})
        },
        // Never two processes on one conversation: a chat still running it stops
        // (and has exited) before the terminal resumes it.
        { release: releaseChatConversation }
      )
      if (outcome !== 'switched') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            outcome === 'not-partner'
              ? `A ${input.sourceMode} session cannot move to ${input.mode}`
              : 'Not a session of this task'
        })
      }
      getTaskOnMutation()?.()
      const r = await ops().getTaskOp(ctx.db, input.id)
      if (!r) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' })
      return r
    }),

  // Delete a session from the task (sessions sidebar). Writes a
  // `session_deletions` tombstone — never a `DELETE FROM` — so the provenance
  // history stays intact while every reader (sidebar list, message history,
  // resume decision) excludes it in SQL. The provider's own transcript on disk is
  // untouched; slay didn't write it. Refuses the CURRENT session: a live agent is
  // running on it, so hiding it would leave the terminal bound to a session the
  // UI says is gone. Returns the refreshed task.
  deleteConversation: publicProcedure
    .input(z.object({ id: z.string(), mode: z.string(), conversationId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ops().getTaskOp(ctx.db, input.id)
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' })
      if (!(await isHonoredConversation(ctx.db, input.id, input.mode, input.conversationId))) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Not a session of this task'
        })
      }
      if (!(await deleteSession(ctx.db, input.id, input.mode, input.conversationId))) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Switch to another session before deleting the current one'
        })
      }
      getTaskOnMutation()?.()
      const r = await ops().getTaskOp(ctx.db, input.id)
      if (!r) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' })
      return r
    }),

  updateMany: publicProcedure
    .input(z.unknown())
    .mutation(({ ctx, input }) =>
      asBadRequest(() => ops().updateManyTasksOp(ctx.db, input as never, deps()))
    ),

  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => ops().deleteTaskOp(ctx.db, input.id, deps())),

  deleteMany: publicProcedure
    .input(z.object({ ids: z.array(z.string()) }))
    .mutation(({ ctx, input }) => ops().deleteManyTasksOp(ctx.db, input.ids, deps())),

  restore: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const r = await ops().restoreTaskOp(ctx.db, input.id, deps())
    if (!r) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' })
    return r
  }),

  archive: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const r = await ops().archiveTaskOp(ctx.db, input.id, deps())
    if (!r) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' })
    return r
  }),

  archiveMany: publicProcedure
    .input(z.object({ ids: z.array(z.string()) }))
    .mutation(({ ctx, input }) => ops().archiveManyTasksOp(ctx.db, input.ids, deps())),

  unarchive: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const r = await ops().unarchiveTaskOp(ctx.db, input.id, deps())
      if (!r) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' })
      return r
    }),

  // Order and blocker writes name the rows they moved / (un)blocked, so every other
  // client patches them live (`notify.onTasksChanged`).
  reorder: publicProcedure
    .input(z.object({ taskIds: z.array(z.string()) }))
    .mutation(({ ctx, input }) => ops().reorderTasksOp(ctx.db, input.taskIds, deps())),

  reorderPinned: publicProcedure
    .input(z.object({ taskIds: z.array(z.string()) }))
    .mutation(({ ctx, input }) => ops().reorderPinnedTasksOp(ctx.db, input.taskIds, deps())),

  setBrowserTabLocked: publicProcedure
    .input(z.object({ taskId: z.string(), tabId: z.string(), locked: z.boolean() }))
    .mutation(({ ctx, input }) =>
      ops().setBrowserTabLockedOp(ctx.db, input.taskId, input.tabId, input.locked, deps())
    ),

  // Start the task's main agent on the hub: spawn props, cwd (repo discovery on the
  // task's computer), resume conversation and execution context resolved from what
  // the hub stores, the same way the desktop resolves them. Starts only when no
  // session is live; a concurrent call joins the start in flight. See ./main-agent.ts.
  startMainAgent: publicProcedure
    .input(
      z.object({
        taskId: z.string(),
        cols: z.number().int().positive().optional(),
        rows: z.number().int().positive().optional()
      })
    )
    .mutation(({ ctx, input }) =>
      startMainAgent(ctx.db, input, (id) => ops().getTaskOp(ctx.db, id))
    ),

  // --- Dependencies ---
  getBlockers: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .query(({ ctx, input }) => ops().getBlockersOp(ctx.db, input.taskId)),

  getAllBlockedTaskIds: publicProcedure.query(({ ctx }) => ops().getAllBlockedTaskIdsOp(ctx.db)),

  getBlocking: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .query(({ ctx, input }) => ops().getBlockingOp(ctx.db, input.taskId)),

  addBlocker: publicProcedure
    .input(z.object({ taskId: z.string(), blockerTaskId: z.string() }))
    .mutation(({ ctx, input }) =>
      ops().addBlockerOp(ctx.db, input.taskId, input.blockerTaskId, deps())
    ),

  removeBlocker: publicProcedure
    .input(z.object({ taskId: z.string(), blockerTaskId: z.string() }))
    .mutation(({ ctx, input }) =>
      ops().removeBlockerOp(ctx.db, input.taskId, input.blockerTaskId, deps())
    ),

  setBlockers: publicProcedure
    .input(z.object({ taskId: z.string(), blockerTaskIds: z.array(z.string()) }))
    .mutation(({ ctx, input }) =>
      ops().setBlockersOp(ctx.db, input.taskId, input.blockerTaskIds, deps())
    ),

  // --- Board ---
  loadBoardData: publicProcedure.query(({ ctx }) => ops().loadBoardDataOp(ctx.db)),
  // A few rows of the board — what the renderer patches in when a
  // `notify.onTasksChanged` event names the changed tasks. Capped: an event
  // naming more rows than this is cheaper as a full board reload.
  loadBoardRows: publicProcedure
    .input(z.object({ ids: z.array(z.string()).max(500) }))
    .query(({ ctx, input }) => ops().loadBoardRowsOp(ctx.db, input.ids)),

  // --- Subscription ---
  // Fires on any task mutation. Replaces the renderer's `tasks:changed` polling once
  // it cuts over (slice 5). Subscribers refetch. Emits the changed task's ids (it
  // emitted nothing before; no client reads the value) so the owner gate can send
  // each user only their own projects' changes (T-17).
  onChanged: publicProcedure.subscription(() =>
    observable<{ taskId: string; projectId: string }>((emit) => {
      const handler = (e: { taskId: string; projectId: string }): void =>
        emit.next({ taskId: e.taskId, projectId: e.projectId })
      const events: (keyof TaskEventMap)[] = [
        'task:created',
        'task:archived',
        'task:unarchived',
        'task:updated',
        'task:deleted',
        'task:restored',
        'task:tag-changed'
      ]
      for (const e of events) taskEvents.on(e, handler)
      return () => {
        for (const e of events) taskEvents.off(e, handler)
      }
    })
  )
})

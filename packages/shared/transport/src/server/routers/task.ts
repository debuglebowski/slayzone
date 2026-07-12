import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import { TRPCError } from '@trpc/server'
import {
  taskEvents,
  recordPendingSpawn,
  recordConversation,
  type TaskEventMap
} from '@slayzone/task/server'
import type { CreateTaskInput, UpdateTaskInput } from '@slayzone/task/shared'
import { router, publicProcedure } from '../trpc'
import { getTaskOps, getTaskOnMutation } from '../app-deps'

// Mirrors the 16 `db:tasks:*` + 6 `db:taskDependencies:*` + `db:loadBoardData` IPC
// handlers (task/src/main/handlers.ts) plus the `taskEvents` broadcast. The ops are
// electron-coupled (createTaskOp → worktrees → electron), so the Electron-main host
// injects them via `setTaskDeps()`; both the live IPC handlers and these procedures
// call the same instances (coexistence until slice 5). create/update pass their
// shapes through unchecked — the still-live IPC path validates by TypeScript only.
const createInput = z.unknown() as unknown as z.ZodType<CreateTaskInput>
const updateInput = z.unknown() as unknown as z.ZodType<UpdateTaskInput>

const ops = (): ReturnType<typeof getTaskOps> => getTaskOps()

// Per-call OpDeps for the mutating procedures. No in-process IPC `:done` bus (ops
// guard `ipcMain?.emit(...)`), but the host injects `onMutation` (notifyTasksChanged)
// via `setTaskDeps`, so every tRPC mutation fires the same `notify.onTasksChanged`
// renderer-refresh signal the legacy IPC handlers emit. A given renderer call uses
// one transport (tRPC OR IPC), so this fires exactly once per mutation.
const deps = (): { onMutation?: () => void } => ({ onMutation: getTaskOnMutation() })

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
    const r = await ops().createTaskOp(ctx.db, input, deps())
    if (!r) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'createTaskOp returned null' })
    return r
  }),

  getSubTasks: publicProcedure
    .input(z.object({ parentId: z.string() }))
    .query(({ ctx, input }) => ops().getSubTasksOp(ctx.db, input.parentId)),

  update: publicProcedure.input(updateInput).mutation(async ({ ctx, input }) => {
    const r = await ops().updateTaskOp(ctx.db, input, deps())
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

  updateMany: publicProcedure
    .input(z.unknown())
    .mutation(({ ctx, input }) => ops().updateManyTasksOp(ctx.db, input as never, deps())),

  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => ops().deleteTaskOp(ctx.db, input.id, deps())),

  deleteMany: publicProcedure
    .input(z.object({ ids: z.array(z.string()) }))
    .mutation(({ ctx, input }) => ops().deleteManyTasksOp(ctx.db, input.ids, deps())),

  restore: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const r = await ops().restoreTaskOp(ctx.db, input.id, deps())
      if (!r) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' })
      return r
    }),

  archive: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
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

  reorder: publicProcedure
    .input(z.object({ taskIds: z.array(z.string()) }))
    .mutation(({ ctx, input }) => ops().reorderTasksOp(ctx.db, input.taskIds)),

  reorderPinned: publicProcedure
    .input(z.object({ taskIds: z.array(z.string()) }))
    .mutation(({ ctx, input }) => ops().reorderPinnedTasksOp(ctx.db, input.taskIds)),

  setBrowserTabLocked: publicProcedure
    .input(z.object({ taskId: z.string(), tabId: z.string(), locked: z.boolean() }))
    .mutation(({ ctx, input }) =>
      ops().setBrowserTabLockedOp(ctx.db, input.taskId, input.tabId, input.locked, deps())
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
    .mutation(({ ctx, input }) => ops().addBlockerOp(ctx.db, input.taskId, input.blockerTaskId)),

  removeBlocker: publicProcedure
    .input(z.object({ taskId: z.string(), blockerTaskId: z.string() }))
    .mutation(({ ctx, input }) => ops().removeBlockerOp(ctx.db, input.taskId, input.blockerTaskId)),

  setBlockers: publicProcedure
    .input(z.object({ taskId: z.string(), blockerTaskIds: z.array(z.string()) }))
    .mutation(({ ctx, input }) => ops().setBlockersOp(ctx.db, input.taskId, input.blockerTaskIds)),

  // --- Board ---
  loadBoardData: publicProcedure.query(({ ctx }) => ops().loadBoardDataOp(ctx.db)),

  // --- Subscription ---
  // Fires on any task mutation. Replaces the renderer's `tasks:changed` polling once
  // it cuts over (slice 5). Emits `void` — subscribers refetch.
  onChanged: publicProcedure.subscription(() =>
    observable<void>((emit) => {
      const handler = (): void => emit.next()
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

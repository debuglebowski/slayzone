import { TRPCError } from '@trpc/server'
import { router, publicProcedure } from '@slayzone/trpc-server'
import {
  addRemoteBlockersInputSchema,
  crossHubMovePreviewInputSchema,
  advanceTaskMoveInputSchema,
  removeRemoteBlockerInputSchema,
  remoteBlockersInputSchema,
  beginTaskMoveInputSchema,
  exportTaskMoveInputSchema,
  importTaskMoveInputSchema,
  failTaskMoveInputSchema,
  listTaskMovesInputSchema,
  reportTaskMoveProgressInputSchema,
  taskMoveIdInputSchema,
  taskMoveRedirectsInputSchema,
  sessionsActivateInputSchema,
  sessionsBeginInputSchema,
  sessionsChunkInputSchema,
  sessionsDiscardInputSchema,
  sessionsExportInputSchema,
  sessionsFileReadInputSchema,
  sessionsFileWriteInputSchema,
  sessionsFilesInputSchema,
  sessionsFilesMissingInputSchema,
  sessionsFinishInputSchema,
  sessionsImportLedgerInputSchema,
  sessionsPutAttachmentInputSchema,
  sessionsReadAttachmentInputSchema,
  sessionsReadInputSchema,
  sessionsRegisterInputSchema
} from '@slayzone/task-contracts'
import {
  abortTaskMoveIn,
  addRemoteBlockers,
  listRemoteBlockers,
  previewCrossHubMove,
  removeRemoteBlocker,
  advanceTaskMove,
  beginTaskMove,
  commitTaskMoveIn,
  exportTaskMove,
  importTaskMove,
  cancelTaskMove,
  failTaskMove,
  getTaskMove,
  listTaskMoves,
  pauseTaskMove,
  releaseTaskMove,
  reportTaskMoveProgress,
  resumeTaskMove,
  skipTaskMoveSessions,
  taskMoveRedirects,
  TaskAlreadyMovingError,
  TaskMoveNotFoundError,
  TaskMoveRefusedError,
  TaskMoveStateError
} from './ops/task-moves'
import { getTaskOnMutation } from './task-router-deps'
import { registerMovedChats, taskMoveSessions } from './ops/task-move-sessions'
import { getTaskMove as moveOf } from './ops/task-moves'

/**
 * A move step that changes what boards show (a task locked or unlocked, arriving,
 * shown, gone): every client reloads its board. Names no rows — the set changed.
 */
async function boardChanged<T>(run: () => Promise<T>): Promise<T> {
  const result = await run()
  getTaskOnMutation()?.()
  return result
}

/** Each move error as the tRPC code a client can act on. */
async function mapped<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    const code =
      err instanceof TaskMoveNotFoundError
        ? 'NOT_FOUND'
        : err instanceof TaskMoveStateError
          ? 'PRECONDITION_FAILED'
          : err instanceof TaskAlreadyMovingError
            ? 'CONFLICT'
            : err instanceof TaskMoveRefusedError
              ? 'BAD_REQUEST'
              : null
    if (code) throw new TRPCError({ code, message: (err as Error).message, cause: err })
    throw err
  }
}

/**
 * Moving tasks to another hub — this hub's journal of the moves its tasks make
 * (ops/task-moves.ts). The app runs the steps and records each one here.
 */
export const taskMovesRouter = router({
  begin: publicProcedure
    .input(beginTaskMoveInputSchema)
    .mutation(({ ctx, input }) =>
      boardChanged(() =>
        mapped(() => beginTaskMove(ctx.db, input, { createdBy: ctx.principal?.userId ?? null }))
      )
    ),

  /** What a move of these tasks to another hub would carry (the dialog). */
  preview: publicProcedure
    .input(crossHubMovePreviewInputSchema)
    .query(({ ctx, input }) => previewCrossHubMove(ctx.db, input.taskIds)),

  get: publicProcedure
    .input(taskMoveIdInputSchema)
    .query(({ ctx, input }) => mapped(() => getTaskMove(ctx.db, input.id))),

  list: publicProcedure
    .input(listTaskMovesInputSchema)
    .query(({ ctx, input }) => listTaskMoves(ctx.db, input)),

  advance: publicProcedure
    .input(advanceTaskMoveInputSchema)
    .mutation(({ ctx, input }) => mapped(() => advanceTaskMove(ctx.db, input))),

  progress: publicProcedure
    .input(reportTaskMoveProgressInputSchema)
    .mutation(({ ctx, input }) => mapped(() => reportTaskMoveProgress(ctx.db, input))),

  pause: publicProcedure
    .input(taskMoveIdInputSchema)
    .mutation(({ ctx, input }) =>
      boardChanged(() => mapped(() => pauseTaskMove(ctx.db, input.id)))
    ),

  skipSessions: publicProcedure
    .input(taskMoveIdInputSchema)
    .mutation(({ ctx, input }) =>
      boardChanged(() => mapped(() => skipTaskMoveSessions(ctx.db, input.id)))
    ),

  resume: publicProcedure
    .input(taskMoveIdInputSchema)
    .mutation(({ ctx, input }) =>
      boardChanged(() => mapped(() => resumeTaskMove(ctx.db, input.id)))
    ),

  fail: publicProcedure
    .input(failTaskMoveInputSchema)
    .mutation(({ ctx, input }) => boardChanged(() => mapped(() => failTaskMove(ctx.db, input)))),

  cancel: publicProcedure
    .input(taskMoveIdInputSchema)
    .mutation(({ ctx, input }) =>
      boardChanged(() => mapped(() => cancelTaskMove(ctx.db, input.id)))
    ),

  release: publicProcedure
    .input(taskMoveIdInputSchema)
    .mutation(({ ctx, input }) =>
      boardChanged(() => mapped(() => releaseTaskMove(ctx.db, input.id, ctx.dataRoot)))
    ),

  redirects: publicProcedure
    .input(taskMoveRedirectsInputSchema)
    .query(({ ctx, input }) => taskMoveRedirects(ctx.db, input.taskIds)),

  // ── the rows (slice 3b) ──
  /** Source: the bundle of the move's tasks (a read; safe to repeat). */
  export: publicProcedure
    .input(exportTaskMoveInputSchema)
    .query(({ ctx, input }) => mapped(() => exportTaskMove(ctx.db, input.id))),

  /** Target: take the bundle, hidden and locked until `commit`. Idempotent. */
  import: publicProcedure
    .input(importTaskMoveInputSchema)
    .mutation(({ ctx, input }) => boardChanged(() => mapped(() => importTaskMove(ctx.db, input)))),

  /** Target: the tasks are this hub's now. */
  commit: publicProcedure
    .input(taskMoveIdInputSchema)
    .mutation(({ ctx, input }) =>
      boardChanged(() => mapped(() => commitTaskMoveIn(ctx.db, input.id)))
    ),

  // ── blockers across hubs (slice 3d) ──
  /** Either hub: its side of blockers a move split (the `links` step). Idempotent. */
  addRemoteBlockers: publicProcedure
    .input(addRemoteBlockersInputSchema)
    .mutation(({ ctx, input }) => mapped(() => addRemoteBlockers(ctx.db, input))),
  /** A task's blockers on other hubs. */
  remoteBlockers: publicProcedure
    .input(remoteBlockersInputSchema)
    .query(({ ctx, input }) => listRemoteBlockers(ctx.db, input.taskId)),
  /** Remove this hub's side of one. */
  removeRemoteBlocker: publicProcedure
    .input(removeRemoteBlockerInputSchema)
    .mutation(({ ctx, input }) => removeRemoteBlocker(ctx.db, input)),

  /** Target: a canceled move — drop what was taken (before commit). */
  abort: publicProcedure
    .input(taskMoveIdInputSchema)
    .mutation(({ ctx, input }) =>
      boardChanged(() => mapped(() => abortTaskMoveIn(ctx.db, input.id)))
    ),

  // --- `copy-sessions`: a moved task's agent sessions, computer to computer through
  // the app (ops/task-move-sessions.ts). Source hub: export, read, readAttachment, discard.
  sessionsExport: publicProcedure
    .input(sessionsExportInputSchema)
    .mutation(({ input }) =>
      mapped(() => taskMoveSessions().exportTask(input.moveId, input.taskId))
    ),
  sessionsRead: publicProcedure
    .input(sessionsReadInputSchema)
    .query(({ input }) => mapped(() => taskMoveSessions().read(input))),
  sessionsReadAttachment: publicProcedure
    .input(sessionsReadAttachmentInputSchema)
    .query(({ input }) => mapped(() => taskMoveSessions().readAttachment(input))),
  sessionsDiscard: publicProcedure.input(sessionsDiscardInputSchema).mutation(({ ctx, input }) =>
    mapped(async () => {
      const move = await moveOf(ctx.db, input.moveId)
      await taskMoveSessions().discard(input.moveId, move.taskIds)
    })
  ),
  sessionsFiles: publicProcedure
    .input(sessionsFilesInputSchema)
    .query(({ input }) => mapped(() => taskMoveSessions().files(input.moveId, input.taskId))),
  sessionsFileRead: publicProcedure
    .input(sessionsFileReadInputSchema)
    .query(({ input }) => mapped(() => taskMoveSessions().readFile(input))),
  // Target hub: stage each chat on the task's computer, then take it as this hub's own.
  sessionsBegin: publicProcedure
    .input(sessionsBeginInputSchema)
    .mutation(({ input }) => mapped(() => taskMoveSessions().begin(input.taskId, input.manifest))),
  sessionsChunk: publicProcedure.input(sessionsChunkInputSchema).mutation(({ input }) =>
    mapped(async () => {
      await taskMoveSessions().chunk(input.taskId, input.transferId, input.offset, input.data)
    })
  ),
  sessionsFinish: publicProcedure
    .input(sessionsFinishInputSchema)
    .mutation(({ input }) =>
      mapped(() => taskMoveSessions().finish(input.taskId, input.transferId))
    ),
  sessionsPutAttachment: publicProcedure
    .input(sessionsPutAttachmentInputSchema)
    .mutation(({ input }) =>
      mapped(async () => {
        await taskMoveSessions().putAttachment(input)
      })
    ),
  sessionsActivate: publicProcedure.input(sessionsActivateInputSchema).mutation(({ input }) =>
    mapped(async () => {
      await taskMoveSessions().activate(input)
    })
  ),
  sessionsFilesMissing: publicProcedure
    .input(sessionsFilesMissingInputSchema)
    .mutation(({ input }) =>
      mapped(() => taskMoveSessions().missingFiles(input.taskId, input.entries))
    ),
  sessionsFileWrite: publicProcedure.input(sessionsFileWriteInputSchema).mutation(({ input }) =>
    mapped(async () => {
      await taskMoveSessions().writeFile(input)
    })
  ),
  sessionsImportLedger: publicProcedure
    .input(sessionsImportLedgerInputSchema)
    .mutation(({ input }) =>
      mapped(async () => {
        await taskMoveSessions().importLedger(input.taskId, input.ledger)
      })
    ),
  sessionsRegister: publicProcedure
    .input(sessionsRegisterInputSchema)
    .mutation(({ ctx, input }) =>
      mapped(() => registerMovedChats(ctx.db, { taskId: input.taskId, chats: input.chats }))
    )
})

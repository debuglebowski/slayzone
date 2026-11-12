import { TRPCError } from '@trpc/server'
import { router, publicProcedure } from '@slayzone/trpc-server'
import {
  advanceTaskMoveInputSchema,
  beginTaskMoveInputSchema,
  failTaskMoveInputSchema,
  listTaskMovesInputSchema,
  reportTaskMoveProgressInputSchema,
  taskMoveIdInputSchema,
  taskMoveRedirectsInputSchema
} from '@slayzone/task-contracts'
import {
  advanceTaskMove,
  beginTaskMove,
  cancelTaskMove,
  failTaskMove,
  getTaskMove,
  listTaskMoves,
  pauseTaskMove,
  releaseTaskMove,
  reportTaskMoveProgress,
  resumeTaskMove,
  taskMoveRedirects,
  TaskAlreadyMovingError,
  TaskMoveNotFoundError,
  TaskMoveRefusedError,
  TaskMoveStateError
} from './ops/task-moves'

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
      mapped(() => beginTaskMove(ctx.db, input, { createdBy: ctx.principal?.userId ?? null }))
    ),

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
    .mutation(({ ctx, input }) => mapped(() => pauseTaskMove(ctx.db, input.id))),

  resume: publicProcedure
    .input(taskMoveIdInputSchema)
    .mutation(({ ctx, input }) => mapped(() => resumeTaskMove(ctx.db, input.id))),

  fail: publicProcedure
    .input(failTaskMoveInputSchema)
    .mutation(({ ctx, input }) => mapped(() => failTaskMove(ctx.db, input))),

  cancel: publicProcedure
    .input(taskMoveIdInputSchema)
    .mutation(({ ctx, input }) => mapped(() => cancelTaskMove(ctx.db, input.id))),

  release: publicProcedure
    .input(taskMoveIdInputSchema)
    .mutation(({ ctx, input }) => mapped(() => releaseTaskMove(ctx.db, input.id))),

  redirects: publicProcedure
    .input(taskMoveRedirectsInputSchema)
    .query(({ ctx, input }) => taskMoveRedirects(ctx.db, input.taskIds))
})

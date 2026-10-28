// The `app.feedback` router: the same feedback CRUD as the top-level `feedback`
// router (`./feedback-router`), at its older `app.*` path with untyped inputs. Kept
// byte-for-byte as it was in api's `app` router: a client of another version may
// still call `app.feedback.*` (wire paths never move). `@slayzone/api` mounts it at
// `app.feedback`.
import { z } from 'zod'
import { router, publicProcedure } from '@slayzone/trpc-server'
import { buildFeedbackOps } from './feedback-store'

const anyInput = z.unknown()

// Feedback — plain CRUD over `feedback_threads`/`feedback_messages`, so it reads
// ctx.db. It was six AppDeps slots, i.e. this process asking the Electron host to
// query the database this process owns; the host and the standalone branch built
// the SAME `buildFeedbackOps(db)`, which is how you can tell the indirection was
// never load-bearing.
export const appFeedbackRouter = router({
  listThreads: publicProcedure.query(({ ctx }) => buildFeedbackOps(ctx.db).listThreads()),
  createThread: publicProcedure
    .input(anyInput)
    .mutation(({ ctx, input }) => buildFeedbackOps(ctx.db).createThread(input as never)),
  getMessages: publicProcedure
    .input(z.object({ threadId: z.string() }))
    .query(({ ctx, input }) => buildFeedbackOps(ctx.db).getMessages(input.threadId)),
  addMessage: publicProcedure
    .input(anyInput)
    .mutation(({ ctx, input }) => buildFeedbackOps(ctx.db).addMessage(input as never)),
  updateThreadDiscordId: publicProcedure
    .input(z.object({ threadId: z.string(), discordThreadId: z.string() }))
    .mutation(({ ctx, input }) =>
      buildFeedbackOps(ctx.db).updateThreadDiscordId(input.threadId, input.discordThreadId)
    ),
  deleteThread: publicProcedure
    .input(z.object({ threadId: z.string() }))
    .mutation(({ ctx, input }) => buildFeedbackOps(ctx.db).deleteThread(input.threadId))
})

export type AppFeedbackRouter = typeof appFeedbackRouter
/** Where `@slayzone/api` mounts it: `app.feedback`. */
export type AppFeedbackMounts = { app: { feedback: AppFeedbackRouter } }

import { z } from 'zod'
import { buildFeedbackOps } from '@slayzone/feedback/server'
import { router, publicProcedure } from '../trpc'

// Mirrors the `db:feedback:*` IPC handlers (feedback/src/electron/handlers.ts).
// Ops are electron-free (db-only), so build them straight off ctx.db — same
// pattern as the tags router. IPC + tRPC coexist until the renderer drops IPC.
const createThreadInput = z.object({
  id: z.string(),
  title: z.string(),
  discord_thread_id: z.string().nullable()
})

const addMessageInput = z.object({
  id: z.string(),
  thread_id: z.string(),
  content: z.string()
})

export const feedbackRouter = router({
  listThreads: publicProcedure.query(({ ctx }) => buildFeedbackOps(ctx.db).listThreads()),

  getMessages: publicProcedure
    .input(z.object({ threadId: z.string() }))
    .query(({ ctx, input }) => buildFeedbackOps(ctx.db).getMessages(input.threadId)),

  createThread: publicProcedure
    .input(createThreadInput)
    .mutation(({ ctx, input }) => buildFeedbackOps(ctx.db).createThread(input)),

  addMessage: publicProcedure
    .input(addMessageInput)
    .mutation(({ ctx, input }) => buildFeedbackOps(ctx.db).addMessage(input)),

  updateThreadDiscordId: publicProcedure
    .input(z.object({ threadId: z.string(), discordThreadId: z.string() }))
    .mutation(({ ctx, input }) =>
      buildFeedbackOps(ctx.db).updateThreadDiscordId(input.threadId, input.discordThreadId)
    ),

  deleteThread: publicProcedure
    .input(z.object({ threadId: z.string() }))
    .mutation(({ ctx, input }) => buildFeedbackOps(ctx.db).deleteThread(input.threadId))
})

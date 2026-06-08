import type { SlayzoneDb } from '@slayzone/platform'
import type {
  AddFeedbackMessageInput,
  CreateFeedbackThreadInput,
  FeedbackMessage,
  FeedbackThread
} from '@slayzone/feedback/shared'

// Pure DB ops shared by the IPC handlers (electron/handlers.ts) and the tRPC
// `app.feedback` router (via setAppDeps). Both transports delegate here
// (coexistence until slice 5). Promise-typed — SlayzoneDb is async (worker_thread).
export function buildFeedbackOps(db: SlayzoneDb) {
  return {
    listThreads: (): Promise<FeedbackThread[]> =>
      db
        .prepare(
          'SELECT id, title, discord_thread_id, created_at FROM feedback_threads ORDER BY created_at DESC'
        )
        .all<FeedbackThread>(),
    createThread: async (input: CreateFeedbackThreadInput): Promise<void> => {
      await db
        .prepare('INSERT INTO feedback_threads (id, title, discord_thread_id) VALUES (?, ?, ?)')
        .run(input.id, input.title, input.discord_thread_id)
    },
    getMessages: (threadId: string): Promise<FeedbackMessage[]> =>
      db
        .prepare(
          'SELECT id, thread_id, content, created_at FROM feedback_messages WHERE thread_id = ? ORDER BY created_at ASC'
        )
        .all<FeedbackMessage>(threadId),
    addMessage: async (input: AddFeedbackMessageInput): Promise<void> => {
      await db
        .prepare('INSERT INTO feedback_messages (id, thread_id, content) VALUES (?, ?, ?)')
        .run(input.id, input.thread_id, input.content)
    },
    updateThreadDiscordId: async (threadId: string, discordThreadId: string): Promise<void> => {
      await db
        .prepare('UPDATE feedback_threads SET discord_thread_id = ? WHERE id = ?')
        .run(discordThreadId, threadId)
    },
    deleteThread: async (threadId: string): Promise<void> => {
      await db.prepare('DELETE FROM feedback_threads WHERE id = ?').run(threadId)
    }
  }
}

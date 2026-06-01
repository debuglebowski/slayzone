import type { IpcMain } from 'electron'
import type { SlayzoneDb } from '@slayzone/platform'
import type { AddFeedbackMessageInput, CreateFeedbackThreadInput } from '@slayzone/feedback/shared'

export function registerFeedbackHandlers(ipcMain: IpcMain, db: SlayzoneDb): void {
  ipcMain.handle('db:feedback:listThreads', async () => {
    return await db
      .prepare(
        'SELECT id, title, discord_thread_id, created_at FROM feedback_threads ORDER BY created_at DESC'
      )
      .all()
  })
  ipcMain.handle('db:feedback:createThread', async (_, input: CreateFeedbackThreadInput) => {
    await db
      .prepare('INSERT INTO feedback_threads (id, title, discord_thread_id) VALUES (?, ?, ?)')
      .run(input.id, input.title, input.discord_thread_id)
  })
  ipcMain.handle('db:feedback:getMessages', async (_, threadId: string) => {
    return await db
      .prepare(
        'SELECT id, thread_id, content, created_at FROM feedback_messages WHERE thread_id = ? ORDER BY created_at ASC'
      )
      .all(threadId)
  })
  ipcMain.handle('db:feedback:addMessage', async (_, input: AddFeedbackMessageInput) => {
    await db
      .prepare('INSERT INTO feedback_messages (id, thread_id, content) VALUES (?, ?, ?)')
      .run(input.id, input.thread_id, input.content)
  })
  ipcMain.handle(
    'db:feedback:updateThreadDiscordId',
    async (_, threadId: string, discordThreadId: string) => {
      await db
        .prepare('UPDATE feedback_threads SET discord_thread_id = ? WHERE id = ?')
        .run(discordThreadId, threadId)
    }
  )
  ipcMain.handle('db:feedback:deleteThread', async (_, threadId: string) => {
    await db.prepare('DELETE FROM feedback_threads WHERE id = ?').run(threadId)
  })
}

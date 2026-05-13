import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import type {
  AddFeedbackMessageInput,
  CreateFeedbackThreadInput,
} from '@slayzone/feedback/shared'

export function registerFeedbackHandlers(ipcMain: IpcMain, db: Database): void {
  ipcMain.handle('db:feedback:listThreads', () => {
    return db.prepare('SELECT id, title, discord_thread_id, created_at FROM feedback_threads ORDER BY created_at DESC').all()
  })
  ipcMain.handle('db:feedback:createThread', (_, input: CreateFeedbackThreadInput) => {
    db.prepare('INSERT INTO feedback_threads (id, title, discord_thread_id) VALUES (?, ?, ?)').run(input.id, input.title, input.discord_thread_id)
  })
  ipcMain.handle('db:feedback:getMessages', (_, threadId: string) => {
    return db.prepare('SELECT id, thread_id, content, created_at FROM feedback_messages WHERE thread_id = ? ORDER BY created_at ASC').all(threadId)
  })
  ipcMain.handle('db:feedback:addMessage', (_, input: AddFeedbackMessageInput) => {
    db.prepare('INSERT INTO feedback_messages (id, thread_id, content) VALUES (?, ?, ?)').run(input.id, input.thread_id, input.content)
  })
  ipcMain.handle('db:feedback:updateThreadDiscordId', (_, threadId: string, discordThreadId: string) => {
    db.prepare('UPDATE feedback_threads SET discord_thread_id = ? WHERE id = ?').run(discordThreadId, threadId)
  })
  ipcMain.handle('db:feedback:deleteThread', (_, threadId: string) => {
    db.prepare('DELETE FROM feedback_threads WHERE id = ?').run(threadId)
  })
}

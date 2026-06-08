import type { IpcMain } from 'electron'
import type { SlayzoneDb } from '@slayzone/platform'
import type {
  AddFeedbackMessageInput,
  CreateFeedbackThreadInput
} from '@slayzone/feedback/shared'
import { buildFeedbackOps } from '../server/feedback-store'

export function registerFeedbackHandlers(
  ipcMain: IpcMain,
  db: SlayzoneDb
): ReturnType<typeof buildFeedbackOps> {
  const ops = buildFeedbackOps(db)
  ipcMain.handle('db:feedback:listThreads', () => ops.listThreads())
  ipcMain.handle('db:feedback:createThread', (_, input: CreateFeedbackThreadInput) =>
    ops.createThread(input)
  )
  ipcMain.handle('db:feedback:getMessages', (_, threadId: string) => ops.getMessages(threadId))
  ipcMain.handle('db:feedback:addMessage', (_, input: AddFeedbackMessageInput) =>
    ops.addMessage(input)
  )
  ipcMain.handle(
    'db:feedback:updateThreadDiscordId',
    (_, threadId: string, discordThreadId: string) =>
      ops.updateThreadDiscordId(threadId, discordThreadId)
  )
  ipcMain.handle('db:feedback:deleteThread', (_, threadId: string) => ops.deleteThread(threadId))
  // Return the ops so the host shares ONE instance with setAppDeps.
  return ops
}

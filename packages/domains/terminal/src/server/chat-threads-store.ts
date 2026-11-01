import type { SlayzoneDb } from '@slayzone/platform'
import type { ChatThread } from '@slayzone/terminal-contracts'

const columns = `id, parent_tab_id AS parentTabId, task_id AS taskId, mode,
  parent_conversation_id AS parentConversationId, answer_id AS answerId,
  source_message_id AS sourceMessageId, source_uuid AS sourceUuid, title,
  conversation_id AS conversationId, created_at AS createdAt`

export function createChatThreadStore(db: SlayzoneDb) {
  return {
    listForParent: (parentTabId: string) =>
      db.all<ChatThread>(
        `SELECT ${columns} FROM chat_threads WHERE parent_tab_id = ? ORDER BY created_at, id`,
        [parentTabId]
      ),
    get: (id: string) =>
      db.get<ChatThread>(`SELECT ${columns} FROM chat_threads WHERE id = ?`, [id]),
    list: (parentTabId: string, conversationId: string) =>
      db.all<ChatThread>(
        `SELECT ${columns} FROM chat_threads WHERE parent_tab_id = ? AND parent_conversation_id = ? ORDER BY created_at, id`,
        [parentTabId, conversationId]
      ),
    create: async (thread: ChatThread): Promise<void> => {
      // Child tabs use the ordinary event/draft/queue lifecycle but are hidden
      // from the terminal tab bar. Both rows must exist, or neither does.
      await db.batchTxn([
        {
          type: 'run',
          sql: `INSERT INTO terminal_tabs (id, task_id, label, mode, position, group_id, created_at) VALUES (?, ?, ?, ?, -1, ?, ?)`,
          params: [
            thread.id,
            thread.taskId,
            thread.title,
            thread.mode,
            thread.id,
            new Date(thread.createdAt).toISOString()
          ]
        },
        {
          type: 'run',
          sql: `INSERT INTO chat_threads (id, parent_tab_id, task_id, mode, parent_conversation_id, answer_id, source_message_id, source_uuid, title, conversation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            thread.id,
            thread.parentTabId,
            thread.taskId,
            thread.mode,
            thread.parentConversationId,
            thread.answerId,
            thread.sourceMessageId,
            thread.sourceUuid,
            thread.title,
            thread.conversationId,
            thread.createdAt
          ]
        }
      ])
    },
    setConversation: async (id: string, conversationId: string | null): Promise<void> => {
      await db.run('UPDATE chat_threads SET conversation_id = ? WHERE id = ?', [conversationId, id])
    }
  }
}

export type ChatThreadStore = ReturnType<typeof createChatThreadStore>

/** A durable side discussion forked through one answer in a parent conversation. */
export interface ChatThread {
  id: string
  parentTabId: string
  taskId: string
  mode: string
  parentConversationId: string
  answerId: string
  sourceMessageId: string
  sourceUuid: string
  title: string
  conversationId: string | null
  /** When it was closed (resolved): hidden from the thread tabs, its agent stopped,
   * reopenable with its history. null = open. */
  closedAt: number | null
  createdAt: number
}

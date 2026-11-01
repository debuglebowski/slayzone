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
  createdAt: number
}

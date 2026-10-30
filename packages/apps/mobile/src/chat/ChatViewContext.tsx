/**
 * What the timeline's rows need from the chat they belong to, without threading props
 * through the list: the tab (a running command's output is read by it), retry of a
 * failed message, the agent's questions (a question or plan card shows how it was
 * answered), and the ways out of an agent that could not start (start it again; continue
 * here a conversation the terminal runs). Provided by `ChatView`.
 */
import type { ChatPrompt } from '@slayzone/terminal/chat-prompts'
import { createContext, useContext } from 'react'

export interface ChatViewValue {
  tabId: string
  retryMessage: (id: string) => void
  prompts: readonly ChatPrompt[]
  /** Start the agent again (`chat.start`). */
  restartAgent: () => void
  /** The terminal runs this conversation: stop it there, continue here (`chat.takeOver`). */
  takeOver: () => void
}

export const ChatViewContext = createContext<ChatViewValue | null>(null)

export function useChatView(): ChatViewValue {
  const value = useContext(ChatViewContext)
  if (!value) throw new Error('useChatView must be used within ChatViewContext')
  return value
}

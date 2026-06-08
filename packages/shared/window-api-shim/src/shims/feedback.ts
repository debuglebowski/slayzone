// cap-shell-6 — window.api.feedback shim. Routes through JsonRpcHost to
// sidecar `feedback:*` handlers so threads + messages persist across
// sessions. FeedbackDialog already submits feedback externally via Convex;
// the sidecar persistence is the local audit trail.

import { jsonRpcCall } from '../transport/mojo'

interface FeedbackThread {
  id: string
  title: string
  discord_thread_id: string | null
  created_at: string
}

interface FeedbackMessage {
  id: string
  thread_id: string
  content: string
  created_at: string
}

interface CreateThreadInput {
  id: string
  title: string
  discord_thread_id: string | null
}

interface AddMessageInput {
  id: string
  thread_id: string
  content: string
}

export const feedbackShim = {
  listThreads: (): Promise<FeedbackThread[]> =>
    jsonRpcCall<FeedbackThread[]>('feedback:listThreads', {}).catch(() => []),

  getMessages: (threadId: string): Promise<FeedbackMessage[]> =>
    jsonRpcCall<FeedbackMessage[]>('feedback:getMessages', { params: [threadId] }).catch(() => []),

  createThread: (input: CreateThreadInput): Promise<FeedbackThread> =>
    jsonRpcCall<FeedbackThread>('feedback:createThread', input),

  addMessage: (input: AddMessageInput): Promise<FeedbackMessage> =>
    jsonRpcCall<FeedbackMessage>('feedback:addMessage', input),

  deleteThread: async (id: string): Promise<void> => {
    await jsonRpcCall('feedback:deleteThread', { params: [id] })
  },

  updateThreadDiscordId: async (id: string, discordThreadId: string): Promise<void> => {
    await jsonRpcCall('feedback:updateThreadDiscordId', { params: [id, discordThreadId] })
  },
}

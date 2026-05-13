export interface FeedbackThread {
  id: string
  title: string
  discord_thread_id: string | null
  created_at: string
}

export interface FeedbackMessage {
  id: string
  thread_id: string
  content: string
  created_at: string
}

export interface CreateFeedbackThreadInput {
  id: string
  title: string
  discord_thread_id: string | null
}

export interface AddFeedbackMessageInput {
  id: string
  thread_id: string
  content: string
}

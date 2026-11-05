/**
 * A chat timeline row the user pinned to come back to: a user message or an
 * assistant answer of one conversation. Durable with the conversation's other
 * content (computer-side chat storage); the list renders from `excerpt`
 * without loading the row.
 */
export interface ChatPinnedMessage {
  /** Provider conversation the row belongs to (Reset / a new session hides its pins). */
  conversationId: string
  /** The row's timeline key (`user-text:<id>`, `text:<messageId>[:<block>]`): what "go to" reveals. */
  key: string
  target: 'user' | 'answer'
  /** The user message's id, or the answer's assistant message id. */
  messageId: string
  /** The row's index in the timeline when pinned: paged history loads its page to reveal it. */
  row?: number
  /** The row's first line, at most `PINNED_MESSAGE_EXCERPT_MAX` characters. */
  excerpt: string
  pinnedAt: number
}

/** What the client sends to pin a row (the server stamps `pinnedAt`). */
export type ChatPinnedMessageInput = Omit<ChatPinnedMessage, 'pinnedAt'>

export const PINNED_MESSAGE_EXCERPT_MAX = 120
export const PINNED_MESSAGE_KEY_MAX = 500

/** A row's text → its excerpt: the first non-blank line, markdown markers dropped, capped. */
export function pinnedMessageExcerpt(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) =>
        l
          .trim()
          .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
          .trim()
      )
      .find((l) => l.length > 0 && !/^(`{3,}|~{3,}|-{3,}|\*{3,})/.test(l)) ?? ''
  return line.length > PINNED_MESSAGE_EXCERPT_MAX
    ? `${line.slice(0, PINNED_MESSAGE_EXCERPT_MAX - 1)}…`
    : line
}

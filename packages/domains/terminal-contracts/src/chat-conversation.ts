/**
 * Conversation control shapes shared by the chat transport and the chat UI
 * (chat A, plan 3.3): rewind / edit & resend and their file dry run.
 *
 * @module shared/chat-conversation
 */
import type { UserContentBlock } from './agent-events'

/**
 * What Stop / Esc did (`chat.abortAndPop`). A turn with no output yet gives its
 * message back — all of it: `id` and `content` (text and attachment blocks), so
 * the composer restores what was sent; `text` is its plain text. Nothing popped:
 * all three are null.
 */
export interface StopResult {
  popped: boolean
  text: string | null
  id: string | null
  content: UserContentBlock[] | null
}

/**
 * Which side of a past user message a rewind keeps: `before` (edit & resend —
 * the message and everything after it go), `after` (rewind to here — the
 * message and its answer stay, everything after goes).
 */
export type RewindScope = 'before' | 'after'

/** A dry run of restoring the files: what it would change. */
export interface RewindFilesPreview {
  canRewind: boolean
  filesChanged: string[]
  insertions: number
  deletions: number
  /** Why the files can't be restored (no checkpoint, checkpointing off, …). */
  error?: string
}

export interface RewindResult {
  /** Edit & resend: the message's text, to edit and send again. */
  prefillText: string | null
  /** Files asked for: restored (and which), or why not. */
  files: { restored: boolean; filesChanged: string[]; error?: string } | null
}

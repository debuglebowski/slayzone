/**
 * A chat tab's composer state, kept server-side per tab (plan item 4.2,
 * "nothing to retype"): the draft being written — text and attached files —
 * and where the timeline was scrolled. Restored after a remount (switching the
 * tab group, hiding the panel) and after a reload.
 *
 * @module shared/chat-tab-state
 */
import type { ChatAttachment } from './chat-attachments'

export interface ChatDraft {
  text: string
  attachments: ChatAttachment[]
}

/**
 * Where the timeline was scrolled: at the bottom (following new output), or
 * `offsetPx` below the top of the row with this stable key.
 */
export type ChatScrollAnchor =
  | { atBottom: true }
  | {
      atBottom: false
      key: string
      offsetPx: number
      /** The row's index in the timeline: a paged history loads its page to restore. */
      row?: number
    }

export interface ChatTabState {
  /** `rev` counts saves (the composer's local journal compares it). */
  draft: ChatDraft & { rev: number }
  scroll: ChatScrollAnchor | null
}

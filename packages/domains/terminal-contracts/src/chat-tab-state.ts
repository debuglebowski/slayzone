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
  /** Storage binding used to fence delayed saves after provider switches. */
  ownership?: { id: string; epoch: number }
}

export interface ChatTabStateScope {
  expectedMode?: string
  expectedOwnership?: { id: string; epoch: number }
}

export function assertChatTabStateScope(
  identity: { id: string; epoch: number; mode: string },
  scope?: ChatTabStateScope
): void {
  if (scope?.expectedMode !== undefined && scope.expectedMode !== identity.mode)
    throw new Error('Chat provider changed. Reopen this chat before continuing.')
  if (
    scope?.expectedOwnership &&
    (scope.expectedOwnership.id !== identity.id || scope.expectedOwnership.epoch !== identity.epoch)
  )
    throw new Error('Chat ownership changed. Reopen this chat before saving.')
}

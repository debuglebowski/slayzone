import type { TimelineItem, TimelinePageSummary } from '@slayzone/terminal/client'
import {
  pinnedMessageExcerpt,
  type ChatPinnedMessage,
  type ChatPinnedMessageInput
} from '@slayzone/terminal-contracts'
import { itemKeyOf } from './timeline-item-key'

/** What a row pins as (the conversation and row are the panel's). */
export type PinnableRow = Omit<ChatPinnedMessageInput, 'conversationId' | 'row'>

/**
 * A timeline row the user can pin: a user message that carries an id, or a
 * finished assistant answer — of the main conversation (not a sub-agent's).
 * Null for anything else. The key is the row's timeline key: what "go to" reveals.
 */
export function pinnableRow(item: TimelineItem): PinnableRow | null {
  if (item.parentToolUseId != null) return null
  if (item.kind === 'user-text') {
    if (!item.id) return null
    const files = (item.attachments ?? []).map((a) => a.name).filter(Boolean)
    return {
      key: String(itemKeyOf(item, 0)),
      target: 'user',
      messageId: item.id,
      excerpt: pinnedMessageExcerpt(item.text) || pinnedMessageExcerpt(files.join(', '))
    }
  }
  if (item.kind === 'text' && item.role === 'assistant' && item.stream === undefined) {
    return {
      key: String(itemKeyOf(item, 0)),
      target: 'answer',
      messageId: item.messageId,
      excerpt: pinnedMessageExcerpt(item.text)
    }
  }
  return null
}

/**
 * Where a pin's row is: in the conversation, or in the rows a rewind / fork /
 * switch folded away (`inBranch` = the fold's id, to open it).
 */
export function pinPlace(
  pin: ChatPinnedMessage,
  conversationFolded: ReadonlySet<number>,
  branches: TimelinePageSummary['branches']
): { inBranch: string | null } {
  if (pin.row === undefined || !conversationFolded.has(pin.row)) return { inBranch: null }
  // The innermost fold holding the row: the one whose rows start last.
  let found: TimelinePageSummary['branches'][number] | null = null
  for (const b of branches) {
    const { hiddenFrom, hiddenCount } = b.item
    if (pin.row >= hiddenFrom && pin.row < hiddenFrom + hiddenCount) {
      if (!found || hiddenFrom > found.item.hiddenFrom) found = b
    }
  }
  return { inBranch: found?.item.id ?? null }
}

/**
 * The pin "previous / next pinned" goes to from the row at the top of the view
 * (`topRow`): next = the first pin below it, previous = the last above it.
 * Null at either end. Pins without a row are not on the way.
 */
export function pinnedMessageToJumpTo(
  pins: readonly ChatPinnedMessage[],
  topRow: number,
  dir: -1 | 1
): ChatPinnedMessage | null {
  const placed = pins
    .filter((p): p is ChatPinnedMessage & { row: number } => p.row !== undefined)
    .sort((a, b) => a.row - b.row)
  if (dir === 1) return placed.find((p) => p.row > topRow) ?? null
  return placed.findLast((p) => p.row < topRow) ?? null
}

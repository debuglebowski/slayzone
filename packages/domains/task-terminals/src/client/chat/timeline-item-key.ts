import { stableAnchorKey } from '@slayzone/terminal/chat-presentation'
import type { TimelineItem } from '@slayzone/terminal/client'

/**
 * A displayed row's key: from ids it carries, else by its timeline index.
 * Keep the user-message key used by existing pins.
 */
export function itemKeyOf(item: TimelineItem, row: number): string {
  if (item.kind === 'session-start') return `session:${item.sessionId}`
  if (item.kind === 'conversation-branch') return item.id
  if (item.kind === 'user-text' && item.id) return `user-text:${item.id}`
  if (item.kind === 'result') return `result:${item.timestamp}:${row}`
  if (item.kind === 'history-gap') return `gap:${item.from}-${item.to}`
  return stableAnchorKey(item) ?? `${item.kind}:${row}`
}

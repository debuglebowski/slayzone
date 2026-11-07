import type { Key } from 'react'
import { streamKeyOf, type TimelineItem } from '@slayzone/terminal/client'

/**
 * A displayed row's key: from ids it carries, else by its index in the
 * timeline (`row`) — never its display position, which shifts as rows load.
 */
export function itemKeyOf(item: TimelineItem, row: number): Key {
  const streamKey = streamKeyOf(item)
  if (streamKey) return streamKey
  if (item.kind === 'text' || item.kind === 'thinking') return `${item.kind}:${item.messageId}`
  if (item.kind === 'session-start') return `session:${item.sessionId}`
  if (item.kind === 'codex-plan') return `codex-plan:${item.planId}`
  if (item.kind === 'conversation-branch') return item.id
  if (item.kind === 'user-text' && item.id) return `user-text:${item.id}`
  if (item.kind === 'result') return `result:${item.timestamp}:${row}`
  if (item.kind === 'hook' && item.hookId) return `hook:${item.hookId}`
  // By its Task call: the files-changed panel reveals a sub-agent's edits.
  if (item.kind === 'sub-agent') return `sub-agent:${item.toolUseId}`
  if (item.kind === 'notice' && item.id) return `notice:${item.id}`
  if (item.kind === 'files-changed' || item.kind === 'workspace-changes') return item.id
  // Its range: loading part of it makes it another placeholder.
  if (item.kind === 'history-gap') return `gap:${item.from}-${item.to}`
  return `${item.kind}:${row}`
}

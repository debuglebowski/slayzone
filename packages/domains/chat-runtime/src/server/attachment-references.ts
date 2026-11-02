import {
  userMessageAttachments,
  type AgentEvent,
  type ChatAttachment,
  type ChatTabState,
  type QueuedChatMessage
} from '@slayzone/terminal-contracts'
import type { ChatRecord } from '../shared'

/** Only normalized user-content containers own attachment references. Tool
 * payloads may contain arbitrary similarly shaped objects and are opaque here. */
export function eventAttachmentReferences(event: AgentEvent): ChatAttachment[] {
  return event.kind === 'user-message' ? userMessageAttachments(event.content ?? []) : []
}

export function recordAttachmentReferences(
  record: Pick<ChatRecord, 'kind' | 'id' | 'value'>
): ChatAttachment[] {
  if (record.kind === 'draft') return (record.value as ChatTabState).draft?.attachments ?? []
  if (record.kind === 'queue')
    return userMessageAttachments((record.value as QueuedChatMessage).content ?? [])
  if (record.kind === 'settings' && record.id.startsWith('attachment-message:'))
    return record.value as ChatAttachment[]
  return []
}

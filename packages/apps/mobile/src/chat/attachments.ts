/**
 * Files attached to a chat message (desktop attaches them; the phone shows them, sends
 * them again with a retry, and keeps them when Stop gives a message back). A message
 * carries REFERENCES to task artifacts (`ChatAttachment`); the hub reads the bytes.
 */
import {
  type ChatAttachment,
  formatAttachmentSize,
  type QueuedChatMessage,
  type UserContentBlock,
  userMessageAttachments
} from '@slayzone/terminal-contracts'

const KIND_WORDS: Record<ChatAttachment['kind'], string> = {
  image: 'image',
  pdf: 'PDF',
  text: 'text file'
}

/** A message's blocks as desktop sends them: the files first, then the text (when any). */
export function messageContent(text: string, files: readonly ChatAttachment[]): UserContentBlock[] {
  return [
    ...files.map((attachment) => ({ type: 'attachment' as const, attachment })),
    ...(text ? [{ type: 'text' as const, text }] : [])
  ]
}

/** What a file chip says to VoiceOver: kind, name and size. */
export function attachmentLabel(file: ChatAttachment): string {
  return `Attached ${KIND_WORDS[file.kind]} ${file.name}, ${formatAttachmentSize(file.size)}`
}

/** A queued message as the queue shows it: its text, else the names of its files. */
export function queuedLabel(item: QueuedChatMessage): string {
  if (item.original) return item.original
  return userMessageAttachments(item.content ?? [])
    .map((f) => f.name)
    .join(', ')
}

/** The files of a queued message (none on rows queued before files existed). */
export function queuedFiles(item: QueuedChatMessage): ChatAttachment[] {
  return userMessageAttachments(item.content ?? [])
}

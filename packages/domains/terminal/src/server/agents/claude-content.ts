/**
 * A user message's content, as Claude Code takes it on stdin. Attached files
 * are references (task artifacts) until here: their bytes are read now, at
 * write time, and checked again by content (a client's word for what a file is
 * never reaches the API).
 *
 * Order matters: Claude Code reads the LAST text block as what the user typed
 * — a `/command` there runs, while one before an image goes to the model as
 * plain text (verified on Claude Code 2.1.312). So attachments go first, text
 * last, whatever order the message lists them in.
 *
 * @module terminal/server/agents/claude-content
 */
import {
  attachmentSizeError,
  sniffAttachment,
  type ChatAttachment,
  type UserContentBlock
} from '@slayzone/terminal-contracts'
import type { WireUserContentBlock } from './types'

import { readAttachment, type ChatAttachmentReader } from './chat-attachment-reader'

async function toWireBlock(
  a: ChatAttachment,
  reader: ChatAttachmentReader
): Promise<WireUserContentBlock> {
  const bytes = await readAttachment(a, reader)
  const sniff = sniffAttachment(bytes, a.name)
  if (sniff.kind === 'unsupported') throw new Error(sniff.reason)
  const tooBig = attachmentSizeError(sniff.kind, a.name, bytes.length)
  if (tooBig) throw new Error(tooBig)
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  switch (sniff.kind) {
    case 'image':
      return {
        type: 'image',
        source: { type: 'base64', media_type: sniff.mediaType, data: buf.toString('base64') }
      }
    case 'pdf':
      return {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') },
        title: a.name
      }
    case 'text':
      return {
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: buf.toString('utf8') },
        title: a.name
      }
  }
}

/** The wire blocks for a message: attachments (read now), then its text. */
export async function buildClaudeContent(
  content: ReadonlyArray<UserContentBlock>,
  reader: ChatAttachmentReader | undefined
): Promise<WireUserContentBlock[]> {
  const files: ChatAttachment[] = []
  const texts: WireUserContentBlock[] = []
  for (const block of content) {
    if (block.type === 'attachment') files.push(block.attachment)
    else texts.push({ type: 'text', text: block.text })
  }
  if (files.length > 0 && !reader) {
    throw new Error('This hub cannot read attached files. Send the message without them.')
  }
  // Read one file at a time: a message's files can add up to many MB.
  const attached: WireUserContentBlock[] = []
  for (const file of files) attached.push(await toWireBlock(file, reader as ChatAttachmentReader))
  return [...attached, ...texts]
}

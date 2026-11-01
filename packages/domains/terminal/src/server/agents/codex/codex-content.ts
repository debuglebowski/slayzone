import {
  attachmentSizeError,
  sniffAttachment,
  type UserContentBlock
} from '@slayzone/terminal-contracts'
import { readAttachment, type ChatAttachmentReader } from '../chat-attachment-reader'
import type { CodexUserInput } from './codex-protocol'

/** Build native inputs at write time; paths on the hub need not exist on the agent's computer. */
export async function buildCodexContent(
  content: readonly UserContentBlock[],
  reader: ChatAttachmentReader | undefined
): Promise<CodexUserInput[]> {
  const input: CodexUserInput[] = []
  for (const block of content) {
    if (block.type === 'text') {
      input.push({ type: 'text', text: block.text, text_elements: [] })
      continue
    }
    const file = block.attachment
    if (!reader)
      throw new Error('This hub cannot read attached files. Send the message without them.')
    const bytes = await readAttachment(file, reader)
    const sniff = sniffAttachment(bytes, file.name)
    if (sniff.kind !== 'image') throw new Error(`${file.name} is not a supported image.`)
    const tooBig = attachmentSizeError('image', file.name, bytes.length)
    if (tooBig) throw new Error(tooBig)
    input.push({
      type: 'image',
      url: `data:${sniff.mediaType};base64,${Buffer.from(bytes).toString('base64')}`
    })
  }
  return input
}

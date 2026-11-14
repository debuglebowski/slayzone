/**
 * Where an image a tool returned comes from: inline base64 (a data URL), or a
 * reference to bytes the computer stores out-of-line (`chat-blobs`), loaded when
 * shown (`chat-images.tsx`). Pure: shared by the parsers and the cards.
 *
 * @module task-terminals/chat/tool-cards/image-source
 */
import { isChatBlobRef, type ChatBlobRefBody } from '@slayzone/terminal-contracts'

export type ChatImageSource = { src: string; ref?: never } | { ref: ChatBlobRefBody; src?: never }

/** The image a base64 slot holds (`data`), else null. */
export function chatImageSource(data: unknown, mediaType: string): ChatImageSource | null {
  if (typeof data === 'string') return { src: `data:${mediaType};base64,${data}` }
  if (isChatBlobRef(data)) return { ref: data.$chatBlob }
  return null
}

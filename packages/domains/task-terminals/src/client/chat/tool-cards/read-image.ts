import { mcpResultBlocks } from './mcp'
import { chatImageSource, type ChatImageSource } from './image-source'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The image a `Read` of an image file returned (inline, or a stored reference),
 * else null. Claude Code sends it twice: an `image` block in the tool result (what
 * the model saw) and `toolUseResult.file.{base64,type}`. Either one is enough.
 */
export function readImageSource(rawContent: unknown, structured: unknown): ChatImageSource | null {
  for (const block of mcpResultBlocks(rawContent)) {
    if (block.kind === 'image')
      return block.src !== undefined ? { src: block.src } : { ref: block.ref }
  }
  if (isRecord(structured) && structured.type === 'image' && isRecord(structured.file)) {
    const { base64, type } = structured.file
    if (typeof type === 'string') return chatImageSource(base64, type)
  }
  return null
}

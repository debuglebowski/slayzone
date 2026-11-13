import { mcpResultBlocks } from './mcp'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The image a `Read` of an image file returned, as a data URL, else null.
 * Claude Code sends it twice: an `image` block in the tool result (what the
 * model saw) and `toolUseResult.file.{base64,type}`. Either one is enough.
 */
export function readImageSrc(rawContent: unknown, structured: unknown): string | null {
  for (const block of mcpResultBlocks(rawContent)) {
    if (block.kind === 'image') return block.src
  }
  if (isRecord(structured) && structured.type === 'image' && isRecord(structured.file)) {
    const { base64, type } = structured.file
    if (typeof base64 === 'string' && typeof type === 'string') {
      return `data:${type};base64,${base64}`
    }
  }
  return null
}
